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
import type { LaunchOptions, TransportSession } from '../../transports/index.js'
import { isWithinRoot } from '../app-root.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { diagnoseLaunchError } from './diagnose.js'
import { registerWithWindows } from './session-init.js'

/** Default budget for the post-launch renderer-ready wait (ms). */
const DEFAULT_READY_TIMEOUT_MS = 5000

/**
 * Upper bound on `readyTimeoutMs`. The renderer-ready wait runs INSIDE the launch dispatch, so a
 * value above the dispatch operation-timeout backstop (default 120s) would turn a successful launch
 * into a retryable OPERATION_TIMEOUT — the app is up and the session registered, but the agent sees
 * a timeout, retries, and hits ALREADY_RUNNING. Mirrors the 60s clamp the wait family uses to stay
 * under the backstop.
 */
const MAX_READY_TIMEOUT_MS = 60_000

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

/**
 * Renderer-evaluable, self-bounded poll: resolve as soon as the document has finished its
 * initial parse AND its body contains meaningful rendered content (not just an empty app
 * root container), or `{ ready: false }` once the `arg.timeoutMs` budget elapses. Runs
 * inside the transport's `(async () => { … })()` wrapper, so `await` / `return` work and
 * Date.now/setTimeout are the renderer's.
 */
const RENDERER_READY_BODY = `
const deadline = Date.now() + (typeof arg.timeoutMs === 'number' ? arg.timeoutMs : 0);
function ready() {
  if (typeof document === 'undefined') return false;
  if (document.readyState === 'loading' || !document.body) return false;
  // Short-circuit on the FIRST non-whitespace text node (skipping script/style/template)
  // rather than concatenating the whole subtree — a ready large DOM returns on the first
  // hit instead of materialising all its text.
  function hasMeaningfulText(node) {
    if (!node) return false;
    if (node.nodeType === 3) return (node.textContent || '').trim().length > 0;
    if (node.nodeType !== 1) return false;
    var tagName = (node.tagName || '').toLowerCase();
    if (tagName === 'script' || tagName === 'style' || tagName === 'template') return false;
    for (var i = 0; i < node.childNodes.length; i += 1) {
      if (hasMeaningfulText(node.childNodes.item(i))) return true;
    }
    return false;
  }
  if (hasMeaningfulText(document.body)) return true;
  return !!document.body.querySelector(
    'button,input,textarea,select,a[href],[role],[aria-label],[aria-labelledby],img,svg,canvas,video,table,ul,ol,li,h1,h2,h3,h4,h5,h6,[data-testid],[data-test]'
  );
}
for (;;) {
  if (ready()) return { ready: true };
  if (Date.now() >= deadline) return { ready: ready() };
  await new Promise((r) => setTimeout(r, 50));
}
`

/**
 * Wait (up to `timeoutMs`) for the session's active renderer to finish its initial render,
 * returning whether it became ready. Best-effort: a transport that cannot evaluate in the
 * renderer, or a renderer that rejects the probe, yields `false` rather than failing the
 * launch — the session is still usable, the agent just learns the DOM was not confirmed
 * populated. `timeoutMs: 0` performs a single instantaneous check.
 */
async function awaitRendererReady(session: TransportSession, timeoutMs: number): Promise<boolean> {
  try {
    const result = await session.evaluate<{ ready?: boolean }>('renderer', RENDERER_READY_BODY, {
      timeoutMs,
    })
    return result?.ready === true
  } catch {
    return false
  }
}

