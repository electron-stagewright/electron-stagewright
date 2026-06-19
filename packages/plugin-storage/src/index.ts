/**
 * `@electron-stagewright/plugin-storage` — read, seed, and assert an Electron app's storage (cookies +
 * the storage snapshot) for agent-driven testing (ADR-018, built on the ADR-004 plugin contract). Seed
 * a cookie before a flow ("skip the login screen"), assert a cookie or localStorage value after
 * ("the cart survived a reload"), all WITHOUT running app JavaScript.
 *
 * Like the network and clock plugins, the tools ride a dedicated TRANSPORT SEAM (Playwright's
 * BrowserContext / the CDP Storage + Network domains), not eval, so this plugin is NOT `--allow-eval`
 * gated. It IS gated on the transport's `canAccessStorage` capability (otherwise
 * `storage.UNSUPPORTED`). Tools
 * (namespaced by the loader): `storage_cookies`, `storage_set_cookie`, `storage_clear_cookies`,
 * `storage_snapshot`.
 *
 * SECURITY: a cookie VALUE can carry a secret (an auth token), so cookie values are redacted by default
 * before they reach the agent (`revealValues` opts out, mirroring the network plugin's
 * `redactSecureDefaults`). Reading is the secret-surface concern; writing (`storage_set_cookie`) uses
 * the agent's own value.
 *
 * @module
 */

import {
  defineTool,
  makePluginError,
  makeSuccess,
  type AnyToolDefinition,
  type CookieFilter,
  type StorageCookie,
  type StorageSnapshot,
  type StagewrightPlugin,
  type ToolContext,
  type ToolResult,
  type TransportSession,
} from '@electron-stagewright/core'
import { z } from 'zod'

/** Plugin namespace — must match {@link storagePlugin.name}; the loader prefixes its tools with it. */
const STORAGE_NAMESPACE = 'storage'
/** Plugin package version advertised by `electron_plugins`; keep in sync with package.json. */
const STORAGE_PLUGIN_VERSION = '0.1.0'

const configSchema = z.object({
  revealValues: z
    .boolean()
    .default(false)
    .describe(
      'Return cookie VALUES verbatim instead of redacting them. Off by default — a cookie value can be an auth token.',
    ),
})

/** Resolved plugin configuration — the validated output of {@link configSchema}. */
type StorageConfig = z.infer<typeof configSchema>

/** Defaults used until `setup` runs (mirror the schema defaults). */
const DEFAULT_CONFIG: StorageConfig = { revealValues: false }

let config: StorageConfig = DEFAULT_CONFIG

/** The envelope meta a plugin tool threads into `makeSuccess` / `makePluginError`. */
interface PluginMeta {
  readonly startedAt: number
  readonly now: () => number
}

/** Replace a cookie's value with `[redacted]` unless `revealValues` is on (the secret-surface bound). */
function redactCookie(cookie: StorageCookie): StorageCookie {
  return config.revealValues ? cookie : { ...cookie, value: '[redacted]' }
}

/** Redact every cookie's value (for the read paths) before the agent sees it. */
function redactCookies(cookies: readonly StorageCookie[]): StorageCookie[] {
  return cookies.map(redactCookie)
}

/**
 * Resolve the session + assert its transport can access storage (`canAccessStorage`). Returns the
 * session, or the plugin-error envelope to return instead. Not eval-gated — this is a transport seam.
 */
function requireStorage(
  ctx: ToolContext,
  sessionId: string | undefined,
  meta: PluginMeta,
): { session: TransportSession; sessionId: string } | { error: ToolResult } {
  const managed = ctx.sessions.resolve(sessionId)
  if (!managed.transport.capabilities.canAccessStorage) {
    return {
      error: makePluginError('storage.UNSUPPORTED', {
        ...meta,
        message:
          'This session’s transport cannot access storage; use the default Playwright launch transport or a CDP attach session.',
      }),
    }
  }
  return { session: managed.session, sessionId: managed.id }
}

