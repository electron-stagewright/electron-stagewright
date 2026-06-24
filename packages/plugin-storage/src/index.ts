/**
 * `@electron-stagewright/plugin-storage` — read, seed, and assert an Electron app's storage (cookies,
 * the storage snapshot, per-key Web Storage, and IndexedDB) for agent-driven testing (ADR-018, built on the
 * ADR-004 plugin contract). Seed a cookie before a flow ("skip the login screen"), assert a cookie or
 * localStorage value after ("the cart survived a reload"), read/set/remove a single
 * `localStorage` / `sessionStorage` key, or read/write IndexedDB records.
 *
 * This plugin is HYBRID — three families with different trust postures:
 *
 * - **No-eval seam tools** (`storage_cookies`, `storage_set_cookie`, `storage_clear_cookies`,
 *   `storage_snapshot`) ride a dedicated TRANSPORT SEAM (Playwright's BrowserContext / the CDP Storage
 *   + Network domains), not eval, so they are NOT eval gated. They are gated on the transport's
 *   `canAccessStorage` capability (otherwise `storage.UNSUPPORTED`).
 * - **Per-key Web Storage tools** (`storage_local_*` / `storage_session_*` — get/set/remove/keys/clear)
 *   read and mutate a single `localStorage` / `sessionStorage` key, which needs renderer JavaScript, so
 *   they ride `transport.evaluate('renderer', …)` and ARE renderer-eval gated. They register only when
 *   the server permits renderer eval (`--allow-eval=renderer`, or bare `--allow-eval`) — the dispatcher
 *   hides them otherwise — and re-assert that grant at the tool boundary (`storage.EVAL_REQUIRED`) as
 *   defense in depth. They also require the transport's `supportsRendererEval` capability
 *   (`storage.UNSUPPORTED`). The agent supplies op/scope/key/value DATA, not code: the renderer body is
 *   a fixed source string (see `web-storage.ts`).
 * - **IndexedDB tools** (`storage_idb_*` — schema/get/keys/count/set/delete/clear) read and mutate
 *   records in EXISTING databases / object stores; also renderer-eval gated (the async `indexeddb.ts`
 *   body), bounded to existing databases/stores (it never creates or upgrades a schema) and refusing a
 *   missing one (`storage.NOT_FOUND`).
 *
 * SECURITY: a cookie VALUE can carry a secret (an auth token), so cookie values are redacted by default
 * before they reach the agent (`revealValues` opts out, mirroring the network plugin's
 * `redactSecureDefaults`). Reading is the secret-surface concern; writing (`storage_set_cookie`) uses
 * the agent's own value. Web Storage VALUES are NOT redacted — they are app state, and redacting them
 * would defeat the read tools' assert-a-persisted-value purpose; treat the output as sensitive if the
 * app stores tokens in `localStorage` (the same asymmetry the snapshot documents). IndexedDB record
 * values are likewise returned verbatim by default, with an opt-in `redactValues` config for apps that
 * keep secrets there.
 *
 * @module
 */

