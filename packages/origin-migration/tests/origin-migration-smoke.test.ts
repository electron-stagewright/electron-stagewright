/**
 * Real-Electron origin-migration smoke: seed a profile on file://, migrate it to app://fixture,
 * compare hashes, then relaunch to prove the copy neither repeats nor reverts, and that the
 * file:// copy is intact. Opt-in via `STAGEWRIGHT_E2E=1`.
 */

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from '@electron-stagewright/core'
import { afterAll, describe, expect, it } from 'vitest'

import { ORIGIN_MIGRATION_MARKER } from '../src/index.js'

const TITLE = 'origin-migration fixture'
const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'origin-app',
  'main.js',
)

const closers: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined)
})

// Deterministic bytes; the page builds the same ones from this source, since eval code is capped.
function payload(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let state = seed
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const database = payload(3 * 1024 * 1024 + 517, 11)
const wal = payload(4096, 17)
const nested = payload(4096, 29)
const sentinel = `ñ ✓ "quoted" ${'x'.repeat(50_000)}`

interface OriginState {
  readonly origin: string
  readonly storage: Record<string, string>
  readonly files: Record<string, string>
}

// Values come back as hashes: eval results are size-capped.
const READ_ORIGIN = `
  const hex = async (buffer) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), (b) => b.toString(16).padStart(2, '0')).join('');
  const storage = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    storage[key] = await hex(new TextEncoder().encode(localStorage.getItem(key)));
  }
  const files = {};
  const pending = [{ dir: await navigator.storage.getDirectory(), prefix: '' }];
  while (pending.length) {
    const { dir, prefix } = pending.pop();
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') pending.push({ dir: handle, prefix: prefix + name + '/' });
      else {
        files[prefix + name] = await hex(await (await handle.getFile()).arrayBuffer());
      }
    }
  }
  return { origin: location.origin, storage, files };`

describe('origin migration smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'migrates a file:// profile once, never reverts it, and leaves the source intact',
    async () => {
      const profile = await mkdtemp(path.join(tmpdir(), 'sw-origin-smoke-'))
      closers.push(() => rm(profile, { recursive: true, force: true }))
      const server = await createServer({ allowEval: true })
      closers.push(() => server.close())
      const dispatch = async (name: string, args: Record<string, unknown>) => {
        const result = (await server.dispatcher.dispatch(name, args)) as Record<string, unknown>
        expect(result, `${name}: ${JSON.stringify(result).slice(0, 500)}`).toMatchObject({
          ok: true,
        })
        return result
      }

      const launch = async (mode: 'legacy' | 'current') => {
        const launched = await dispatch('electron_launch', {
          main: MAIN,
          env: { ORIGIN_SMOKE_MODE: mode, ORIGIN_SMOKE_PROFILE: profile },
          timeoutMs: 45_000,
          readyTimeoutMs: 10_000,
        })
        const sessionId = (launched['session_id'] ??
          (launched['_meta'] as { session_id?: string }).session_id) as string
        const renderer = async <T>(code: string) =>
          (await dispatch('electron_eval_renderer', { sessionId, code }))['result'] as T
        const main = async <T>(code: string) =>
          (await dispatch('electron_eval_main', { sessionId, code }))['result'] as T
        // Wait in main for the migration and the app window's load, then drive that window:
        // the hidden migration pages may have been the first surface the session saw.
        await main(`const { BrowserWindow } = arguments[0];
          const ready = () => globalThis.originSmoke.status !== 'pending' &&
            BrowserWindow.getAllWindows().some((w) => w.getTitle() === ${JSON.stringify(TITLE)} && !w.webContents.isLoading());
          while (!ready()) await new Promise((resolve) => setTimeout(resolve, 50));`)
        await dispatch('electron_switch_window', { sessionId, windowTitle: TITLE })
        return {
          renderer,
          main,
          read: () => renderer<OriginState>(READ_ORIGIN),
          outcome: () => main<{ status: string }>('return globalThis.originSmoke'),
          // Write localStorage to disk before the process exits.
          stop: async () => {
            await main('await arguments[0].session.defaultSession.flushStorageData()')
            await dispatch('electron_stop', { sessionId })
          },
        }
      }
      const markerPath = path.join(profile, ORIGIN_MIGRATION_MARKER)
      const readMarker = async () =>
        JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>

      // 1. An older build stores settings and OPFS files on file://.
      let app = await launch('legacy')
      await app.renderer(`
        const payload = ${payload.toString()};
        const write = async (dir, name, bytes) => {
          const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await writable.write(bytes);
          await writable.close();
        };
        localStorage.setItem('settings', '{"language":"es"}');
        localStorage.setItem('sentinel', ${JSON.stringify(sentinel)});
        const root = await navigator.storage.getDirectory();
        await write(root, 'app.db', payload(${database.length}, 11));
        await write(root, 'app.db.wal', payload(${wal.length}, 17));
        const sub = await (await root.getDirectoryHandle('data', { create: true }))
          .getDirectoryHandle('nested', { create: true });
        await write(sub, 'b.bin', payload(${nested.length}, 29));`)
      const seeded = await app.read()
      expect(seeded.origin).toBe('file://')
      expect(seeded.storage).toEqual({
        settings: sha256(new TextEncoder().encode('{"language":"es"}')),
        sentinel: sha256(new TextEncoder().encode(sentinel)),
      })
      expect(seeded.files).toEqual({
        'app.db': sha256(database),
        'app.db.wal': sha256(wal),
        'data/nested/b.bin': sha256(nested),
      })
      await app.stop()
      await expect(readFile(markerPath)).rejects.toThrow()

      // 2. The new build migrates on its first launch.
      app = await launch('current')
      expect(await app.outcome()).toMatchObject({ status: 'migrated' })
      const migrated = await app.read()
      expect(migrated.origin).toBe('app://fixture')
      expect(migrated.storage).toEqual(seeded.storage)
      expect(migrated.files).toEqual(seeded.files)
      const marker = await readMarker()
      expect(marker).toMatchObject({
        state: 'done',
        attempts: 1,
        localStorageKeys: 2,
        files: 3,
        fileBytes: database.length + wal.length + nested.length,
      })
      // The user changes a setting and deletes a file on the new origin.
      await app.renderer(`
        localStorage.setItem('sentinel', 'changed on app://');
        const root = await navigator.storage.getDirectory();
        const data = await (await root.getDirectoryHandle('data')).getDirectoryHandle('nested');
        await data.removeEntry('b.bin');`)
      await app.stop()

      // 3. Later launches neither migrate again nor bring anything back.
      for (let round = 0; round < 2; round += 1) {
        app = await launch('current')
        expect(await app.outcome()).toEqual({ status: 'skipped' })
        const again = await app.read()
        expect(again.storage['sentinel']).toBe(
          sha256(new TextEncoder().encode('changed on app://')),
        )
        expect(again.files['data/nested/b.bin']).toBeUndefined()
        expect(again.files['app.db']).toBe(sha256(database))
        await app.stop()
      }
      expect(await readMarker()).toEqual(marker)

      // 4. The file:// copy is untouched, so an older build still opens with its data.
      app = await launch('legacy')
      const downgrade = await app.read()
      expect(downgrade.storage).toEqual(seeded.storage)
      expect(downgrade.files).toEqual(seeded.files)
      await app.stop()
    },
    240_000,
  )
})
