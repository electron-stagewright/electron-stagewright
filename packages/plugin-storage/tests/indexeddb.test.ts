/**
 * Unit tests for INDEXEDDB_BODY (ADR-018 Status Update) — the async renderer-eval body behind the
 * IndexedDB tools. The body is executed the way the Playwright transport runs it: wrapped in
 * `"use strict"; return (async () => { … })()` with the request bound to `arg`, with `window` supplied
 * as an extra function parameter (Node has no DOM). The real IndexedDB implementation is `fake-indexeddb`
 * (a spec-compliant in-memory IDB) — far more faithful than a hand-rolled stub, so promisification and
 * transaction-commit timing are tested for real. A fresh IDBFactory per test keeps them isolated.
 */

import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'

import { INDEXEDDB_BODY, type IdbRequest, type IdbResult } from '../src/indexeddb.js'

const ORIGIN = 'https://app.example.com'

interface FakeWindow {
  readonly location: { readonly origin: string }
  readonly indexedDB: IDBFactory
  readonly IDBKeyRange: typeof IDBKeyRange
}

function makeWindow(factory: IDBFactory): FakeWindow {
  return { location: { origin: ORIGIN }, indexedDB: factory, IDBKeyRange }
}

/** Run INDEXEDDB_BODY exactly as the transport does, with `window` injected for the Node test. */
async function run(req: IdbRequest, win: FakeWindow): Promise<IdbResult> {
  const fn = new Function(
    'arg',
    'window',
    `"use strict"; return (async () => { ${INDEXEDDB_BODY} })()`,
  ) as (arg: IdbRequest, window: FakeWindow) => Promise<IdbResult>
  return fn(req, win)
}

interface SeedDoc {
  readonly id: string
  readonly kind: string
  readonly title: string
}

/**
 * Seed a database "appdb" with an in-line-key store "docs" (keyPath id, index byKind on kind) and an
 * out-of-line store "blobs" (explicit keys), returning a fresh isolated factory.
 */
async function seedAppDb(docs: readonly SeedDoc[] = DEFAULT_DOCS): Promise<IDBFactory> {
  const factory = new IDBFactory()
  await new Promise<void>((resolve, reject) => {
    const open = factory.open('appdb', 1)
    open.onupgradeneeded = () => {
      const db = open.result
      const docsStore = db.createObjectStore('docs', { keyPath: 'id' })
      docsStore.createIndex('byKind', 'kind', { unique: false })
      db.createObjectStore('blobs') // out-of-line keys
    }
    open.onsuccess = () => resolve()
    open.onerror = () => reject(open.error)
  })
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open('appdb')
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
  const tx = db.transaction(['docs', 'blobs'], 'readwrite')
  for (const doc of docs) tx.objectStore('docs').put(doc)
  tx.objectStore('blobs').put({ note: 'out-of-line' }, 'k1')
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
  return factory
}

const DEFAULT_DOCS: readonly SeedDoc[] = [
  { id: 'a', kind: 'note', title: 'Alpha' },
  { id: 'b', kind: 'task', title: 'Beta' },
  { id: 'c', kind: 'note', title: 'Gamma' },
]