import {
  defineTool,
  makePluginError,
  makeSuccess,
  readPackageVersion,
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

import {
  WEB_STORAGE_BODY,
  type StorageScope,
  type WebStorageRequest,
  type WebStorageResult,
} from './web-storage.js'
import { INDEXEDDB_BODY, type IdbRequest, type IdbResult } from './indexeddb.js'

/** Plugin namespace — must match {@link storagePlugin.name}; the loader prefixes its tools with it. */
const STORAGE_NAMESPACE = 'storage'
/** Plugin package version advertised by `electron_plugins`; read from package.json so it cannot drift. */
const STORAGE_PLUGIN_VERSION = readPackageVersion(import.meta.url)

const configSchema = z.object({
  revealValues: z
    .boolean()
    .default(false)
    .describe(
      'Return cookie VALUES verbatim instead of redacting them. Off by default — a cookie value can be an auth token.',
    ),
  redactValues: z
    .boolean()
    .default(false)
    .describe(
      'Redact IndexedDB record VALUES (replace with "[redacted]") in read results. Off by default (IndexedDB values are app state); turn on if the app stores secrets there.',
    ),
})

/** Resolved plugin configuration — the validated output of {@link configSchema}. */
type StorageConfig = z.infer<typeof configSchema>

/** Defaults used until `setup` runs (mirror the schema defaults). */
const DEFAULT_CONFIG: StorageConfig = { revealValues: false, redactValues: false }

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

// --- Per-key Web Storage (localStorage / sessionStorage) — renderer-eval gated ---
//
// These tools run renderer JS (the no-eval seam above covers cookies + the read-only snapshot, not a
// single-key get/set/remove). They declare `requiresEvalFlag: true, evalTarget: 'renderer'`, so the
// dispatcher HIDES them unless the server permits renderer eval — that registration gate is the primary
// authorization. The runtime `requireRendererEval` re-assert below is C9 defense-in-depth: the transport
// `evaluate` method bypasses the tool-registration gate, so re-asserting at the boundary keeps an
// authorization bypass impossible even if a future change registered the tool unconditionally.

/**
 * Resolve the session + assert renderer eval is permitted (policy) AND supported (capability). Returns
 * the session, or the plugin-error envelope to return instead. The renderer twin of the IPC plugin's
 * `requireMainEval`: the policy check (`storage.EVAL_REQUIRED`) is normally unreachable via dispatch
 * because the tool is hidden when renderer eval is off, but it is the documented re-assert; the
 * capability check (`storage.UNSUPPORTED`) IS reachable — a session on a transport without
 * `supportsRendererEval` (the injector) under a renderer-eval-on server.
 */
function requireRendererEval(
  ctx: ToolContext,
  sessionId: string | undefined,
  meta: PluginMeta,
): { session: TransportSession; sessionId: string } | { error: ToolResult } {
  if (!ctx.allowEvalRenderer) {
    return {
      error: makePluginError('storage.EVAL_REQUIRED', {
        ...meta,
        message:
          'This storage tool runs renderer JS (per-key localStorage/sessionStorage or IndexedDB); start the server with --allow-eval=renderer (or bare --allow-eval) to enable it.',
      }),
    }
  }
  const managed = ctx.sessions.resolve(sessionId)
  if (!managed.transport.capabilities.supportsRendererEval) {
    return {
      error: makePluginError('storage.UNSUPPORTED', {
        ...meta,
        message:
          'This session’s transport cannot evaluate in the renderer; use the default Playwright launch transport or a CDP attach session.',
      }),
    }
  }
  return { session: managed.session, sessionId: managed.id }
}

/**
 * The raw, UNTRUSTED shape of whatever `evaluate('renderer', WEB_STORAGE_BODY)` returns: every field is
 * `unknown` until {@link isUsableWebStorageSuccess} validates it. The renderer body is fixed and returns
 * the {@link WebStorageResult} shape, but `evaluate<T>` is an unchecked cast across the process boundary,
 * so {@link runWebStorage} re-validates before the plugin trusts the result.
 */
interface RawWebStorageResult {
  readonly ok?: unknown
  readonly origin?: unknown
  readonly reason?: unknown
  readonly value?: unknown
  readonly items?: unknown
  readonly keys?: unknown
}

/** Validate one `getMany` item: `{ key: string; value: string | null }`. */
function isWebStorageItem(
  value: unknown,
): value is { readonly key: string; readonly value: string | null } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly key?: unknown }).key === 'string' &&
    ((value as { readonly value?: unknown }).value === null ||
      typeof (value as { readonly value?: unknown }).value === 'string')
  )
}

/**
 * Validate that a raw renderer result is a usable success for `req`'s op: `ok === true`, a string
 * `origin`, and the op-specific payload (a `string | null` `value` for `get`, a valid item array for
 * `getMany`, a string-key array for `keys`; `set` / `remove` / `clear` need only `ok` + `origin`).
 */
function isUsableWebStorageSuccess(
  req: WebStorageRequest,
  result: RawWebStorageResult,
): result is Extract<WebStorageResult, { ok: true }> {
  if (result.ok !== true || typeof result.origin !== 'string') return false
  switch (req.op) {
    case 'get':
      return result.value === null || typeof result.value === 'string'
    case 'getMany':
      return Array.isArray(result.items) && result.items.every(isWebStorageItem)
    case 'keys':
      return Array.isArray(result.keys) && result.keys.every((key) => typeof key === 'string')
    case 'set':
    case 'remove':
    case 'clear':
      return true
  }
  return false
}

