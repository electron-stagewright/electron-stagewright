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
import type { LaunchOptions } from '../../transports/index.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { diagnoseLaunchError } from './diagnose.js'
import { registerWithWindows } from './session-init.js'

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
  allowMultiple: z
    .boolean()
    .optional()
    .describe('Allow launching when a session already exists. Default false (single instance).'),
})

const DESCRIPTION = [
  'Launch an Electron app and start a driving session. Provide main (absolute path to the',
  'main-process entry) or executablePath. Returns: { ok, session_id, transport, windows }.',
  'By default refuses a second launch while a session is live (pass allowMultiple: true to override).',
  'Errors: ALREADY_RUNNING (a session is live — stop it or pass allowMultiple; not retryable),',
  'ABSOLUTE_PATH_REQUIRED / FILE_NOT_FOUND (preflight; not retryable), BAD_ARGUMENT (neither main',
  'nor executablePath given), SINGLE_INSTANCE_LOCK (another app instance holds the lock; not retryable),',
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
      if (args.main === undefined && args.executablePath === undefined) {
        return makeError('BAD_ARGUMENT', {
          ...meta,
          message: 'Provide main (the app entry) or executablePath.',
        })
      }
      // Preflight throws a registered error the dispatcher maps to an envelope.
      preflight(args.main, args.executablePath, fileExists)

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
      return makeSuccess(
        { session_id: managed.id, transport: transport.id, windows },
        { ...meta, session_id: managed.id },
      )
    },
  })
}

/** The default `electron_launch` tool registered by the server. */
export const launchTool: AnyToolDefinition = makeLaunchTool()