describe('INDEXEDDB_BODY', () => {
  it('lists databases (schema, no database)', async () => {
    const factory = await seedAppDb()
    const res = await run({ op: 'schema' }, makeWindow(factory))
    expect(res).toMatchObject({ ok: true, origin: ORIGIN })
    expect(
      (res as unknown as { databases: Array<{ name: string }> }).databases.map((d) => d.name),
    ).toContain('appdb')
  })

  it('lists a database stores (schema, with database) incl. keyPath, autoIncrement, indexes', async () => {
    const factory = await seedAppDb()
    const res = (await run(
      { op: 'schema', database: 'appdb' },
      makeWindow(factory),
    )) as unknown as {
      ok: true
      stores: Array<{ name: string; keyPath: unknown; autoIncrement: boolean; indexes: string[] }>
    }
    expect(res.ok).toBe(true)
    const docs = res.stores.find((s) => s.name === 'docs')
    expect(docs).toMatchObject({ keyPath: 'id', autoIncrement: false, indexes: ['byKind'] })
    const blobs = res.stores.find((s) => s.name === 'blobs')
    expect(blobs).toMatchObject({ keyPath: null, autoIncrement: false })
  })

  it('gets one record by primary key', async () => {
    const factory = await seedAppDb()
    const res = await run(
      { op: 'get', database: 'appdb', store: 'docs', key: 'a' },
      makeWindow(factory),
    )
    expect(res).toMatchObject({
      ok: true,
      record: { key: 'a', value: { id: 'a', kind: 'note', title: 'Alpha' } },
    })
  })

  it('returns record:null for an absent key', async () => {
    const factory = await seedAppDb()
    const res = await run(
      { op: 'get', database: 'appdb', store: 'docs', key: 'zzz' },
      makeWindow(factory),
    )
    expect(res).toMatchObject({ ok: true, record: null })
  })

  it('gets all records (no key) bounded by limit with a truncated flag', async () => {
    const factory = await seedAppDb()
    const res = (await run(
      { op: 'get', database: 'appdb', store: 'docs', limit: 2 },
      makeWindow(factory),
    )) as unknown as { ok: true; records: Array<{ key: string }>; truncated: boolean }
    expect(res.ok).toBe(true)
    expect(res.records).toHaveLength(2)
    expect(res.truncated).toBe(true)
  })

  it('reads via an index and reports the PRIMARY key (not the index key)', async () => {
    const factory = await seedAppDb()
    const res = (await run(
      { op: 'get', database: 'appdb', store: 'docs', index: 'byKind', key: 'task' },
      makeWindow(factory),
    )) as unknown as { ok: true; record: { key: unknown; value: { id: string } } | null }
    expect(res.record?.value.id).toBe('b')
    // The index key was 'task'; the record's key must be the primary key 'b', so a follow-up
    // idb_delete/idb_get-by-key targets the right record.
    expect(res.record?.key).toBe('b')
  })

  it('reads a key range (fold D)', async () => {
    const factory = await seedAppDb()
    const res = (await run(
      { op: 'get', database: 'appdb', store: 'docs', range: { lower: 'a', upper: 'b' } },
      makeWindow(factory),
    )) as unknown as { ok: true; records: Array<{ key: string }> }
    expect(res.records.map((r) => r.key)).toEqual(['a', 'b'])
  })

  it('lists keys (bounded, with truncated)', async () => {
    const factory = await seedAppDb()
    const res = (await run(
      { op: 'keys', database: 'appdb', store: 'docs' },
      makeWindow(factory),
    )) as unknown as { ok: true; keys: string[]; count: number; truncated: boolean }
    expect(res.keys.sort()).toEqual(['a', 'b', 'c'])
    expect(res.count).toBe(3)
    expect(res.truncated).toBe(false)
  })

  it('counts records, honouring a range', async () => {
    const factory = await seedAppDb()
    expect(
      await run({ op: 'count', database: 'appdb', store: 'docs' }, makeWindow(factory)),
    ).toMatchObject({ ok: true, count: 3 })
    expect(
      await run(
        { op: 'count', database: 'appdb', store: 'docs', range: { lower: 'b' } },
        makeWindow(factory),
      ),
    ).toMatchObject({ ok: true, count: 2 })
  })

  it('puts a record into an in-line-key store and the write commits (read-back sees it)', async () => {
    const factory = await seedAppDb()
    const set = await run(
      {
        op: 'set',
        database: 'appdb',
        store: 'docs',
        value: { id: 'd', kind: 'note', title: 'Delta' },
      },
      makeWindow(factory),
    )
    expect(set).toMatchObject({ ok: true, key: 'd' })
    // A fresh body run sees the committed write — proves txDone awaited the commit, not just the request.
    const got = await run(
      { op: 'get', database: 'appdb', store: 'docs', key: 'd' },
      makeWindow(factory),
    )
    expect(got).toMatchObject({ ok: true, record: { value: { title: 'Delta' } } })
  })

  it('puts into an out-of-line store with an explicit key', async () => {
    const factory = await seedAppDb()
    const set = await run(
      { op: 'set', database: 'appdb', store: 'blobs', value: { hi: 1 }, key: 'k2' },
      makeWindow(factory),
    )
    expect(set).toMatchObject({ ok: true, key: 'k2' })
  })

  it('refuses a put to an out-of-line store with no key (key_required)', async () => {
    const factory = await seedAppDb()
    const res = await run(
      { op: 'set', database: 'appdb', store: 'blobs', value: { hi: 1 } },
      makeWindow(factory),
    )
    expect(res).toMatchObject({ ok: false, reason: 'key_required' })
  })

  it('deletes a record idempotently', async () => {
    const factory = await seedAppDb()
    expect(
      await run({ op: 'delete', database: 'appdb', store: 'docs', key: 'a' }, makeWindow(factory)),
    ).toMatchObject({ ok: true, deleted: 'a' })
    expect(
      await run({ op: 'get', database: 'appdb', store: 'docs', key: 'a' }, makeWindow(factory)),
    ).toMatchObject({ ok: true, record: null })
    // Deleting again still succeeds.
    expect(
      await run({ op: 'delete', database: 'appdb', store: 'docs', key: 'a' }, makeWindow(factory)),
    ).toMatchObject({ ok: true, deleted: 'a' })
  })

  it('clears a store', async () => {
    const factory = await seedAppDb()
    expect(
      await run({ op: 'clear', database: 'appdb', store: 'docs' }, makeWindow(factory)),
    ).toMatchObject({ ok: true, cleared: true })
    expect(
      await run({ op: 'count', database: 'appdb', store: 'docs' }, makeWindow(factory)),
    ).toMatchObject({ count: 0 })
  })

  it('does NOT create a missing database (returns database_not_found)', async () => {
    const factory = await seedAppDb()
    const res = await run(
      { op: 'get', database: 'no-such-db', store: 'docs', key: 'a' },
      makeWindow(factory),
    )
    expect(res).toMatchObject({ ok: false, reason: 'database_not_found' })
    // And it must not have been created as a side effect.
    const dbs = (await run({ op: 'schema' }, makeWindow(factory))) as unknown as {
      databases: Array<{ name: string }>
    }
    expect(dbs.databases.map((d) => d.name)).not.toContain('no-such-db')
  })

  it('reports a missing store as store_not_found', async () => {
    const factory = await seedAppDb()
    expect(
      await run({ op: 'get', database: 'appdb', store: 'ghost', key: 'a' }, makeWindow(factory)),
    ).toMatchObject({ ok: false, reason: 'store_not_found' })
  })

  it('normalises a Date value to an ISO string and a binary value to a typed placeholder (fold E)', async () => {
    const factory = await seedAppDb([])
    await run(
      {
        op: 'set',
        database: 'appdb',
        store: 'docs',
        value: { id: 'x', when: new Date('2020-01-02T03:04:05.000Z'), blob: new ArrayBuffer(8) },
      },
      makeWindow(factory),
    )
    const got = (await run(
      { op: 'get', database: 'appdb', store: 'docs', key: 'x' },
      makeWindow(factory),
    )) as {
      ok: true
      record: { value: { when: string; blob: { __type: string; byteLength: number } } }
    }
    expect(got.record.value.when).toBe('2020-01-02T03:04:05.000Z')
    expect(got.record.value.blob).toEqual({ __type: 'ArrayBuffer', byteLength: 8 })
  })

  it('supports a composite (array) key', async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('composite', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('s', { keyPath: ['a', 'b'] })
      open.onsuccess = () => resolve()
      open.onerror = () => reject(open.error)
    })
    await run(
      { op: 'set', database: 'composite', store: 's', value: { a: 1, b: 2, v: 'hi' } },
      makeWindow(factory),
    )
    const got = (await run(
      { op: 'get', database: 'composite', store: 's', key: [1, 2] },
      makeWindow(factory),
    )) as { ok: true; record: { value: { v: string } } | null }
    expect(got.record?.value.v).toBe('hi')
  })

  it('every result is JSON-serialisable (the wire contract)', async () => {
    const factory = await seedAppDb()
    for (const req of [
      { op: 'schema' },
      { op: 'schema', database: 'appdb' },
      { op: 'get', database: 'appdb', store: 'docs', key: 'a' },
      { op: 'get', database: 'appdb', store: 'docs' },
      { op: 'keys', database: 'appdb', store: 'docs' },
      { op: 'count', database: 'appdb', store: 'docs' },
    ] as const) {
      const res = await run(req, makeWindow(factory))
      expect(JSON.parse(JSON.stringify(res))).toEqual(res)
    }
  })
})
