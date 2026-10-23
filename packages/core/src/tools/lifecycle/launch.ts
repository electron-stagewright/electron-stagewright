/**
 * `electron_launch` — spawn an Electron app and register the resulting session.
 *
 * Runs fail-fast preflight checks (entry/binary exist and are absolute) before
 * touching a transport, enforces a single-instance guard by default, selects a
 * launch-capable transport from the registry, and returns the new session id
 * plus its initial window list so the agent need not immediately call
 * `electron_windows_list`.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { z } from 'zod'

import { makeError, makeSuccess } from '../../errors/envelope.js'
import { StagewrightError } from '../../errors/registry.js'
import { withProgressPhases } from '../../server/progress.js'
import {
  resolveProjectElectron,
  type ProjectElectronResolution,
} from '../../runtime/project-electron.js'
import {
  inspectElectronLaunchFuses,
  type ElectronLaunchFuseInspection,
} from '../../runtime/electron-fuses.js'
import type { LaunchOptions } from '../../transports/index.js'
import { isWithinRoot } from '../app-root.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { diagnoseLaunchError } from './diagnose.js'
import { awaitRendererReady, DEFAULT_READY_TIMEOUT_MS, MAX_READY_TIMEOUT_MS } from './ready.js'
import { registerWithWindows } from './session-init.js'

/**
 * Upper bound on concurrently-live sessions. Each launch spawns a real Electron process tree
 * (a parent plus heavyweight Chromium children), so without a cap a client looping
 * `electron_launch({ allowMultiple: true })` could exhaust host memory/PIDs. The limit is
 * deliberately generous — far above any realistic driving workload on a single server — so it
 * only ever stops a runaway loop, never a legitimate use.
 */
const MAX_CONCURRENT_SESSIONS = 16

/**
 * Environment variables the agent must not set on the spawned process. The `env` arg is hostile
 * tool input, and these keys reprogram the runtime loader/interpreter — turning "launch my Electron
 * app" into arbitrary host code execution OUTSIDE the renderer/main sandbox:
 * `ELECTRON_RUN_AS_NODE` makes the Electron binary run as a bare Node interpreter; `NODE_OPTIONS`
 * (and `NODE_REPL_EXTERNAL_MODULE`) force-load a module at startup; `LD_*` / `DYLD_*` inject native
 * libraries. A launch that legitimately drives the developer's app never needs them, so a request
 * setting one is refused with `BAD_ARGUMENT` rather than silently stripped.
 */
const DENIED_ENV_KEYS: ReadonlySet<string> = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
])

/** Whether an agent-supplied env key reprograms the loader/interpreter and must be refused. */
function isDeniedEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  return DENIED_ENV_KEYS.has(upper) || upper.startsWith('LD_') || upper.startsWith('DYLD_')
}

const inputSchema = z.object({
  main: z
    .string()
    .optional()
    .describe(
      'Absolute path to the app main-process JS entry. Required unless executablePath is given or the server configured a default demo entry.',
    ),
  executablePath: z
    .string()
    .optional()
    .describe('Absolute path to an Electron/app binary. Defaults to the bundled Electron.'),
  runtime: z
    .enum(['project'])
    .optional()
    .describe(
      'Use Electron resolved from the operator-configured --app-root. Resolving that runtime requires main; an explicit executablePath takes precedence. Default: the launch transport runtime.',
    ),
  args: z.array(z.string()).optional().describe('Extra CLI args appended after the entry.'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Environment variables for the spawned process.'),
  cwd: z.string().optional().describe('Working directory for the spawned process.'),
  timeoutMs: z.number().int().positive().optional().describe('Max wait for the first window.'),
  credentialStore: z
    .enum(['testing', 'system'])
    .optional()
    .describe(
      'Packaged executable only. Default "testing" avoids blocking credential prompts with --use-mock-keychain on macOS or --password-store=basic on Linux. Use "system" to verify genuine safeStorage behavior.',
    ),
  readyTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_READY_TIMEOUT_MS)
    .optional()
    .describe(
      `Max wait (ms) for the renderer DOM to finish its initial render before returning. Default 5000; 0 returns immediately with renderer_ready reflecting the instantaneous state. Capped at ${MAX_READY_TIMEOUT_MS} to stay under the dispatch timeout backstop.`,
    ),
  allowMultiple: z
    .boolean()
    .optional()
    .describe('Allow launching when a session already exists. Default false (single instance).'),
  instrumentNative: z
    .boolean()
    .optional()
    .describe(
      'Wrap the app main entry with fixed hooks installed before it runs, so startup Tray state is readable/invokable (native_trays / native_tray_invoke) and startup notifications can be captured with beforeArm. Off by default; runs no agent code. Requires main; executablePath-only launches cannot be instrumented. Launch transport only.',
    ),
})

