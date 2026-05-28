/**
 * `electron_info` — report the running Electron app's environment: runtime
 * versions, app paths, packaged flag, code-signature status, the active
 * transport, and its capability matrix. The proof-of-pipe lifecycle tool: it
 * exercises the full dispatch path (session resolution → main-process evaluate →
 * envelope) without mutating anything.
 *
 * @module
 */

import { z } from 'zod'

import { makeSuccess } from '../../errors/envelope.js'
import { type AnyToolDefinition, defineTool } from '../types.js'
import { type SignatureInfo, inspectSignature } from './signature.js'

/** Raw shape returned by the main-process probe. Fields are `null` when unreadable. */
interface RawInfo {
  readonly electron: string | null
  readonly node: string | null
  readonly chrome: string | null
  readonly v8: string | null
  readonly app_name: string | null
  readonly app_version: string | null
  readonly app_path: string | null
  readonly exe_path: string | null
  readonly user_data_path: string | null
  readonly packaged: boolean | null
}

/**
 * Main-process probe body. Runs as `async (electronApp, arg) => { … }` inside the
 * Electron main process (see the transport's `evaluate` wrapper), where
 * `electronApp` is the Electron module namespace and `process` is the
 * main-process global. Each accessor is guarded so a single failing call yields
 * `null` instead of rejecting the whole probe.
 */
const PROBE_BODY = `
const v = process.versions;
const app = electronApp.app;
const get = (fn) => { try { return fn(); } catch { return null; } };
return {
  electron: v.electron ?? null,
  node: v.node ?? null,
  chrome: v.chrome ?? null,
  v8: v.v8 ?? null,
  app_name: get(() => app.getName()),
  app_version: get(() => app.getVersion()),
  app_path: get(() => app.getAppPath()),
  exe_path: get(() => app.getPath('exe')),
  user_data_path: get(() => app.getPath('userData')),
  packaged: get(() => app.isPackaged),
};
`

const inputSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('Target session id. Omit when a single session is running.'),
})

const DESCRIPTION = [
  'Report the running Electron app environment: runtime versions (electron/node/chrome/v8),',
  'app name/version/paths, packaged flag, code-signature status (verified for packaged macOS',
  'apps; "unknown" for unpackaged/dev apps, "unsupported" off macOS), the active transport,',
  'and its capability matrix. Pass sessionId to target a specific session when several are running.',
  'Returns: { ok, session_id, transport, versions, app, signature, capabilities }.',
  'Errors: NOT_RUNNING (no session — call electron_launch first; not retryable),',
  'BAD_ARGUMENT (multiple sessions live — pass sessionId; not retryable).',
].join(' ')

/** Dependency seams for {@link makeInfoTool} — injected by tests. */
export interface InfoToolDeps {
  /** Signature inspector. Defaults to the real `codesign`-backed implementation. */
  readonly inspectSignature?: (targetPath: string) => Promise<SignatureInfo>
}

/**
 * Build the `electron_info` tool. Exposed as a factory so tests can inject a
 * deterministic signature inspector instead of spawning `codesign`.
 */
export function makeInfoTool(deps: InfoToolDeps = {}): AnyToolDefinition {
  const inspect = deps.inspectSignature ?? ((path: string) => inspectSignature(path))
  return defineTool({
    name: 'electron_info',
    title: 'Electron app info',
    description: DESCRIPTION,
    inputSchema,
    operationType: 'query',
    handler: async (args, ctx) => {
      const managed = ctx.sessions.resolve(args.sessionId)
      const raw = await managed.session.evaluate<RawInfo>('main', PROBE_BODY)
      const signature: SignatureInfo =
        raw.packaged === true && raw.exe_path !== null && raw.exe_path !== ''
          ? await inspect(raw.exe_path)
          : {
              status: 'unknown',
              detail:
                raw.packaged === false
                  ? 'App is not packaged; signature verification applies to packaged executables.'
                  : 'Packaged status or executable path was not returned by the probe.',
            }
      return makeSuccess(
        {
          session_id: managed.id,
          transport: managed.transport.id,
          versions: {
            electron: raw.electron,
            node: raw.node,
            chrome: raw.chrome,
            v8: raw.v8,
          },
          app: {
            name: raw.app_name,
            version: raw.app_version,
            path: raw.app_path,
            exe_path: raw.exe_path,
            user_data_path: raw.user_data_path,
            packaged: raw.packaged,
          },
          signature,
          capabilities: managed.transport.capabilities,
        },
        { startedAt: ctx.startedAt, now: ctx.now, session_id: managed.id },
      )
    },
  })
}

/** The default `electron_info` tool registered by the server. */
export const infoTool: AnyToolDefinition = makeInfoTool()
