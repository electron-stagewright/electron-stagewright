/**
 * Per-key Web Storage support for the storage plugin (ADR-018 Status Update) — the renderer-eval body
 * plus its request/result types. Unlike the cookie + snapshot tools (which ride the no-eval transport
 * storage seam), reading or mutating a single `localStorage` / `sessionStorage` key needs to run
 * renderer JavaScript, so these tools call `transport.evaluate('renderer', WEB_STORAGE_BODY, request)`
 * and are renderer-eval gated.
 *
 * {@link WEB_STORAGE_BODY} is a self-contained source STRING — no imports, no closure captures — so it
 * survives serialisation into the renderer (the bundled-not-hand-serialised lesson: a closure body
 * would drop its dependencies). Keeping it a string the transport executes (rather than a
 * `new Function` built in the plugin) preserves the no-arbitrary-eval-in-the-transport posture: the
 * agent supplies op / scope / key / value DATA, never code. The same string is unit-tested by running
 * it through the async-IIFE wrapper the transport uses, against a fake `window`.
 *
 * @module
 */

/** Which Web Storage area a per-key op targets — `window.localStorage` or `window.sessionStorage`. */
export type StorageScope = 'local' | 'session'

/**
 * The per-key operation {@link WEB_STORAGE_BODY} performs. `getMany` backs the multi-key read variant
 * of the `*_get` tools (one renderer round-trip for several keys).
 */
export type WebStorageOp = 'get' | 'getMany' | 'set' | 'remove' | 'keys' | 'clear'

/**
 * The argument passed into {@link WEB_STORAGE_BODY} via `transport.evaluate('renderer', body, arg)`.
 * Plain JSON — every field is data the agent supplied. `key`/`keys`/`value` are present only for the
 * ops that use them.
 */
export interface WebStorageRequest {
  readonly op: WebStorageOp
  readonly scope: StorageScope
  /** The single key for `get` / `set` / `remove`. */
  readonly key?: string | undefined
  /** The keys for `getMany`. */
  readonly keys?: readonly string[] | undefined
  /** The value for `set`. */
  readonly value?: string | undefined
}

/** One key/value pair in a `getMany` result; `value` is `null` when the key is absent (≠ `""`). */
export interface WebStorageItem {
  readonly key: string
  readonly value: string | null
}

/**
 * The discriminated result {@link WEB_STORAGE_BODY} returns. On success the shape carries only the
 * fields relevant to the op (the plugin reshapes it into the tool envelope); on failure it carries a
 * `reason` (a renderer storage access error — a quota-exceeded `setItem`, or an opaque-origin context
 * where storage access throws). `origin` is the active page's `location.origin`, surfaced so the agent
 * knows WHICH origin's storage it read (Web Storage is per-origin); it is `null` only when reading the
 * origin itself threw.
 */
export type WebStorageResult =
  | {
      readonly ok: true
      readonly origin: string
      /** `get`: the value, or `null` when absent. */
      readonly value?: string | null
      /** `getMany`: one entry per requested key (order preserved). */
      readonly items?: readonly WebStorageItem[]
      /** `keys`: every key in the scope (the `keys` tool derives its `count` from this). */
      readonly keys?: readonly string[]
    }
  | { readonly ok: false; readonly origin: string | null; readonly reason: string }

/**
 * The renderer body. Runs under the transport's `"use strict"; return (async () => { … })()` wrapper
 * with the {@link WebStorageRequest} bound to `arg`, and resolves to a {@link WebStorageResult}. Web
 * Storage is synchronous, so the body never awaits; the whole thing is try/caught so a storage-access
 * throw becomes a structured failure rather than an unhandled rejection.
 */
export const WEB_STORAGE_BODY = `
  const req = arg;
  let origin = null;
  try {
    origin = window.location.origin;
    const store = req.scope === 'session' ? window.sessionStorage : window.localStorage;
    switch (req.op) {
      case 'get':
        return { ok: true, origin: origin, value: store.getItem(req.key) };
      case 'getMany': {
        const keys = req.keys || [];
        const items = [];
        for (let i = 0; i < keys.length; i++) items.push({ key: keys[i], value: store.getItem(keys[i]) });
        return { ok: true, origin: origin, items: items };
      }
      case 'set':
        store.setItem(req.key, req.value);
        return { ok: true, origin: origin };
      case 'remove':
        store.removeItem(req.key);
        return { ok: true, origin: origin };
      case 'keys': {
        const out = [];
        for (let i = 0; i < store.length; i++) out.push(store.key(i));
        return { ok: true, origin: origin, keys: out };
      }
      case 'clear':
        store.clear();
        return { ok: true, origin: origin };
      default:
        return { ok: false, origin: origin, reason: 'unsupported_op:' + String(req.op) };
    }
  } catch (err) {
    const reason = err && err.message ? String(err.message) : String(err);
    return { ok: false, origin: origin, reason: reason };
  }
`
