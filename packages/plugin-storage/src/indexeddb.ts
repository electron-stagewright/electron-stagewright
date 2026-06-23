/**
 * IndexedDB support for the storage plugin (ADR-018 Status Update) — the async renderer-eval body plus
 * its request/result types. IndexedDB is the last storage surface ADR-018 deferred; like the per-key
 * Web Storage tools it needs renderer JavaScript, so it rides `transport.evaluate('renderer', …)` and is
 * renderer-eval gated. Scope is deliberately bounded to EXISTING databases and object stores — the body
 * opens a database WITHOUT a version (so it never triggers a create/upgrade), and refuses a missing
 * database or store rather than creating one (creating a store is a schema mutation, well beyond a
 * testing seam).
 *
 * {@link INDEXEDDB_BODY} is a self-contained source STRING — no imports, no closure captures — so it
 * survives serialisation into the renderer. The agent supplies database/store/key/value/op as `arg`
 * DATA, never code. It is `async`: the transport wraps every body in `(async () => { … })()`, so the
 * body promisifies the event-based IndexedDB API and (critically) resolves a WRITE only after the
 * transaction COMMITS (`tx.oncomplete`), so a reported write has actually persisted. The connection is
 * closed in `finally` so a read never blocks a later app-driven upgrade. The same string is unit-tested
 * off-Electron by running it through the transport's async-IIFE wrapper against `fake-indexeddb`.
 *
 * Wire-safety: IndexedDB values are structured-clone (a superset of JSON). The body normalises every
 * value it returns so it round-trips over the MCP wire — `Date` becomes an ISO string, and a value that
 * cannot serialise (a `Blob` / `ArrayBuffer` / typed array, or a circular reference) becomes a typed
 * placeholder (`{ __type, byteLength? }`) rather than crashing the read or shipping `{}`.
 *
 * @module
 */

/**
 * The IndexedDB operation {@link INDEXEDDB_BODY} performs. `schema` lists databases (no `database`) or a
 * database's object stores (with `database`); the rest operate on records in one store.
 */
export type IdbOp = 'schema' | 'get' | 'keys' | 'set' | 'delete' | 'clear' | 'count'

/**
 * A primary or index key the agent can express in JSON: a string, a number, or a composite array of
 * those. IndexedDB also permits `Date` keys, but those cannot be expressed in JSON, so they are out of
 * scope for the agent-facing key.
 */
export type IdbKey = string | number | ReadonlyArray<string | number>

/**
 * A key range for the multi-record read / count / keys ops, mapped to an `IDBKeyRange`. Omitting both
 * bounds means "all". `lowerOpen` / `upperOpen` make the respective bound exclusive (default inclusive).
 */
export interface IdbKeyRangeSpec {
  readonly lower?: IdbKey | undefined
  readonly upper?: IdbKey | undefined
  readonly lowerOpen?: boolean | undefined
  readonly upperOpen?: boolean | undefined
}

/**
 * The argument passed into {@link INDEXEDDB_BODY} via `transport.evaluate('renderer', body, arg)`. Plain
 * JSON. `database` is omitted only for `schema`-list-databases; `store` is required for the record ops.
 * `key` selects one record (`get`/`delete`) or sets an explicit key (`set`); `range` selects a span for
 * `get`/`keys`/`count`; `index` reads via a store index instead of the primary key; `limit` caps a
 * multi-record read.
 */
export interface IdbRequest {
  readonly op: IdbOp
  readonly database?: string | undefined
  readonly store?: string | undefined
  readonly key?: IdbKey | undefined
  readonly value?: unknown
  readonly index?: string | undefined
  readonly range?: IdbKeyRangeSpec | undefined
  readonly limit?: number | undefined
}

/** Metadata for one object store (from the `schema` op): its key path, autoIncrement flag, and indexes. */
export interface IdbStoreInfo {
  readonly name: string
  /** The store's key path (a string, an array for a composite key, or `null` for out-of-line keys). */
  readonly keyPath: string | readonly string[] | null
  readonly autoIncrement: boolean
  readonly indexes: readonly string[]
}

/** One record returned by a read: its primary key and its JSON-normalised value. */
export interface IdbRecord {
  readonly key: unknown
  readonly value: unknown
}

