import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  migrateOrigin,
  ORIGIN_MIGRATION_CHUNK_BYTES,
  ORIGIN_MIGRATION_MARKER,
  ORIGIN_MIGRATION_MAX_ATTEMPTS,
  ORIGIN_PAGE_STEP_TIMEOUT_MS,
  type OriginMigrationMarker,
  runOriginMigration,
  type OriginStore,
} from '../src/index.js'
import { FakeOrigin, fakeWindowClass, type FakePagesOptions } from './fake-pages.js'

const BLANK = 'app://example/.origin-migration/blank.html'
const QUOTA_EXCEEDED = "throw Object.assign(new Error('disk'), { name: 'QuotaExceededError' });"

let userDataDir: string
let legacy: FakeOrigin
let target: FakeOrigin

beforeEach(async () => {
  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'origin-migration-test-'))
  legacy = new FakeOrigin()
  target = new FakeOrigin()
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(userDataDir, { recursive: true, force: true })
})

function bytes(length: number, seed = 7): Uint8Array {
  const out = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) out[index] = (index * seed + 3) % 251
  return out
}

/** Byte equality; toEqual walks a typed array element by element and takes seconds at megabytes. */
function sameBytes(actual: Uint8Array | undefined, expected: Uint8Array): boolean {
  return actual !== undefined && Buffer.from(actual).equals(Buffer.from(expected))
}

function migrate(
  options: Partial<FakePagesOptions> & {
    signal?: AbortSignal
    flush?: () => void
    onProgress?: (done: number, total: number) => void
    markerFile?: string
    stores?: readonly OriginStore[]
  } = {},
) {
  const pages = fakeWindowClass({ legacy, target, ...options })
  const flush = vi.fn(options.flush ?? (() => {}))
  const session = { flushStorageData: flush } as unknown as Session
  const run = migrateOrigin({
    userDataDir,
    BrowserWindow: pages.Window,
    session,
    targetUrl: BLANK,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.markerFile ? { markerFile: options.markerFile } : {}),
    ...(options.stores ? { stores: options.stores } : {}),
  })
  return { run, pages, flush, session }
}

async function marker(file = ORIGIN_MIGRATION_MARKER): Promise<OriginMigrationMarker> {
  return JSON.parse(await readFile(path.join(userDataDir, file), 'utf8')) as OriginMigrationMarker
}