/**
 * Run one {@link WebStorageRequest} in the renderer via the fixed {@link WEB_STORAGE_BODY}, returning
 * the validated {@link WebStorageResult} success or the plugin-error envelope for a renderer
 * storage-access failure (a quota-exceeded `setItem`, an opaque-origin context) or a malformed/absent
 * result.
 */
async function runWebStorage(
  session: TransportSession,
  req: WebStorageRequest,
  meta: PluginMeta,
): Promise<{ result: Extract<WebStorageResult, { ok: true }> } | { error: ToolResult }> {
  const result = await session.evaluate<unknown>('renderer', WEB_STORAGE_BODY, req)
  if (result === null || typeof result !== 'object' || !('ok' in result)) {
    return {
      error: makePluginError('storage.ACCESS_FAILED', {
        ...meta,
        message: 'The renderer returned no usable storage result.',
      }),
    }
  }
  const raw = result as RawWebStorageResult
  if (raw.ok === false) {
    return {
      error: makePluginError('storage.ACCESS_FAILED', {
        ...meta,
        message: `Renderer storage access failed: ${
          typeof raw.reason === 'string' ? raw.reason : 'unknown storage failure'
        }`,
      }),
    }
  }
  if (!isUsableWebStorageSuccess(req, raw)) {
    return {
      error: makePluginError('storage.ACCESS_FAILED', {
        ...meta,
        message: 'The renderer returned no usable storage result.',
      }),
    }
  }
  return { result: raw }
}

/** Human label for a scope, used in tool titles/descriptions. */
function scopeNoun(scope: StorageScope): string {
  return scope === 'session' ? 'sessionStorage' : 'localStorage'
}

const evalGated = { requiresEvalFlag: true, evalTarget: 'renderer' } as const

/**
 * Build the five per-key tools for one Web Storage scope (`local` or `session`). One factory keeps the
 * localStorage and sessionStorage tools byte-identical in behaviour, differing only in which store they
 * target. Short names become `storage_<scope>_<op>` after the loader namespaces them.
 */