/** Build a {@link CookieFilter} from the agent-facing `url` / `name` args (the allowlist on read/clear). */
function toCookieFilter(args: {
  url?: string | undefined
  name?: string | undefined
}): CookieFilter | undefined {
  if (args.url === undefined && args.name === undefined) return undefined
  return {
    ...(args.url !== undefined ? { urls: [args.url] } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
  }
}

const sessionField = {
  sessionId: z.string().optional().describe('Target session; defaults to the only session.'),
}

const cookiesTool: AnyToolDefinition = defineTool({
  name: 'cookies',
  title: 'Read the app cookies',
  description: [
    'Return the app’s cookies, optionally narrowed by `url` (cookies that apply to it) and/or `name`.',
    'Cookie VALUES are redacted by default (a value can be an auth token); set the plugin’s revealValues',
    'config to capture them. Returns: { ok, count, cookies }. Errors: storage.UNSUPPORTED (transport',
    'cannot access storage), NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    url: z.string().optional().describe('Only cookies that apply to this URL.'),
    name: z.string().optional().describe('Only the cookie with this exact name.'),
    ...sessionField,
  }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireStorage(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const cookies = redactCookies(await guard.session.getCookies(toCookieFilter(args)))
    return makeSuccess({ count: cookies.length, cookies }, meta)
  },
})

const setCookieTool: AnyToolDefinition = defineTool({
  name: 'set_cookie',
  title: 'Set a cookie',
  description: [
    'Add or overwrite one cookie to seed app state (e.g. an auth token before a flow). Provide a `url`',
    'OR a `domain` (one is required). Returns: { ok, set }. Errors: storage.UNSUPPORTED, NOT_RUNNING,',
    'BAD_ARGUMENT (neither url nor domain).',
  ].join(' '),
  inputSchema: z
    .object({
      name: z.string().min(1).describe('Cookie name.'),
      value: z.string().describe('Cookie value (the agent’s own data; not redacted on write).'),
      url: z.string().optional().describe('A URL the cookie applies to (set this OR domain+path).'),
      domain: z
        .string()
        .optional()
        .describe('Cookie domain, e.g. app.example.com (set this OR url).'),
      path: z.string().optional().describe('Cookie path (default /).'),
      expires: z
        .number()
        .optional()
        .describe('Expiry in epoch SECONDS; omit for a session cookie.'),
      httpOnly: z.boolean().optional(),
      secure: z.boolean().optional(),
      sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
      ...sessionField,
    })
    .refine((v) => v.url !== undefined || v.domain !== undefined, {
      message: 'set_cookie requires a url or a domain.',
    }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireStorage(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    // Playwright's addCookies requires a url OR a domain+path PAIR; a domain-seeded cookie without a
    // path would fail there (CDP defaults it). Apply the documented `/` default so a domain-without-url
    // cookie works identically on both transports.
    const path =
      args.path ?? (args.url === undefined && args.domain !== undefined ? '/' : undefined)
    const cookie: StorageCookie = {
      name: args.name,
      value: args.value,
      ...(args.url !== undefined ? { url: args.url } : {}),
      ...(args.domain !== undefined ? { domain: args.domain } : {}),
      ...(path !== undefined ? { path } : {}),
      ...(args.expires !== undefined ? { expires: args.expires } : {}),
      ...(args.httpOnly !== undefined ? { httpOnly: args.httpOnly } : {}),
      ...(args.secure !== undefined ? { secure: args.secure } : {}),
      ...(args.sameSite !== undefined ? { sameSite: args.sameSite } : {}),
    }
    await guard.session.setCookie(cookie)
    return makeSuccess({ set: args.name }, meta)
  },
})

const clearCookiesTool: AnyToolDefinition = defineTool({
  name: 'clear_cookies',
  title: 'Clear cookies',
  description: [
    'Clear cookies — all of them, or only those matching `url` and/or `name`. Idempotent. Returns:',
    '{ ok, cleared }. Errors: storage.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    url: z.string().optional().describe('Only clear cookies that apply to this URL.'),
    name: z.string().optional().describe('Only clear the cookie with this exact name.'),
    ...sessionField,
  }),
  operationType: 'command',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireStorage(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    await guard.session.clearCookies(toCookieFilter(args))
    return makeSuccess(
      {
        cleared: args.name !== undefined ? args.name : args.url !== undefined ? args.url : 'all',
      },
      meta,
    )
  },
})

const snapshotTool: AnyToolDefinition = defineTool({
  name: 'snapshot',
  title: 'Read the storage snapshot',
  description: [
    'Return a point-in-time storage snapshot — every cookie plus each visited origin’s localStorage —',
    'the no-eval way to ASSERT persisted state. Cookie values are redacted by default; localStorage',
    'values are NOT (they are app state, not cookie secrets — treat them as sensitive if your app stores',
    'tokens there). Returns: { ok, cookies, origins }. Errors: storage.UNSUPPORTED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ ...sessionField }),
  operationType: 'query',
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireStorage(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const snapshot: StorageSnapshot = await guard.session.storageSnapshot()
    return makeSuccess(
      { cookies: redactCookies(snapshot.cookies), origins: snapshot.origins },
      meta,
    )
  },
})

/**
 * The storage plugin. Load with `--plugin @electron-stagewright/plugin-storage` (NO eval flag — it does
 * not run app JS) or `createServer({ plugins: [storagePlugin] })`. Configure via
 * `pluginConfigs.storage` (`{ revealValues? }`).
 */
export const storagePlugin: StagewrightPlugin = {
  name: STORAGE_NAMESPACE,
  version: STORAGE_PLUGIN_VERSION,
  coreVersionRange: '*',
  configSchema,
  errorCodes: {
    UNSUPPORTED: {
      http: 409,
      retryable: false,
      hint: 'This transport cannot access storage; use the default Playwright launch transport or a CDP attach session.',
    },
  },
  tools: [cookiesTool, setCookieTool, clearCookiesTool, snapshotTool],
  setup: (raw) => {
    config = raw as StorageConfig
  },
  teardown: async () => {
    config = DEFAULT_CONFIG
  },
}

export default storagePlugin