/**
 * The discriminated result {@link INDEXEDDB_BODY} returns. On success it carries only the fields
 * relevant to the op (the plugin reshapes it into the tool envelope); on failure it carries a `reason`
 * — `database_not_found` / `store_not_found` (mapped to `storage.NOT_FOUND`), `key_required`, or a
 * renderer transaction error (mapped to `storage.ACCESS_FAILED`). `origin` is the active page's
 * `location.origin`, `null` only when reading the origin itself threw.
 */
export type IdbResult =
  | {
      readonly ok: true
      readonly origin: string
      /** `schema` (no database): the app's databases. */
      readonly databases?: ReadonlyArray<{ name: string | undefined; version: number | undefined }>
      /** `schema` (with database): the database's object stores. */
      readonly stores?: readonly IdbStoreInfo[]
      /** `get` by key: the record, or `null` when absent. */
      readonly record?: IdbRecord | null
      /** `get` by range / all: the records (bounded by `limit`). */
      readonly records?: readonly IdbRecord[]
      /** `keys`: the primary keys (bounded by `limit`). */
      readonly keys?: readonly unknown[]
      /** `keys`: `keys.length`; `count`: the store/range count. */
      readonly count?: number
      /** `keys` / `get`-all: whether more records existed past `limit`. */
      readonly truncated?: boolean
      /** `set`: the effective (possibly generated) key. */
      readonly key?: unknown
      /** `delete`: the key removed. */
      readonly deleted?: unknown
      /** `clear`: always `true`. */
      readonly cleared?: boolean
    }
  | { readonly ok: false; readonly origin: string | null; readonly reason: string }

/**
 * The renderer body. Runs under the transport's `"use strict"; return (async () => { … })()` wrapper
 * with the {@link IdbRequest} bound to `arg`, and resolves to an {@link IdbResult}. Self-contained: it
 * declares its own promisify / normalise / range helpers (no closure captures). Opens the database
 * without a version (aborting an accidental create), runs the op in a single transaction whose
 * completion it awaits, and closes the connection in `finally`.
 */