function makeWebStorageTools(scope: StorageScope): AnyToolDefinition[] {
  const noun = scopeNoun(scope)
  const getTool: AnyToolDefinition = defineTool({
    name: `${scope}_get`,
    title: `Read a ${noun} item`,
    description: [
      `Read one ${noun} value by \`key\`, or several at once with \`keys\`. Provide exactly one of`,
      '`key` / `keys`. A missing key returns `value: null` (distinct from an empty string). Values are',
      `returned VERBATIM (not redacted) — treat as sensitive if the app stores tokens in ${noun}.`,
      'Returns: { ok, scope, origin, key, value } or { ok, scope, origin, items }. Errors:',
      'storage.EVAL_REQUIRED (renderer eval not enabled), storage.UNSUPPORTED, storage.ACCESS_FAILED,',
      'NOT_RUNNING.',
    ].join(' '),
    inputSchema: z
      .object({
        key: z.string().optional().describe('A single key to read.'),
        keys: z.array(z.string()).optional().describe('Several keys to read in one round-trip.'),
        ...sessionField,
      })
      .refine((v) => (v.key === undefined) !== (v.keys === undefined), {
        message: 'Provide exactly one of key or keys.',
      }),
    operationType: 'query',
    ...evalGated,
    handler: async (args, ctx) => {
      const meta = { startedAt: ctx.startedAt, now: ctx.now }
      const guard = requireRendererEval(ctx, args.sessionId, meta)
      if ('error' in guard) return guard.error
      if (args.keys !== undefined) {
        const run = await runWebStorage(
          guard.session,
          { op: 'getMany', scope, keys: args.keys },
          meta,
        )
        if ('error' in run) return run.error
        return makeSuccess(
          { scope, origin: run.result.origin, items: run.result.items ?? [] },
          meta,
        )
      }
      const run = await runWebStorage(guard.session, { op: 'get', scope, key: args.key }, meta)
      if ('error' in run) return run.error
      return makeSuccess(
        { scope, origin: run.result.origin, key: args.key, value: run.result.value ?? null },
        meta,
      )
    },
  })

  const setTool: AnyToolDefinition = defineTool({
    name: `${scope}_set`,
    title: `Set a ${noun} item`,
    description: [
      `Add or overwrite one ${noun} key with a string value (seed app state without app code).`,
      'Returns: { ok, scope, origin, set }. Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED,',
      'storage.ACCESS_FAILED (e.g. quota exceeded), NOT_RUNNING.',
    ].join(' '),
    inputSchema: z.object({
      key: z.string().describe('The key to set.'),
      value: z.string().describe('The value (stored verbatim; Web Storage holds strings).'),
      ...sessionField,
    }),
    operationType: 'command',
    ...evalGated,
    handler: async (args, ctx) => {
      const meta = { startedAt: ctx.startedAt, now: ctx.now }
      const guard = requireRendererEval(ctx, args.sessionId, meta)
      if ('error' in guard) return guard.error
      const run = await runWebStorage(
        guard.session,
        { op: 'set', scope, key: args.key, value: args.value },
        meta,
      )
      if ('error' in run) return run.error
      return makeSuccess({ scope, origin: run.result.origin, set: args.key }, meta)
    },
  })

  const removeTool: AnyToolDefinition = defineTool({
    name: `${scope}_remove`,
    title: `Remove a ${noun} item`,
    description: [
      `Remove one ${noun} key. Idempotent (removing an absent key still succeeds). Returns:`,
      '{ ok, scope, origin, removed }. Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED,',
      'storage.ACCESS_FAILED, NOT_RUNNING.',
    ].join(' '),
    inputSchema: z.object({
      key: z.string().describe('The key to remove.'),
      ...sessionField,
    }),
    operationType: 'command',
    ...evalGated,
    handler: async (args, ctx) => {
      const meta = { startedAt: ctx.startedAt, now: ctx.now }
      const guard = requireRendererEval(ctx, args.sessionId, meta)
      if ('error' in guard) return guard.error
      const run = await runWebStorage(guard.session, { op: 'remove', scope, key: args.key }, meta)
      if ('error' in run) return run.error
      return makeSuccess({ scope, origin: run.result.origin, removed: args.key }, meta)
    },
  })

  const keysTool: AnyToolDefinition = defineTool({
    name: `${scope}_keys`,
    title: `List ${noun} keys`,
    description: [
      `List every key in ${noun} (no values — cheap discovery before a targeted read). Returns:`,
      '{ ok, scope, origin, count, keys }. Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED,',
      'storage.ACCESS_FAILED, NOT_RUNNING.',
    ].join(' '),
    inputSchema: z.object({ ...sessionField }),
    operationType: 'query',
    ...evalGated,
    handler: async (args, ctx) => {
      const meta = { startedAt: ctx.startedAt, now: ctx.now }
      const guard = requireRendererEval(ctx, args.sessionId, meta)
      if ('error' in guard) return guard.error
      const run = await runWebStorage(guard.session, { op: 'keys', scope }, meta)
      if ('error' in run) return run.error
      const keys = run.result.keys ?? []
      return makeSuccess({ scope, origin: run.result.origin, count: keys.length, keys }, meta)
    },
  })

  const clearTool: AnyToolDefinition = defineTool({
    name: `${scope}_clear`,
    title: `Clear ${noun}`,
    description: [
      `Clear all of ${noun} for the active origin. Idempotent. Returns: { ok, scope, origin, cleared }.`,
      'Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED, storage.ACCESS_FAILED, NOT_RUNNING.',
    ].join(' '),
    inputSchema: z.object({ ...sessionField }),
    operationType: 'command',
    ...evalGated,
    handler: async (args, ctx) => {
      const meta = { startedAt: ctx.startedAt, now: ctx.now }
      const guard = requireRendererEval(ctx, args.sessionId, meta)
      if ('error' in guard) return guard.error
      const run = await runWebStorage(guard.session, { op: 'clear', scope }, meta)
      if ('error' in run) return run.error
      return makeSuccess({ scope, origin: run.result.origin, cleared: true }, meta)
    },
  })

  return [getTool, setTool, removeTool, keysTool, clearTool]
}

const webStorageTools: AnyToolDefinition[] = [
  ...makeWebStorageTools('local'),
  ...makeWebStorageTools('session'),
]

// --- IndexedDB (existing databases / stores only) — renderer-eval gated ---
//
// The last storage surface ADR-018 deferred. Like the per-key Web Storage tools, these run renderer JS
// (the async `INDEXEDDB_BODY`), so they carry `evalGated` (hidden unless renderer eval is permitted) and
// re-assert via `requireRendererEval`. Scope is bounded to EXISTING databases/stores — the body opens
// without a version (never creating/upgrading) and refuses a missing database/store (`storage.NOT_FOUND`).