const inputSchema = z.object({
  main: z
    .string()
    .optional()
    .describe(
      'Absolute path to the app main-process JS entry. Required unless executablePath is given.',
    ),
  executablePath: z
    .string()
    .optional()
    .describe('Absolute path to an Electron/app binary. Defaults to the bundled Electron.'),
  args: z.array(z.string()).optional().describe('Extra CLI args appended after the entry.'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('Environment variables for the spawned process.'),
  cwd: z.string().optional().describe('Working directory for the spawned process.'),
  timeoutMs: z.number().int().positive().optional().describe('Max wait for the first window.'),
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
  'main-process entry) or executablePath. Returns: { ok, session_id, transport, windows, renderer_ready }.',
  'Waits (up to readyTimeoutMs, default 5000) for the renderer DOM to finish its initial render, so a',
  'snapshot/find right after launch sees a populated app; renderer_ready:false means it was not confirmed',
  'in time (the session is still usable — retry the read, or wait_for_selector on an expected element).',
  'By default refuses a second launch while a session is live (pass allowMultiple: true to override).',
  'Errors: ALREADY_RUNNING (a session is live, or the concurrent-session cap is reached — stop one',
  'or pass allowMultiple; not retryable), ABSOLUTE_PATH_REQUIRED / FILE_NOT_FOUND (preflight; not',
  'retryable), BAD_ARGUMENT (neither main nor executablePath given; a runtime-altering env var like',
  'NODE_OPTIONS; instrumentNative without main; or, when the server set --app-root, a',
  'main/executablePath/cwd outside that root),',
  'SINGLE_INSTANCE_LOCK (another app instance holds the lock; not retryable),',
  'LAUNCH_TIMEOUT (first window did not appear; retryable), TRANSPORT_UNSUPPORTED (no launch-capable transport).',
].join(' ')

/** Dependency seams for {@link makeLaunchTool} — injected by tests. */
export interface LaunchToolDeps {
  /** Existence check for preflight. Defaults to `fs.existsSync`. */
  readonly fileExists?: (path: string) => boolean
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
    ...(args.instrumentNative !== undefined ? { instrumentNative: args.instrumentNative } : {}),
  }
}

/**
 * Build the `electron_launch` tool. Exposed as a factory so tests inject a
 * deterministic file-existence check instead of touching the filesystem.
 */
export function makeLaunchTool(deps: LaunchToolDeps = {}): AnyToolDefinition {
  const fileExists = deps.fileExists ?? existsSync
  return defineTool({
    name: 'electron_launch',
    title: 'Launch Electron app',
    description: DESCRIPTION,
    inputSchema,
    operationType: 'command',
    handler: async (args, ctx) => {
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
      if (args.main === undefined && args.executablePath === undefined) {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message: 'Provide main (the app entry) or executablePath.',
        })
      }
      if (args.instrumentNative === true && args.main === undefined) {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message:
            'instrumentNative requires main (the app entry); executablePath-only launches cannot be wrapped with launch-time native instrumentation.',
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
      preflight(args.main, args.executablePath, fileExists)

      // When the operator configured --app-root, confine the launch surface to it: main and
      // executablePath both run code (a main.js as the Electron main process, or an arbitrary
      // binary), so an out-of-root path is how a hostile tool call would escape the project into
      // arbitrary host execution. cwd is confined too. Without --app-root, paths are unconstrained.
      if (ctx.appRoot !== undefined) {
        for (const [label, value] of [
          ['main', args.main],
          ['executablePath', args.executablePath],
          ['cwd', args.cwd],
        ] as const) {
          if (value !== undefined && !isWithinRoot(ctx.appRoot, value)) {
            return makeError('BAD_ARGUMENT', {
              ...meta,
              message: `${label} must resolve within the configured --app-root (${ctx.appRoot}); "${value}" is outside it.`,
              details: { app_root: ctx.appRoot, [label]: value },
            })
          }
        }
      }

      const transport = ctx.transports.requireCapability('canLaunch')
      let session
      try {
        session = await transport.launch(toLaunchOptions(args))
      } catch (err) {
        throw diagnoseLaunchError(err)
      }
      // registerWithWindows deregisters the session if the window-list call
      // fails, so a post-launch error never leaves an orphaned session.
      const { managed, windows } = await registerWithWindows(ctx, transport, session)
      // The transport resolves launch once the first window FRAME exists, which is before
      // the renderer has parsed + populated its DOM — so a naive launch -> snapshot -> find
      // would see a near-empty tree. Wait for the renderer to finish its initial render
      // (best-effort, bounded) and report renderer_ready so the agent need not guess.
      const renderer_ready = await awaitRendererReady(
        managed.session,
        args.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      )
      return makeSuccess(
        { session_id: managed.id, transport: transport.id, windows, renderer_ready },
        { ...meta, session_id: managed.id },
      )
    },
  })
}

/** The default `electron_launch` tool registered by the server. */
export const launchTool: AnyToolDefinition = makeLaunchTool()