describe('origin migration', () => {
  it('records an empty legacy origin as done without opening the new one', async () => {
    const { run, pages } = migrate()
    await expect(run).resolves.toMatchObject({ status: 'empty' })
    expect(pages.created).toHaveLength(1)
    expect(pages.created[0]?.destroyed).toBe(true)
    expect(target.scripts).toBe(0)
    expect(await marker()).toMatchObject({
      version: 1,
      state: 'done',
      attempts: 1,
      localStorageKeys: 0,
      files: 0,
    })
  })

  it('copies localStorage and every origin file byte for byte, then closes both pages', async () => {
    legacy.localStorage.setItem('settings', '{"state":{"language":"es"},"version":4}')
    legacy.localStorage.setItem('ui:docked', 'true')
    legacy.localStorage.setItem('clave-ñ ✓', 'valor "con" comillas\n ')
    const database = bytes(ORIGIN_MIGRATION_CHUNK_BYTES * 2 + 123)
    legacy.opfs.put('app.db', database)
    legacy.opfs.put('app.db.wal', bytes(10, 3))
    legacy.opfs.put('nested/deeper/empty.bin', new Uint8Array())
    legacy.opfs.put('app.db.crswap', bytes(5))

    const { run, pages, flush } = migrate()
    const result = await run

    expect(result).toMatchObject({ status: 'migrated' })
    expect(Object.fromEntries(target.localStorage.map)).toEqual(
      Object.fromEntries(legacy.localStorage.map),
    )
    expect(sameBytes(target.opfs.file('app.db')?.data, database)).toBe(true)
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(10, 3))
    expect(target.opfs.file('nested/deeper/empty.bin')?.data).toEqual(new Uint8Array())
    expect(target.opfs.file('app.db.crswap')).toBeUndefined()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(pages.created).toHaveLength(2)
    expect(pages.created.every((window) => window.destroyed)).toBe(true)
    expect(await marker()).toMatchObject({
      state: 'done',
      attempts: 1,
      localStorageKeys: 3,
      files: 3,
      fileBytes: database.byteLength + 10,
    })
    // The legacy origin is a backup the migration never edits.
    expect(legacy.localStorage.length).toBe(3)
    expect(sameBytes(legacy.opfs.file('app.db')?.data, database)).toBe(true)
  })

  it('runs once: a later launch neither opens pages nor touches the new origin', async () => {
    legacy.localStorage.setItem('settings', 'old')
    await migrate().run
    target.localStorage.setItem('settings', 'changed after migration')

    const again = migrate()
    await expect(again.run).resolves.toEqual({ status: 'skipped' })
    expect(again.pages.created).toHaveLength(0)
    expect(target.localStorage.getItem('settings')).toBe('changed after migration')
  })

  it('keeps keys the new origin holds, while legacy files replace what is there', async () => {
    legacy.localStorage.setItem('kept', 'legacy')
    legacy.localStorage.setItem('copied', 'legacy')
    legacy.opfs.put('app.db', bytes(64))
    legacy.opfs.put('app.db.wal', bytes(8))
    target.localStorage.setItem('kept', 'new')
    target.opfs.put('app.db', bytes(16, 5))
    target.opfs.put('app.db.wal', new Uint8Array())

    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.localStorage.getItem('kept')).toBe('new')
    expect(target.localStorage.getItem('copied')).toBe('legacy')
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(64))
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(8))
    expect([...target.opfs.children.keys()].sort()).toEqual(['app.db', 'app.db.wal'])
    expect(await marker()).toMatchObject({ localStorageKeys: 1, files: 2, fileBytes: 72 })
  })

  it('records a failure by code, retries, and stops after the attempt budget', async () => {
    legacy.localStorage.setItem('settings', 'legacy')
    const failingLoad = async (kind: 'legacy' | 'target') => {
      if (kind === 'target') {
        throw Object.assign(new Error('/Users/someone/private/path'), { code: 'ERR_FAILED' })
      }
    }

    for (let attempt = 1; attempt <= ORIGIN_MIGRATION_MAX_ATTEMPTS; attempt += 1) {
      const { run, pages } = migrate({ load: failingLoad })
      await expect(run).resolves.toMatchObject({ status: 'failed' })
      expect(pages.created.every((window) => window.destroyed)).toBe(true)
      const recorded = await marker()
      expect(recorded).toMatchObject({ state: 'failed', attempts: attempt, error: 'ERR_FAILED' })
      expect(JSON.stringify(recorded)).not.toContain('/Users/')
    }
    await expect(migrate().run).resolves.toEqual({ status: 'skipped' })
  })

  it('succeeds on a retry after a failed attempt', async () => {
    legacy.localStorage.setItem('settings', 'legacy')
    await writeFile(
      path.join(userDataDir, ORIGIN_MIGRATION_MARKER),
      JSON.stringify({ version: 1, state: 'failed', attempts: 1, error: 'ETIMEDOUT' }),
    )
    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(await marker()).toMatchObject({ state: 'done', attempts: 2 })
    expect(target.localStorage.getItem('settings')).toBe('legacy')
  })

  it('does not restore on a retry what the user cleared after a partial attempt', async () => {
    legacy.localStorage.setItem('settings', 'legacy')
    legacy.opfs.put('a.db', bytes(32))
    legacy.opfs.put('b.db', bytes(48))
    const originalRun = target.run.bind(target)
    let writables = 0
    target.run = (code) =>
      originalRun(
        code.includes('createWritable') && ++writables === 2
          ? code.replace(
              'globalThis.__originMigrationWritable =',
              `${QUOTA_EXCEEDED} globalThis.__originMigrationWritable =`,
            )
          : code,
      )
    await expect(migrate().run).resolves.toMatchObject({ status: 'failed' })
    expect(await marker()).toMatchObject({
      state: 'failed',
      error: 'QuotaExceededError',
      localStorageCopied: true,
      copiedFiles: [],
    })
    // Nothing lands until every file is staged, and the staged copies are removed.
    expect(target.opfs.children.size).toBe(0)
    target.run = originalRun
    // Factory reset or Recovery clears origin storage, not the userData marker.
    target.localStorage.map.clear()

    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.localStorage.length).toBe(0)
    expect(sameBytes(target.opfs.file('a.db')?.data, bytes(32))).toBe(true)
    expect(sameBytes(target.opfs.file('b.db')?.data, bytes(48))).toBe(true)
    expect(await marker()).toMatchObject({ state: 'done', attempts: 2 })

    // Once copied, a file the user deletes stays deleted.
    target.opfs.children.clear()
    await writeFile(
      path.join(userDataDir, ORIGIN_MIGRATION_MARKER),
      JSON.stringify({ ...(await marker()), state: 'failed' }),
    )
    await expect(migrate().run).resolves.toMatchObject({ status: 'empty' })
    expect(target.opfs.children.size).toBe(0)
  })

  it('replaces a database the app created after a failed attempt with the legacy pair', async () => {
    legacy.opfs.put('app.db', bytes(64))
    legacy.opfs.put('app.db.wal', bytes(8, 3))
    const originalRun = target.run.bind(target)
    target.run = (code) =>
      originalRun(
        code.includes('app.db.wal.origin-migration-staging') && code.includes('createWritable')
          ? code.replace(
              'globalThis.__originMigrationWritable =',
              `${QUOTA_EXCEEDED} globalThis.__originMigrationWritable =`,
            )
          : code,
      )
    await expect(migrate().run).resolves.toMatchObject({ status: 'failed' })
    // The database alone never lands without its WAL.
    expect(target.opfs.children.size).toBe(0)
    target.run = originalRun
    // The app booted on the new origin and DuckDB created an empty database.
    target.opfs.put('app.db', bytes(4, 9))

    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(64))
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(8, 3))
  })

  it('copies localStorage before the file listing, so a listing failure keeps settings', async () => {
    legacy.localStorage.setItem('settings', 'legacy')
    legacy.opfs.put('a.db', bytes(32))
    const originalRun = legacy.run.bind(legacy)
    legacy.run = (code) =>
      originalRun(
        code.includes('dir.entries()') ? code.replace('const files = [];', QUOTA_EXCEEDED) : code,
      )
    await expect(migrate().run).resolves.toMatchObject({ status: 'failed' })
    expect(target.localStorage.getItem('settings')).toBe('legacy')
    expect(await marker()).toMatchObject({ localStorageCopied: true, error: 'QuotaExceededError' })
  })

  it('spends an attempt before opening any page, so a crash mid-copy is counted', async () => {
    vi.useFakeTimers()
    const { run, pages } = migrate({ load: () => new Promise(() => {}) })
    await vi.waitFor(() => expect(pages.created).toHaveLength(1))
    expect(await marker()).toMatchObject({ state: 'failed', error: 'interrupted', attempts: 1 })
    await vi.advanceTimersByTimeAsync(ORIGIN_PAGE_STEP_TIMEOUT_MS + 1)
    await expect(run).resolves.toMatchObject({ status: 'failed' })
  })

  it('still copies origin files when the legacy page may not read localStorage', async () => {
    legacy.localStorage.setItem('settings', 'legacy')
    legacy.localStorage.denied = true
    legacy.opfs.put('app.db', bytes(40))
    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.localStorage.length).toBe(0)
    expect(sameBytes(target.opfs.file('app.db')?.data, bytes(40))).toBe(true)
    expect(await marker()).toMatchObject({
      state: 'done',
      localStorageUnreadable: true,
      localStorageKeys: 0,
      files: 1,
    })
  })

  it('drops a WAL the new origin wrote when legacy moves in a database without one', async () => {
    legacy.opfs.put('app.db', bytes(64))
    target.opfs.put('app.db', bytes(4, 9))
    target.opfs.put('app.db.wal', bytes(6, 5))
    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(64))
    expect(target.opfs.file('app.db.wal')).toBeUndefined()
  })

  it('finishes every move once they start, even when the attempt is aborted', async () => {
    legacy.opfs.put('app.db', bytes(64))
    legacy.opfs.put('app.db.wal', bytes(8, 3))
    const controller = new AbortController()
    const originalRun = target.run.bind(target)
    target.run = (code) => {
      if (code.includes('.move(')) controller.abort()
      return originalRun(code)
    }
    await migrate({ signal: controller.signal }).run
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(64))
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(8, 3))
    expect([...target.opfs.children.keys()].sort()).toEqual(['app.db', 'app.db.wal'])
  })

  it('does not expose an unrelated WAL when committing the legacy WAL fails', async () => {
    legacy.opfs.put('app.db', bytes(64))
    legacy.opfs.put('app.db.wal', bytes(8, 3))
    target.opfs.put('app.db', bytes(4, 9))
    target.opfs.put('app.db.wal', bytes(6, 5))
    const originalRun = target.run.bind(target)
    target.run = (code) =>
      originalRun(
        code.includes('.move(') && code.includes('"app.db.wal.origin-migration-staging"')
          ? code.replace(
              'const create = false;',
              "throw Object.assign(new Error('move'), { name: 'NoModificationAllowedError' }); const create = false;",
            )
          : code,
      )

    await expect(migrate().run).resolves.toMatchObject({ status: 'failed' })
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(64))
    expect(target.opfs.file('app.db.wal')).toBeUndefined()
    expect(await marker()).toMatchObject({
      state: 'failed',
      error: 'NoModificationAllowedError',
      copiedFiles: [],
    })

    target.run = originalRun
    // Simulate writes in the target origin after the failed attempt.
    target.opfs.put('app.db', bytes(4, 11))
    target.opfs.put('app.db.wal', bytes(6, 13))
    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(64))
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(8, 3))
    expect(await marker()).toMatchObject({ files: 2, fileBytes: 72 })
  })

  it('commits a database before its WAL regardless of the origin listing order', async () => {
    legacy.opfs.put('app.db.wal', bytes(8, 3))
    legacy.opfs.put('app.db', bytes(64))
    target.opfs.put('app.db', bytes(4, 9))
    target.opfs.put('app.db.wal', bytes(6, 5))
    const originalRun = target.run.bind(target)
    target.run = (code) =>
      originalRun(
        code.includes('.move(') && code.includes('"app.db.origin-migration-staging"')
          ? code.replace(
              'const create = false;',
              "throw Object.assign(new Error('move'), { name: 'NoModificationAllowedError' }); const create = false;",
            )
          : code,
      )

    await expect(migrate().run).resolves.toMatchObject({ status: 'failed' })
    // The target pair stays intact: its WAL was set aside, then put back.
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(4, 9))
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(6, 5))
    expect([...target.opfs.children.keys()].sort()).toEqual(['app.db', 'app.db.wal'])
    expect(await marker()).toMatchObject({ copiedFiles: [] })
  })

  it.each(['app.db', 'app.db.wal'])(
    'retries both files when an older marker recorded only %s',
    async (copiedPath) => {
      legacy.opfs.put('app.db', bytes(64))
      legacy.opfs.put('app.db.wal', bytes(8, 3))
      target.opfs.put('app.db', bytes(4, 9))
      await writeFile(
        path.join(userDataDir, ORIGIN_MIGRATION_MARKER),
        JSON.stringify({
          version: 1,
          state: 'failed',
          attempts: 1,
          localStorageCopied: true,
          copiedFiles: [copiedPath],
          files: 1,
          fileBytes: copiedPath.endsWith('.wal') ? 8 : 64,
        }),
      )

      await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
      expect(target.opfs.file('app.db')?.data).toEqual(bytes(64))
      expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(8, 3))
      expect(await marker()).toMatchObject({ files: 2, fileBytes: 72 })
    },
  )

  it('keeps completed files recorded when a later database pair fails to commit', async () => {
    legacy.opfs.put('completed.bin', bytes(12))
    legacy.opfs.put('app.db', bytes(64))
    legacy.opfs.put('app.db.wal', bytes(8, 3))
    const originalRun = target.run.bind(target)
    target.run = (code) =>
      originalRun(
        code.includes('.move(') && code.includes('"app.db.wal.origin-migration-staging"')
          ? code.replace(
              'const create = false;',
              "throw Object.assign(new Error('move'), { name: 'NoModificationAllowedError' }); const create = false;",
            )
          : code,
      )

    let onDiskBeforeNextGroup: string[] | undefined
    const failingRun = target.run
    target.run = (code) => {
      if (code.includes('.move(') && code.includes('"app.db.origin-migration-staging"')) {
        onDiskBeforeNextGroup = (
          JSON.parse(
            readFileSync(path.join(userDataDir, ORIGIN_MIGRATION_MARKER), 'utf8'),
          ) as OriginMigrationMarker
        ).copiedFiles
      }
      return failingRun(code)
    }
    await expect(migrate().run).resolves.toMatchObject({ status: 'failed' })
    // Written before the next group moved, so a crash there would not restore it later.
    expect(onDiskBeforeNextGroup).toEqual(['completed.bin'])
    expect(await marker()).toMatchObject({
      copiedFiles: ['completed.bin'],
      files: 1,
      fileBytes: 12,
    })
    // No staged copy outlives the failed attempt.
    expect(
      [...target.opfs.children.keys()].filter((name) => name.endsWith('.origin-migration-staging')),
    ).toEqual([])
    target.opfs.children.delete('completed.bin')
    target.run = originalRun

    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.opfs.file('completed.bin')).toBeUndefined()
    expect(await marker()).toMatchObject({ files: 3, fileBytes: 84 })
  })

  it('skips an orphan legacy WAL and still migrates every other file', async () => {
    legacy.opfs.put('app.db.wal', bytes(8, 3))
    legacy.opfs.put('notes.bin', bytes(12))
    target.opfs.put('app.db', bytes(4, 9))
    target.opfs.put('app.db.wal', bytes(6, 5))

    await expect(migrate().run).resolves.toMatchObject({
      status: 'migrated',
      marker: { state: 'done', copiedFiles: ['notes.bin'], files: 1, fileBytes: 12 },
    })
    expect(target.opfs.file('notes.bin')?.data).toEqual(bytes(12))
    // The orphan never lands next to the target's own database.
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(4, 9))
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(6, 5))
  })

  it('keeps both target files when setting their WAL aside fails, then retries the pair', async () => {
    legacy.opfs.put('app.db', bytes(64))
    legacy.opfs.put('app.db.wal', bytes(8, 3))
    target.opfs.put('app.db', bytes(4, 9))
    target.opfs.put('app.db.wal', bytes(6, 5))
    const originalRun = target.run.bind(target)
    target.run = (code) =>
      originalRun(
        code.includes('.move(') && code.includes('"app.db.wal.origin-migration-previous"')
          ? code.replace(
              'const create = false;',
              "throw Object.assign(new Error('move'), { name: 'NoModificationAllowedError' }); const create = false;",
            )
          : code,
      )

    await expect(migrate().run).resolves.toMatchObject({
      status: 'failed',
      marker: { copiedFiles: [] },
    })
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(4, 9))
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(6, 5))

    target.run = originalRun
    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(64))
    expect(target.opfs.file('app.db.wal')?.data).toEqual(bytes(8, 3))
  })

  it('keeps same-named database pairs in separate directories', async () => {
    for (const [index, directory] of ['first', 'second'].entries()) {
      legacy.opfs.put(`${directory}/local.db.wal`, bytes(8, index + 3))
      legacy.opfs.put(`${directory}/local.db`, bytes(32, index + 5))
    }

    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    for (const [index, directory] of ['first', 'second'].entries()) {
      expect(target.opfs.file(`${directory}/local.db`)?.data).toEqual(bytes(32, index + 5))
      expect(target.opfs.file(`${directory}/local.db.wal`)?.data).toEqual(bytes(8, index + 3))
    }
    expect((await marker()).copiedFiles.sort()).toEqual([
      'first/local.db',
      'first/local.db.wal',
      'second/local.db',
      'second/local.db.wal',
    ])
    expect(await marker()).toMatchObject({ files: 4, fileBytes: 80 })
  })

  it('reports staged bytes against the total as the copy runs', async () => {
    legacy.opfs.put('app.db', bytes(ORIGIN_MIGRATION_CHUNK_BYTES + 5))
    legacy.opfs.put('app.db.wal', bytes(7))
    const total = ORIGIN_MIGRATION_CHUNK_BYTES + 12
    const onProgress = vi.fn()
    await expect(migrate({ onProgress }).run).resolves.toMatchObject({ status: 'migrated' })
    const done = onProgress.mock.calls.map(([value, of]) => (expect(of).toBe(total), value))
    expect(done).toEqual([...done].sort((a, b) => a - b))
    expect(done.at(-1)).toBe(total)
  })

  it('marks the last failed attempt final, then skips', async () => {
    legacy.localStorage.setItem('settings', 'legacy')
    const failingLoad = async (kind: 'legacy' | 'target') => {
      if (kind === 'target') throw Object.assign(new Error('load'), { code: 'ERR_FAILED' })
    }
    const outcomes: unknown[] = []
    for (let attempt = 1; attempt <= ORIGIN_MIGRATION_MAX_ATTEMPTS + 1; attempt += 1) {
      const result = await migrate({ load: failingLoad }).run
      outcomes.push(result.status === 'failed' ? result.final : result.status)
    }
    expect(outcomes).toEqual([false, false, true, 'skipped'])
  })

  it('treats an unreadable marker as no marker', async () => {
    await writeFile(path.join(userDataDir, ORIGIN_MIGRATION_MARKER), '{not json')
    legacy.localStorage.setItem('settings', 'legacy')
    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect(await marker()).toMatchObject({ state: 'done', attempts: 1 })
  })

  it('fails the attempt when a copy is cancelled, without a partial file', async () => {
    legacy.opfs.put('app.db', bytes(ORIGIN_MIGRATION_CHUNK_BYTES * 3))
    const controller = new AbortController()
    const originalRun = target.run.bind(target)
    target.run = (code) => {
      if (code.includes('__originMigrationWritable.write(')) controller.abort()
      return originalRun(code)
    }
    const { run } = migrate({ signal: controller.signal })
    await expect(run).resolves.toMatchObject({ status: 'failed', marker: { error: 'AbortError' } })
    expect(target.opfs.file('app.db')?.data.byteLength ?? 0).toBe(0)
  })

  it('fails a stalled page step after the step timeout', async () => {
    vi.useFakeTimers()
    const { run, pages } = migrate({ load: () => new Promise(() => {}) })
    await vi.waitFor(() => expect(pages.created).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(ORIGIN_PAGE_STEP_TIMEOUT_MS + 1)
    await expect(run).resolves.toMatchObject({ status: 'failed', marker: { error: 'ETIMEDOUT' } })
    expect(pages.created[0]?.destroyed).toBe(true)
  })

  it('opens sandboxed, hidden pages that cannot navigate or open windows', async () => {
    legacy.localStorage.setItem('a', 'b')
    const { run, pages } = migrate()
    await run
    for (const window of pages.created) {
      expect(window.options).toMatchObject({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      })
      expect(window.options.webPreferences?.preload).toBeUndefined()
      expect(window.openHandler?.()).toEqual({ action: 'deny' })
      for (const name of ['will-navigate', 'will-redirect']) {
        const preventDefault = vi.fn()
        window.handlers.get(name)?.({ preventDefault })
        expect(preventDefault).toHaveBeenCalled()
      }
    }
  })
  it('loads the target URL in the given session and flushes that session', async () => {
    legacy.localStorage.setItem('a', 'b')
    const { run, pages, flush, session } = migrate()
    await run
    expect(pages.created.map((window) => window.loadedUrl?.endsWith('blank.html'))).toEqual([
      true,
      true,
    ])
    expect(pages.created[1]?.loadedUrl).toBe(BLANK)
    for (const window of pages.created) {
      expect(window.options.webPreferences?.session).toBe(session)
    }
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('keeps its marker under the given name, so an app can keep an existing one', async () => {
    legacy.localStorage.setItem('a', 'b')
    await expect(
      migrate({ markerFile: 'renderer-origin-migration.json' }).run,
    ).resolves.toMatchObject({ status: 'migrated' })
    expect(await marker('renderer-origin-migration.json')).toMatchObject({ state: 'done' })
    await expect(readFile(path.join(userDataDir, ORIGIN_MIGRATION_MARKER))).rejects.toThrow()
    await expect(migrate({ markerFile: 'renderer-origin-migration.json' }).run).resolves.toEqual({
      status: 'skipped',
    })
  })

  it.each(['../marker.json', 'nested/marker.json', '..', '.'])(
    'refuses marker name %s before touching disk',
    async (markerFile) => {
      const { run, pages } = migrate({ markerFile })
      await expect(run).rejects.toThrow(TypeError)
      expect(pages.created).toHaveLength(0)
    },
  )

  it('refuses an empty marker name, which would point at userData itself', async () => {
    await expect(
      runOriginMigration({
        userDataDir,
        markerFile: '',
        openLegacy: () => Promise.reject(new Error('opened')),
        openTarget: () => Promise.reject(new Error('opened')),
        flush: () => {},
      }),
    ).rejects.toThrow(TypeError)
  })

  it('keeps the unreadable-localStorage flag across a retry', async () => {
    await writeFile(
      path.join(userDataDir, ORIGIN_MIGRATION_MARKER),
      JSON.stringify({
        version: 1,
        state: 'failed',
        attempts: 1,
        localStorageKeys: 2,
        localStorageCopied: true,
        localStorageUnreadable: true,
        copiedFiles: [],
      }),
    )
    await expect(migrate().run).resolves.toMatchObject({ status: 'empty' })
    expect(await marker()).toMatchObject({ state: 'done', localStorageUnreadable: true })
  })

  it('removes a WAL set aside by an attempt that crashed before the database moved', async () => {
    legacy.opfs.put('app.db', bytes(64))
    target.opfs.put('app.db', bytes(4, 9))
    target.opfs.put('app.db.wal.origin-migration-previous', bytes(6, 5))
    await expect(migrate().run).resolves.toMatchObject({ status: 'migrated' })
    expect([...target.opfs.children.keys()]).toEqual(['app.db'])
  })

  it('refuses a file:// target, which would copy the origin onto itself', async () => {
    const pages = fakeWindowClass({ legacy, target })
    await expect(
      migrateOrigin({
        userDataDir,
        BrowserWindow: pages.Window,
        session: { flushStorageData: () => {} } as unknown as Session,
        targetUrl: 'file:///tmp/blank.html',
      }),
    ).rejects.toThrow(TypeError)
    expect(pages.created).toHaveLength(0)
  })

  it('copies only the stores it is given', async () => {
    legacy.localStorage.setItem('a', 'b')
    legacy.opfs.put('app.db', bytes(16))
    await expect(migrate({ stores: ['opfs'] }).run).resolves.toMatchObject({ status: 'migrated' })
    expect(target.localStorage.length).toBe(0)
    expect(target.opfs.file('app.db')?.data).toEqual(bytes(16))
    expect(await marker()).toMatchObject({ localStorageCopied: false, files: 1 })

    await rm(path.join(userDataDir, ORIGIN_MIGRATION_MARKER))
    target.opfs.children.clear()
    await expect(migrate({ stores: ['localStorage'] }).run).resolves.toMatchObject({
      status: 'migrated',
    })
    expect(target.localStorage.getItem('a')).toBe('b')
    expect(target.opfs.children.size).toBe(0)
  })
})