/**
 * Run one {@link IdbRequest} in the renderer via the fixed {@link INDEXEDDB_BODY}, returning the
 * validated success or the plugin-error envelope. Maps the body's failure reasons: `database_not_found`
 * / `store_not_found` → `storage.NOT_FOUND` (actionable: a wrong name); everything else (a transaction
 * fault, `key_required`, a malformed/absent result) → `storage.ACCESS_FAILED`.
 */
async function runIndexedDb(
  session: TransportSession,
  req: IdbRequest,
  meta: PluginMeta,
): Promise<{ result: Extract<IdbResult, { ok: true }> } | { error: ToolResult }> {
  const result = await session.evaluate<unknown>('renderer', INDEXEDDB_BODY, req)
  if (result === null || typeof result !== 'object' || !('ok' in result)) {
    return {
      error: makePluginError('storage.ACCESS_FAILED', {
        ...meta,
        message: 'The renderer returned no usable IndexedDB result.',
      }),
    }
  }
  const raw = result as RawIdbResult
  if (raw.ok === false) {
    const reason = typeof raw.reason === 'string' ? raw.reason : 'unknown'
    if (reason === 'database_not_found') {
      return {
        error: makePluginError('storage.NOT_FOUND', {
          ...meta,
          message: `No IndexedDB database named "${req.database ?? ''}" (this plugin operates on existing databases only; it never creates one).`,
        }),
      }
    }
    if (reason === 'store_not_found') {
      return {
        error: makePluginError('storage.NOT_FOUND', {
          ...meta,
          message: `No object store named "${req.store ?? ''}" in database "${req.database ?? ''}".`,
        }),
      }
    }
    const message =
      reason === 'key_required'
        ? 'This object store uses out-of-line keys; provide a key for the write.'
        : `IndexedDB access failed: ${reason}`
    return { error: makePluginError('storage.ACCESS_FAILED', { ...meta, message }) }
  }
  if (!isUsableIdbSuccess(req, raw)) {
    return {
      error: makePluginError('storage.ACCESS_FAILED', {
        ...meta,
        message: 'The renderer returned a malformed IndexedDB result.',
      }),
    }
  }
  return { result: raw as Extract<IdbResult, { ok: true }> }
}

/**
 * The raw, UNTRUSTED shape of whatever `evaluate('renderer', INDEXEDDB_BODY)` returns. The body is fixed,
 * but `evaluate<T>` is still an unchecked process-boundary cast, so the plugin revalidates op-specific
 * success payloads before turning them into wire-visible success envelopes.
 */