export const INDEXEDDB_BODY = `
  const req = arg;
  let origin = null;
  let db = null;
  try {
    origin = window.location.origin;
    const idb = window.indexedDB;
    const LIMIT = typeof req.limit === 'number' && req.limit > 0 ? Math.floor(req.limit) : 1000;

    const reqP = (request) => new Promise((res, rej) => {
      request.onsuccess = () => res(request.result);
      request.onerror = () => rej(request.error || new Error('request_failed'));
    });
    const txDone = (tx) => new Promise((res, rej) => {
      tx.oncomplete = () => res();
      tx.onabort = () => rej(tx.error || new Error('transaction_aborted'));
      tx.onerror = () => rej(tx.error || new Error('transaction_error'));
    });
    const walk = (v, seen) => {
      if (v === undefined) return null;
      if (v === null || typeof v !== 'object') return v;
      if (v instanceof Date) return v.toISOString();
      if (typeof Blob !== 'undefined' && v instanceof Blob) return { __type: 'Blob', byteLength: v.size };
      if (v instanceof ArrayBuffer) return { __type: 'ArrayBuffer', byteLength: v.byteLength };
      if (ArrayBuffer.isView(v)) return { __type: (v.constructor && v.constructor.name) || 'TypedArray', byteLength: v.byteLength };
      if (seen.has(v)) return { __type: 'Circular' };
      seen.add(v);
      if (Array.isArray(v)) return v.map((x) => walk(x, seen));
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k], seen);
      return out;
    };
    const norm = (v) => walk(v, new WeakSet());
    const toRange = (r) => {
      if (!r) return undefined;
      const KR = window.IDBKeyRange;
      const hasL = r.lower !== undefined && r.lower !== null;
      const hasU = r.upper !== undefined && r.upper !== null;
      if (hasL && hasU) return KR.bound(r.lower, r.upper, !!r.lowerOpen, !!r.upperOpen);
      if (hasL) return KR.lowerBound(r.lower, !!r.lowerOpen);
      if (hasU) return KR.upperBound(r.upper, !!r.upperOpen);
      return undefined;
    };

    if (req.op === 'schema' && (req.database === undefined || req.database === null || req.database === '')) {
      const dbs = idb.databases ? await idb.databases() : [];
      return { ok: true, origin: origin, databases: dbs.map((d) => ({ name: d.name, version: d.version })) };
    }

    db = await new Promise((res, rej) => {
      const open = idb.open(req.database);
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error || new Error('open_failed'));
      open.onblocked = () => rej(new Error('open_blocked'));
      open.onupgradeneeded = () => {
        try { if (open.transaction) open.transaction.abort(); } catch (e) {}
        rej(new Error('database_not_found'));
      };
    });

    if (req.op === 'schema') {
      const names = Array.prototype.slice.call(db.objectStoreNames);
      const stores = [];
      if (names.length > 0) {
        const tx = db.transaction(names, 'readonly');
        for (let i = 0; i < names.length; i++) {
          const s = tx.objectStore(names[i]);
          stores.push({
            name: names[i],
            keyPath: s.keyPath === undefined ? null : s.keyPath,
            autoIncrement: !!s.autoIncrement,
            indexes: Array.prototype.slice.call(s.indexNames),
          });
        }
      }
      return { ok: true, origin: origin, database: req.database, stores: stores };
    }

    if (!db.objectStoreNames.contains(req.store)) {
      return { ok: false, origin: origin, reason: 'store_not_found' };
    }

    const writes = req.op === 'set' || req.op === 'delete' || req.op === 'clear';
    const tx = db.transaction(req.store, writes ? 'readwrite' : 'readonly');
    const committed = txDone(tx);
    const store = tx.objectStore(req.store);
    const source = req.index ? store.index(req.index) : store;

    let payload;
    switch (req.op) {
      case 'count': {
        payload = { count: await reqP(source.count(toRange(req.range))) };
        break;
      }
      case 'keys': {
        const all = await reqP(source.getAllKeys(toRange(req.range), LIMIT + 1));
        const truncated = all.length > LIMIT;
        const keys = all.slice(0, LIMIT).map(norm);
        payload = { keys: keys, count: keys.length, truncated: truncated };
        break;
      }
      case 'get': {
        if (req.key !== undefined && req.key !== null) {
          const v = await reqP(source.get(req.key));
          if (v === undefined) {
            payload = { record: null };
          } else {
            // For an index read, req.key is the INDEX key; the record's primary key (what delete/get
            // by key expect) comes from getKey. For a primary-store read they are the same.
            const pk = req.index ? await reqP(source.getKey(req.key)) : req.key;
            payload = { record: { key: norm(pk), value: norm(v) } };
          }
        } else {
          const range = toRange(req.range);
          const records = [];
          let truncated = false;
          await new Promise((res, rej) => {
            const cursorReq = source.openCursor(range);
            cursorReq.onsuccess = () => {
              const cursor = cursorReq.result;
              if (!cursor) { res(); return; }
              if (records.length >= LIMIT) { truncated = true; res(); return; }
              records.push({ key: norm(cursor.primaryKey), value: norm(cursor.value) });
              cursor.continue();
            };
            cursorReq.onerror = () => rej(cursorReq.error || new Error('cursor_failed'));
          });
          payload = { records: records, truncated: truncated };
        }
        break;
      }
      case 'set': {
        const inline = store.keyPath !== null && store.keyPath !== undefined;
        let key;
        if (inline) {
          key = await reqP(store.put(req.value));
        } else if (req.key !== undefined && req.key !== null) {
          key = await reqP(store.put(req.value, req.key));
        } else if (store.autoIncrement) {
          key = await reqP(store.put(req.value));
        } else {
          return { ok: false, origin: origin, reason: 'key_required' };
        }
        payload = { key: norm(key) };
        break;
      }
      case 'delete': {
        await reqP(store.delete(req.key));
        payload = { deleted: norm(req.key) };
        break;
      }
      case 'clear': {
        await reqP(store.clear());
        payload = { cleared: true };
        break;
      }
      default:
        return { ok: false, origin: origin, reason: 'unsupported_op:' + String(req.op) };
    }
    await committed;
    return Object.assign({ ok: true, origin: origin }, payload);
  } catch (err) {
    const reason = err && err.message ? String(err.message) : String(err);
    return { ok: false, origin: origin, reason: reason };
  } finally {
    if (db) { try { db.close(); } catch (e) {} }
  }
`