const DESCRIPTION = [
  'Launch an Electron app and start a driving session. Provide main (absolute path to the',
  'main-process entry) or executablePath. Set runtime:"project" to resolve Electron only from the',
  'operator-configured --app-root (requires main when resolving that runtime); explicit executablePath',
  'takes precedence. Executable-only launches are treated as packaged apps and use a transport-owned,',
  'loopback CDP endpoint; main-based development launches use Playwright. A server',
  'started with --demo supplies its packaged demo entry when both are omitted. Returns: { ok, session_id,',
  'transport, windows, renderer_ready, runtime_source, launch_mode, capabilities }.',
  'Packaged launches default credentialStore to "testing": macOS receives --use-mock-keychain and',
  'Linux receives --password-store=basic so OS credential prompts cannot wedge automation. Use',
  'credentialStore:"system" when assertions must verify genuine safeStorage sealing.',
  'Waits (up to readyTimeoutMs, default 5000) for the renderer DOM to finish its initial render, so a',
  'snapshot/find right after launch sees a populated app; renderer_ready:false means it was not confirmed',
  'in time (the session is still usable — retry the read, or wait_for_selector on an expected element).',
  'By default refuses a second launch while a session is live (pass allowMultiple: true to override).',
  'Errors: ALREADY_RUNNING (a session is live, or the concurrent-session cap is reached — stop one',
  'or pass allowMultiple; not retryable), ABSOLUTE_PATH_REQUIRED / FILE_NOT_FOUND (preflight; not',
  'retryable), BAD_ARGUMENT (neither main nor executablePath given; runtime:"project" without main',
  'when no executablePath is given, or without --app-root when resolving that runtime; a',
  'runtime-altering env var like NODE_OPTIONS; instrumentNative without main; or,',
  'when the server set --app-root, a main/executablePath/cwd outside that root),',
  'FUSES_BLOCK_LAUNCH (a main-based development launch selected a binary that disables the Node CLI',
  'inspect channel Playwright requires; not retryable — use executablePath without main for packaged',
  'CDP launch, attach over CDP, or use a compatible development build),',
  'ELECTRON_RUNTIME_MISSING (a main-based launch without executablePath found no downloaded Electron',
  'binary or no electron package for the server; not retryable — run install-electron with the',
  'server\'s npx --package list, pass executablePath, or use runtime:"project"),',
  'SINGLE_INSTANCE_LOCK (another app instance holds the lock; not retryable),',
  'LAUNCH_FAILED (the packaged app could not start or exited before a driveable renderer; not retryable),',
  'LAUNCH_TIMEOUT (first window did not appear; retryable), TRANSPORT_UNSUPPORTED (no launch-capable transport).',
].join(' ')

/** Dependency seams for {@link makeLaunchTool} — injected by tests. */
export interface LaunchToolDeps {
  /** Existence check for preflight. Defaults to `fs.existsSync`. */
  readonly fileExists?: (path: string) => boolean
  /** App-root Electron resolver. Injected by tests; defaults to the constrained filesystem resolver. */
  readonly resolveProjectElectron?: (appRoot: string) => Promise<ProjectElectronResolution>
  /** Read-only Electron fuse inspector. Injected by tests; failures/unknown states do not block. */
  readonly inspectElectronFuses?: (
    executablePath: string,
  ) => Promise<ElectronLaunchFuseInspection | undefined>
}

/** Throws a {@link StagewrightError} when a supplied path is relative or missing. */
function preflight(
  main: string | undefined,
  executablePath: string | undefined,
  fileExists: (path: string) => boolean,
): void {
  for (const [label, value] of [
    ['main', main],
    ['executablePath', executablePath],
  ] as const) {
    if (value === undefined) continue
    if (!isAbsolute(value)) {
      throw new StagewrightError(
        'ABSOLUTE_PATH_REQUIRED',
        `${label} must be an absolute path: ${value}`,
        {
          [label]: value,
        },
      )
    }
    if (!fileExists(value)) {
      throw new StagewrightError('FILE_NOT_FOUND', `${label} path does not exist: ${value}`, {
        [label]: value,
      })
    }
  }
}