interface RawIdbResult {
  readonly ok?: unknown
  readonly origin?: unknown
  readonly reason?: unknown
  readonly databases?: unknown
  readonly stores?: unknown
  readonly record?: unknown
  readonly records?: unknown
  readonly keys?: unknown
  readonly count?: unknown
  readonly truncated?: unknown
  readonly key?: unknown
  readonly deleted?: unknown
  readonly cleared?: unknown
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isIdbDatabaseInfo(
  value: unknown,
): value is { readonly name?: string | undefined; readonly version?: number | undefined } {
  if (typeof value !== 'object' || value === null) return false
  const info = value as { readonly name?: unknown; readonly version?: unknown }
  return (
    (info.name === undefined || typeof info.name === 'string') &&
    (info.version === undefined ||
      (typeof info.version === 'number' && Number.isFinite(info.version)))
  )
}

function isIdbKeyPath(value: unknown): value is string | readonly string[] | null {
  return (
    value === null ||
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
  )
}

function isIdbStoreInfo(value: unknown): value is {
  readonly name: string
  readonly keyPath: string | readonly string[] | null
  readonly autoIncrement: boolean
  readonly indexes: readonly string[]
} {
  if (typeof value !== 'object' || value === null) return false
  const store = value as {
    readonly name?: unknown
    readonly keyPath?: unknown
    readonly autoIncrement?: unknown
    readonly indexes?: unknown
  }
  return (
    typeof store.name === 'string' &&
    isIdbKeyPath(store.keyPath) &&
    typeof store.autoIncrement === 'boolean' &&
    Array.isArray(store.indexes) &&
    store.indexes.every((index) => typeof index === 'string')
  )
}

function isIdbRecord(value: unknown): value is { readonly key: unknown; readonly value: unknown } {
  return (
    typeof value === 'object' && value !== null && hasOwn(value, 'key') && hasOwn(value, 'value')
  )
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isUsableIdbSuccess(
  req: IdbRequest,
  result: RawIdbResult,
): result is Extract<IdbResult, { ok: true }> {
  if (result.ok !== true || typeof result.origin !== 'string') return false
  switch (req.op) {
    case 'schema':
      return req.database === undefined
        ? Array.isArray(result.databases) && result.databases.every(isIdbDatabaseInfo)
        : Array.isArray(result.stores) && result.stores.every(isIdbStoreInfo)
    case 'get':
      if (req.key !== undefined && req.key !== null) {
        return result.record === null || isIdbRecord(result.record)
      }
      return (
        Array.isArray(result.records) &&
        result.records.every(isIdbRecord) &&
        typeof result.truncated === 'boolean'
      )
    case 'keys':
      return (
        Array.isArray(result.keys) &&
        isFiniteNumber(result.count) &&
        typeof result.truncated === 'boolean'
      )
    case 'count':
      return isFiniteNumber(result.count)
    case 'set':
      return hasOwn(result, 'key')
    case 'delete':
      return hasOwn(result, 'deleted')
    case 'clear':
      return result.cleared === true
  }
  return false
}

/** Replace a record's value with `[redacted]` when the `redactValues` config is on (the opt-in secret bound). */
function redactRecord<T extends { value: unknown }>(record: T): T {
  return config.redactValues ? { ...record, value: '[redacted]' } : record
}

/** A JSON key (string / number / composite array) the agent can name a record by. */
const idbKeySchema = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])

/** A key range for the multi-record read / keys / count ops. */
const idbRangeSchema = z.object({
  lower: idbKeySchema.optional(),
  upper: idbKeySchema.optional(),
  lowerOpen: z.boolean().optional(),
  upperOpen: z.boolean().optional(),
})

const idbStoreField = {
  database: z.string().min(1).describe('The IndexedDB database name (must already exist).'),
  store: z.string().min(1).describe('The object store name (must already exist in the database).'),
  ...sessionField,
}

const idbSchemaTool: AnyToolDefinition = defineTool({
  name: 'idb_schema',
  title: 'List IndexedDB databases or stores',
  description: [
    'Discover IndexedDB structure: with no `database`, list the app’s databases ({ name, version });',
    'with a `database`, list its object stores ({ name, keyPath, autoIncrement, indexes }). Returns:',
    '{ ok, origin, databases } or { ok, origin, database, stores }. Errors: storage.EVAL_REQUIRED,',
    'storage.UNSUPPORTED, storage.NOT_FOUND (named database absent), storage.ACCESS_FAILED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    database: z
      .string()
      .min(1)
      .optional()
      .describe('Omit to list databases; give a name to list its stores.'),
    ...sessionField,
  }),
  operationType: 'query',
  ...evalGated,
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireRendererEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const run = await runIndexedDb(
      guard.session,
      { op: 'schema', ...(args.database !== undefined ? { database: args.database } : {}) },
      meta,
    )
    if ('error' in run) return run.error
    if (args.database === undefined) {
      return makeSuccess({ origin: run.result.origin, databases: run.result.databases ?? [] }, meta)
    }
    return makeSuccess(
      { origin: run.result.origin, database: args.database, stores: run.result.stores ?? [] },
      meta,
    )
  },
})

const idbGetTool: AnyToolDefinition = defineTool({
  name: 'idb_get',
  title: 'Read IndexedDB records',
  description: [
    'Read from an object store: one record by `key`, a `range` of records, or all records (bounded by',
    '`limit`, default 1000, with a `truncated` flag). Use `index` to read via a store index instead of',
    'the primary key. Values are returned VERBATIM (configure redactValues to mask them). Provide at most',
    'one of `key` / `range`. Returns: { ok, origin, record } or { ok, origin, records, truncated }.',
    'Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED, storage.NOT_FOUND, storage.ACCESS_FAILED,',
    'NOT_RUNNING.',
  ].join(' '),
  inputSchema: z
    .object({
      key: idbKeySchema
        .optional()
        .describe('Read the single record with this primary (or index) key.'),
      index: z
        .string()
        .optional()
        .describe('Read via this store index instead of the primary key.'),
      range: idbRangeSchema.optional().describe('Read records whose key falls in this range.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Max records for a range/all read (default 1000).'),
      ...idbStoreField,
    })
    .refine((v) => !(v.key !== undefined && v.range !== undefined), {
      message: 'Provide at most one of key or range.',
    }),
  operationType: 'query',
  ...evalGated,
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireRendererEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const req: IdbRequest = {
      op: 'get',
      database: args.database,
      store: args.store,
      ...(args.key !== undefined ? { key: args.key } : {}),
      ...(args.index !== undefined ? { index: args.index } : {}),
      ...(args.range !== undefined ? { range: args.range } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    }
    const run = await runIndexedDb(guard.session, req, meta)
    if ('error' in run) return run.error
    if (args.key !== undefined) {
      const record = run.result.record ?? null
      return makeSuccess(
        { origin: run.result.origin, record: record === null ? null : redactRecord(record) },
        meta,
      )
    }
    const records = (run.result.records ?? []).map(redactRecord)
    return makeSuccess(
      { origin: run.result.origin, records, truncated: run.result.truncated ?? false },
      meta,
    )
  },
})

const idbKeysTool: AnyToolDefinition = defineTool({
  name: 'idb_keys',
  title: 'List IndexedDB keys',
  description: [
    'List the primary keys in an object store (no values — cheap discovery), optionally narrowed by an',
    '`index` and/or a key `range`, bounded by `limit` (default 1000, with a `truncated` flag). Returns:',
    '{ ok, origin, count, keys, truncated }. Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED,',
    'storage.NOT_FOUND, storage.ACCESS_FAILED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    index: z
      .string()
      .optional()
      .describe('List keys via this store index instead of the primary key.'),
    range: idbRangeSchema.optional().describe('Only keys in this range.'),
    limit: z.number().int().positive().optional().describe('Max keys (default 1000).'),
    ...idbStoreField,
  }),
  operationType: 'query',
  ...evalGated,
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireRendererEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const run = await runIndexedDb(
      guard.session,
      {
        op: 'keys',
        database: args.database,
        store: args.store,
        ...(args.index !== undefined ? { index: args.index } : {}),
        ...(args.range !== undefined ? { range: args.range } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      },
      meta,
    )
    if ('error' in run) return run.error
    const keys = run.result.keys ?? []
    return makeSuccess(
      {
        origin: run.result.origin,
        count: keys.length,
        keys,
        truncated: run.result.truncated ?? false,
      },
      meta,
    )
  },
})

const idbCountTool: AnyToolDefinition = defineTool({
  name: 'idb_count',
  title: 'Count IndexedDB records',
  description: [
    'Count records in an object store (cheaper than reading them), optionally narrowed by an `index`',
    'and/or a key `range`. Returns: { ok, origin, count }. Errors: storage.EVAL_REQUIRED,',
    'storage.UNSUPPORTED, storage.NOT_FOUND, storage.ACCESS_FAILED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    index: z.string().optional().describe('Count via this store index.'),
    range: idbRangeSchema.optional().describe('Only records in this range.'),
    ...idbStoreField,
  }),
  operationType: 'query',
  ...evalGated,
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireRendererEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const run = await runIndexedDb(
      guard.session,
      {
        op: 'count',
        database: args.database,
        store: args.store,
        ...(args.index !== undefined ? { index: args.index } : {}),
        ...(args.range !== undefined ? { range: args.range } : {}),
      },
      meta,
    )
    if ('error' in run) return run.error
    return makeSuccess({ origin: run.result.origin, count: run.result.count ?? 0 }, meta)
  },
})