/** Build {@link LaunchOptions} from validated args, honouring exactOptionalPropertyTypes. */
function toLaunchOptions(args: z.infer<typeof inputSchema>): LaunchOptions {
  return {
    ...(args.main !== undefined ? { appPath: args.main } : {}),
    ...(args.executablePath !== undefined ? { executablePath: args.executablePath } : {}),
    ...(args.args !== undefined ? { args: args.args } : {}),
    ...(args.env !== undefined ? { env: args.env } : {}),
    ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    ...(args.credentialStore !== undefined ? { credentialStore: args.credentialStore } : {}),
    ...(args.instrumentNative !== undefined ? { instrumentNative: args.instrumentNative } : {}),
  }
}

/**
 * Build the `electron_launch` tool. Exposed as a factory so tests inject a
 * deterministic file-existence check instead of touching the filesystem.
 */
export function makeLaunchTool(deps: LaunchToolDeps = {}): AnyToolDefinition {
  const fileExists = deps.fileExists ?? existsSync
  const resolveFromProject = deps.resolveProjectElectron ?? resolveProjectElectron
  const inspectFuses = deps.inspectElectronFuses ?? inspectElectronLaunchFuses
  return defineTool({
    name: 'electron_launch',
    title: 'Launch Electron app',
    description: DESCRIPTION,
    inputSchema,
    operationType: 'command',
    handler: async (args, ctx) =>
      withProgressPhases({ reporter: ctx.progress }, async (phase) => {
        phase('Validating launch configuration')
        const meta = { startedAt: ctx.startedAt, now: ctx.now }
        if (args.allowMultiple !== true && ctx.sessions.size > 0) {
          return makeError('ALREADY_RUNNING', {
            ...meta,
            next_actions: ['electron_stop()', 'electron_launch({ allowMultiple: true })'],
          })
        }
        // Hard cap on concurrent sessions — a backstop against an allowMultiple launch loop
        // exhausting the host. allowMultiple bypasses the single-instance guard above, but not this.
        if (ctx.sessions.size >= MAX_CONCURRENT_SESSIONS) {
          return makeError('ALREADY_RUNNING', {
            ...meta,
            message: `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached; stop a session before launching another.`,
            next_actions: ['electron_stop({ sessionId })'],
          })
        }
        if (
          args.runtime === 'project' &&
          args.main === undefined &&
          args.executablePath === undefined
        ) {
          return makeError('BAD_ARGUMENT', {
            ...meta,
            message: 'runtime:"project" requires main (the target app entry).',
            next_actions: [
              'electron_launch({ main: "/absolute/path/to/main.js", runtime: "project" })',
            ],
          })
        }

        // A configured default is only an ergonomic fallback for an otherwise empty default-runtime
        // launch. Explicit executables and project runtimes require the caller's app entry instead.
        const main =
          args.main ??
          (args.executablePath === undefined && args.runtime !== 'project'
            ? ctx.launchDefaultMain
            : undefined)
        let executablePath = args.executablePath
        // The app-root string preserves the operator's spelling for main/cwd input checks. Project
        // resolution also returns its canonical root so a legitimate macOS /var -> /private/var alias
        // does not make the canonical Electron binary appear to escape that same root.
        let resolvedProjectRoot: string | undefined
        let runtimeSource: 'default' | 'project' | 'explicit' =
          executablePath === undefined ? 'default' : 'explicit'
        if (executablePath === undefined && args.runtime === 'project') {
          phase('Resolving project Electron runtime')
          if (ctx.appRoot === undefined) {
            return makeError('BAD_ARGUMENT', {
              ...meta,
              message:
                'runtime:"project" requires the server to start with --app-root <project-root>.',
              next_actions: [
                'Restart the server with --app-root <project-root>, then retry the launch.',
              ],
            })
          }
          const resolution = await resolveFromProject(ctx.appRoot)
          if (!resolution.ok) {
            return makeError('BAD_ARGUMENT', {
              ...meta,
              message: resolution.message,
              details: { app_root: ctx.appRoot, runtime: 'project' },
              next_actions: ['Run electron_doctor to inspect the configured project runtime.'],
            })
          }
          ctx.signal?.throwIfAborted()
          executablePath = resolution.electron.executablePath
          resolvedProjectRoot = resolution.rootPath
          runtimeSource = 'project'
        }
        if (main === undefined && executablePath === undefined) {
          return makeError('BAD_ARGUMENT', {
            ...meta,
            message:
              'Provide main (the app entry) or executablePath, or start the server with --demo.',
          })
        }
        if (args.instrumentNative === true && main === undefined) {
          return makeError('BAD_ARGUMENT', {
            ...meta,
            message:
              'instrumentNative requires main (the app entry); executablePath-only launches cannot be wrapped with launch-time native instrumentation.',
          })
        }
        const packagedLaunch = main === undefined && executablePath !== undefined
        if (args.credentialStore !== undefined && !packagedLaunch) {
          return makeError('BAD_ARGUMENT', {
            ...meta,
            message:
              'credentialStore applies only to executable-only packaged launches; omit main or omit credentialStore.',
          })
        }
        if (args.env !== undefined) {
          const denied = Object.keys(args.env).filter(isDeniedEnvKey)
          if (denied.length > 0) {
            return makeError('BAD_ARGUMENT', {
              ...meta,
              message: `env may not set runtime-altering variables (${denied.join(', ')}); they can execute code outside the app sandbox and are refused.`,
              details: { denied_env_keys: denied },
            })
          }
        }
        // Preflight throws a registered error the dispatcher maps to an envelope.
        preflight(main, executablePath, fileExists)

        // When the operator configured --app-root, confine the launch surface to it: main and
        // executablePath both run code (a main.js as the Electron main process, or an arbitrary
        // binary), so an out-of-root path is how a hostile tool call would escape the project into
        // arbitrary host execution. cwd is confined too. Without --app-root, paths are unconstrained.
        if (ctx.appRoot !== undefined) {
          for (const [label, value] of [
            ['main', main],
            ['executablePath', executablePath],
            ['cwd', args.cwd],
          ] as const) {
            const boundary =
              label === 'executablePath' && resolvedProjectRoot !== undefined
                ? resolvedProjectRoot
                : ctx.appRoot
            if (value !== undefined && !isWithinRoot(boundary, value)) {
              return makeError('BAD_ARGUMENT', {
                ...meta,
                message: `${label} must resolve within the configured --app-root (${ctx.appRoot}); "${value}" is outside it.`,
                details: { app_root: ctx.appRoot, [label]: value },
              })
            }
          }
        }

        if (executablePath !== undefined && !packagedLaunch) {
          phase('Inspecting Electron launch compatibility')
          const fuses = await inspectFuses(executablePath)
          if (fuses?.blocks_playwright_launch === true) {
            return makeError('FUSES_BLOCK_LAUNCH', {
              ...meta,
              message:
                'Playwright Electron launch requires --inspect support, but the selected binary disables EnableNodeCliInspectArguments.',
              details: {
                executable_path: executablePath,
                fuses,
                required_channel: '--inspect=0',
              },
              next_actions: [
                'Call electron_launch({ executablePath }) without main to use the packaged CDP launch path.',
                'Start the app with --remote-debugging-port=<port>, then call electron_attach({ port: <port> }).',
                'Use a development Electron build with EnableNodeCliInspectArguments enabled, then retry electron_launch.',
              ],
            })
          }
        }

        ctx.signal?.throwIfAborted()
        const transport = packagedLaunch
          ? ctx.transports.requireById('cdp', 'canLaunch')
          : ctx.transports.requireCapability('canLaunch')
        let session
        try {
          phase('Launching Electron app')
          session = await transport.launch(
            toLaunchOptions({
              ...args,
              ...(main !== undefined ? { main } : {}),
              ...(executablePath !== undefined ? { executablePath } : {}),
            }),
          )
        } catch (err) {
          throw diagnoseLaunchError(err)
        }
        // Keep the session unpublished until preparation completes. Cancellation closes an
        // owned app even if its window/renderer probe never returns.
        phase('Registering Electron session')
        let renderer_ready = false
        const { managed, windows } = await registerWithWindows(
          ctx,
          transport,
          session,
          'stop',
          async () => {
            phase('Waiting for initial renderer')
            renderer_ready = await awaitRendererReady(
              session,
              args.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
              ctx.signal,
            )
          },
        )
        return makeSuccess(
          {
            session_id: managed.id,
            transport: transport.id,
            windows,
            renderer_ready,
            runtime_source: runtimeSource,
            launch_mode: packagedLaunch ? 'packaged' : 'development',
            capabilities: transport.capabilities,
          },
          { ...meta, session_id: managed.id },
        )
      }),
  })
}

/** The default `electron_launch` tool registered by the server. */
export const launchTool: AnyToolDefinition = makeLaunchTool()