const idbSetTool: AnyToolDefinition = defineTool({
  name: 'idb_set',
  title: 'Put an IndexedDB record',
  description: [
    'Add or overwrite one record in an existing object store (seed app state). Omit `key` for a store',
    'with an in-line key path or autoIncrement; provide `key` for an out-of-line-key store. Returns:',
    '{ ok, origin, key } (the effective key). Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED,',
    'storage.NOT_FOUND, storage.ACCESS_FAILED (incl. a missing required key), NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    value: z
      .unknown()
      .describe('The record value (any JSON; structured-clone superset is not supported).'),
    key: idbKeySchema
      .optional()
      .describe('Explicit key — required only for out-of-line-key stores.'),
    ...idbStoreField,
  }),
  operationType: 'command',
  ...evalGated,
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireRendererEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const run = await runIndexedDb(
      guard.session,
      {
        op: 'set',
        database: args.database,
        store: args.store,
        value: args.value,
        ...(args.key !== undefined ? { key: args.key } : {}),
      },
      meta,
    )
    if ('error' in run) return run.error
    return makeSuccess({ origin: run.result.origin, key: run.result.key ?? null }, meta)
  },
})

const idbDeleteTool: AnyToolDefinition = defineTool({
  name: 'idb_delete',
  title: 'Delete an IndexedDB record',
  description: [
    'Delete one record by primary `key` from an object store. Idempotent. Returns:',
    '{ ok, origin, deleted }. Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED, storage.NOT_FOUND,',
    'storage.ACCESS_FAILED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({
    key: idbKeySchema.describe('The primary key to delete.'),
    ...idbStoreField,
  }),
  operationType: 'command',
  ...evalGated,
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireRendererEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const run = await runIndexedDb(
      guard.session,
      { op: 'delete', database: args.database, store: args.store, key: args.key },
      meta,
    )
    if ('error' in run) return run.error
    return makeSuccess({ origin: run.result.origin, deleted: run.result.deleted ?? args.key }, meta)
  },
})

const idbClearTool: AnyToolDefinition = defineTool({
  name: 'idb_clear',
  title: 'Clear an IndexedDB store',
  description: [
    'Remove every record from an object store (the store itself stays). Idempotent. Returns:',
    '{ ok, origin, cleared }. Errors: storage.EVAL_REQUIRED, storage.UNSUPPORTED, storage.NOT_FOUND,',
    'storage.ACCESS_FAILED, NOT_RUNNING.',
  ].join(' '),
  inputSchema: z.object({ ...idbStoreField }),
  operationType: 'command',
  ...evalGated,
  handler: async (args, ctx) => {
    const meta = { startedAt: ctx.startedAt, now: ctx.now }
    const guard = requireRendererEval(ctx, args.sessionId, meta)
    if ('error' in guard) return guard.error
    const run = await runIndexedDb(
      guard.session,
      { op: 'clear', database: args.database, store: args.store },
      meta,
    )
    if ('error' in run) return run.error
    return makeSuccess({ origin: run.result.origin, cleared: true }, meta)
  },
})

const indexedDbTools: AnyToolDefinition[] = [
  idbSchemaTool,
  idbGetTool,
  idbKeysTool,
  idbCountTool,
  idbSetTool,
  idbDeleteTool,
  idbClearTool,
]

/**
 * The storage plugin. Load with `--plugin @electron-stagewright/plugin-storage` or
 * `createServer({ plugins: [storagePlugin] })`. The cookie + snapshot tools need NO eval flag; the
 * per-key `storage_local_*` / `storage_session_*` and `storage_idb_*` tools register only under
 * `--allow-eval=renderer` (or bare `--allow-eval`). Configure via `pluginConfigs.storage`
 * (`{ revealValues?, redactValues? }`).
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
    EVAL_REQUIRED: {
      http: 403,
      retryable: false,
      hint: 'Per-key localStorage/sessionStorage and IndexedDB tools run renderer JS; start the server with --allow-eval=renderer (or bare --allow-eval).',
    },
    ACCESS_FAILED: {
      http: 422,
      retryable: false,
      hint: 'The renderer could not read or write the storage area (e.g. quota exceeded or an opaque origin).',
    },
    NOT_FOUND: {
      http: 404,
      retryable: false,
      hint: 'The named IndexedDB database or object store does not exist; this plugin operates on existing databases/stores only.',
    },
  },
  tools: [
    cookiesTool,
    setCookieTool,
    clearCookiesTool,
    snapshotTool,
    ...webStorageTools,
    ...indexedDbTools,
  ],
  setup: (raw) => {
    config = raw as StorageConfig
  },
  teardown: async () => {
    config = DEFAULT_CONFIG
  },
}

export default storagePlugin
