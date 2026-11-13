import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { STAGING_SUFFIX } from './scripts.js'

/**
 * One-time copy of renderer storage from one origin to another; Chromium keys storage by origin.
 * The legacy copy is left on disk. Keys the new origin holds are never overwritten. Files are
 * staged, then moved database-first with any old target WAL removed. A database and its WAL count
 * as copied only after both moves succeed; until then, a retry copies both again over files the
 * app created after a failed attempt. The marker's progress keeps retries from restoring a
 * completed group the user deleted since.
 */

export const ORIGIN_MIGRATION_MARKER = 'origin-migration.json'
export const ORIGIN_MIGRATION_MAX_ATTEMPTS = 3
export const ORIGIN_MIGRATION_CHUNK_BYTES = 1 << 20

export type OriginStore = 'localStorage' | 'opfs'
export const ORIGIN_STORES: readonly OriginStore[] = ['localStorage', 'opfs']

export interface OriginFile {
  readonly path: string[]
  readonly size: number
}

export interface LegacyOriginReader {
  /** Null when Chromium denies the page its localStorage, as for file:// without the fuse. */
  readLocalStorage: () => Promise<Array<[string, string]> | null>
  listFiles: () => Promise<OriginFile[]>
  readChunk: (path: readonly string[], offset: number, length: number) => Promise<Uint8Array>
  close: () => void
}

export interface TargetOriginWriter {
  /** Sets each key the origin does not hold yet; resolves with how many it set. */
  writeLocalStorage: (entries: Array<[string, string]>) => Promise<number>
  fileSize: (path: readonly string[]) => Promise<number | null>
  beginFile: (path: readonly string[]) => Promise<void>
  writeChunk: (bytes: Uint8Array) => Promise<void>
  endFile: () => Promise<void>
  abortFile: () => Promise<void>
  /** Moves a staged file over `name` in the same folder, replacing what is there. */
  commitFile: (path: readonly string[], name: string) => Promise<void>
  /** Removes a file; a missing one is not an error. */
  removeFile: (path: readonly string[]) => Promise<void>
  close: () => void
}

export interface OriginMigrationMarker {
  version: 1
  state: 'done' | 'failed'
  attempts: number
  localStorageKeys: number
  files: number
  fileBytes: number
  durationMs: number
  error?: string
  localStorageCopied: boolean
  localStorageUnreadable?: boolean
  /** Paths joined with `/`. */
  copiedFiles: string[]
}

export type OriginMigrationResult =
  | { status: 'skipped' }
  | { status: 'empty' | 'migrated'; marker: OriginMigrationMarker }
  /** `final` when no attempt is left, so the next launch skips the copy. */
  | { status: 'failed'; marker: OriginMigrationMarker; final: boolean }

export interface OriginMigrationDeps {
  userDataDir: string
  openLegacy: () => Promise<LegacyOriginReader>
  openTarget: () => Promise<TargetOriginWriter>
  /** Writes pending localStorage to disk before the marker records success. */
  flush: () => Promise<void> | void
  /** A file name inside `userDataDir`. Default `origin-migration.json`. */
  markerFile?: string
  /** Default both. */
  stores?: readonly OriginStore[]
  /** Bytes staged so far out of the bytes this attempt copies. */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
  now?: () => number
}

async function readMarker(markerPath: string): Promise<OriginMigrationMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as Partial<OriginMigrationMarker>
    if (parsed?.version !== 1 || (parsed.state !== 'done' && parsed.state !== 'failed')) return null
    return {
      ...(parsed as OriginMigrationMarker),
      attempts: Number.isInteger(parsed.attempts) ? (parsed.attempts as number) : 1,
      localStorageCopied: parsed.localStorageCopied === true,
      copiedFiles: Array.isArray(parsed.copiedFiles)
        ? parsed.copiedFiles.filter((entry): entry is string => typeof entry === 'string')
        : [],
    }
  } catch {
    return null
  }
}

async function writeMarker(markerPath: string, marker: OriginMigrationMarker): Promise<void> {
  const temporary = `${markerPath}.tmp`
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, markerPath)
}

/** An error name or code, never a message: messages can carry paths. */
function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const { code, name } = error as { code?: unknown; name?: unknown }
    if (typeof code === 'string' && /^[\w-]{1,64}$/.test(code)) return code
    if (typeof name === 'string' && /^\w{1,64}$/.test(name)) return name
  }
  return 'unknown'
}

const WAL_SUFFIX = '.wal'
/** Where the target's own WAL waits while the legacy database moves in. */
const PREVIOUS_SUFFIX = '.origin-migration-previous'

const keyOf = (file: OriginFile) => file.path.join('/')
const nameOf = (file: OriginFile) => file.path.at(-1) ?? ''
const siblingPath = (file: OriginFile, suffix: string) => [
  ...file.path.slice(0, -1),
  `${nameOf(file)}${suffix}`,
]
const stagingPath = (file: OriginFile) => siblingPath(file, STAGING_SUFFIX)

/**
 * A database and its WAL share retry ownership, regardless of listing order. A WAL whose database
 * is gone is never copied: it is useless alone and could replay onto another database.
 */
function fileGroups(files: OriginFile[]): OriginFile[][] {
  const byKey = new Map(files.map((file) => [keyOf(file), file]))
  const groups: OriginFile[][] = []
  for (const file of files) {
    const key = keyOf(file)
    if (key.endsWith(WAL_SUFFIX)) continue
    const wal = byKey.get(`${key}${WAL_SUFFIX}`)
    groups.push(wal ? [file, wal] : [file])
  }
  return groups
}

/**
 * Moves one staged group in, database first. The target's own WAL is set aside rather than
 * deleted, so a failed database move leaves the target pair intact; once the legacy database
 * lands, that WAL no longer matches and goes.
 */
async function commitGroup(target: TargetOriginWriter, group: OriginFile[]): Promise<void> {
  const [database, wal] = group as [OriginFile, OriginFile | undefined]
  const targetWal = siblingPath(database, WAL_SUFFIX)
  const aside = siblingPath(database, `${WAL_SUFFIX}${PREVIOUS_SUFFIX}`)
  const hadWal = (await target.fileSize(targetWal)) !== null
  if (hadWal) await target.commitFile(targetWal, aside.at(-1) ?? '')
  try {
    await target.commitFile(stagingPath(database), nameOf(database))
  } catch (error) {
    if (hadWal) {
      await target.commitFile(aside, `${nameOf(database)}${WAL_SUFFIX}`).catch(() => undefined)
    }
    throw error
  }
  if (hadWal) await target.removeFile(aside).catch(() => undefined)
  if (wal) await target.commitFile(stagingPath(wal), nameOf(wal))
}

async function stageFile(
  legacy: LegacyOriginReader,
  target: TargetOriginWriter,
  file: OriginFile,
  onChunk: (length: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const staging = stagingPath(file)
  await target.beginFile(staging)
  try {
    for (let offset = 0; offset < file.size;) {
      signal?.throwIfAborted()
      const length = Math.min(ORIGIN_MIGRATION_CHUNK_BYTES, file.size - offset)
      const bytes = await legacy.readChunk(file.path, offset, length)
      if (bytes.byteLength !== length) {
        throw Object.assign(new Error('Legacy file changed during migration'), { code: 'ESIZE' })
      }
      await target.writeChunk(bytes)
      offset += length
      onChunk(length)
    }
    await target.endFile()
  } catch (error) {
    await target.abortFile().catch(() => undefined)
    throw error
  }
  if ((await target.fileSize(staging)) !== file.size) {
    throw Object.assign(new Error('Copied file size differs'), { code: 'ESIZE' })
  }
}

/** Runs one attempt with injected origin access. Never rejects once the marker path is valid. */
export async function runOriginMigration(
  deps: OriginMigrationDeps,
): Promise<OriginMigrationResult> {
  const markerFile = deps.markerFile ?? ORIGIN_MIGRATION_MARKER
  if (markerFile !== path.basename(markerFile) || markerFile === '.' || markerFile === '..') {
    throw new TypeError('markerFile must be a file name, not a path')
  }
  const stores = new Set(deps.stores ?? ORIGIN_STORES)
  const now = deps.now ?? Date.now
  const markerPath = path.join(deps.userDataDir, markerFile)
  const previous = await readMarker(markerPath)
  if (
    previous &&
    (previous.state === 'done' || previous.attempts >= ORIGIN_MIGRATION_MAX_ATTEMPTS)
  ) {
    return { status: 'skipped' }
  }

  const started = now()
  // Recorded as interrupted up front, so a crash mid-copy still spends an attempt.
  const marker: OriginMigrationMarker = {
    version: 1,
    state: 'failed',
    error: 'interrupted',
    attempts: (previous?.attempts ?? 0) + 1,
    localStorageKeys: previous?.localStorageKeys ?? 0,
    files: previous?.files ?? 0,
    fileBytes: previous?.fileBytes ?? 0,
    durationMs: 0,
    localStorageCopied: previous?.localStorageCopied ?? false,
    copiedFiles: [...(previous?.copiedFiles ?? [])],
  }
  // No disk probe: Chromium creates Local Storage before any page loads, so only the legacy
  // origin itself can say whether it holds data.
  let legacy: LegacyOriginReader | undefined
  let target: TargetOriginWriter | undefined
  try {
    await writeMarker(markerPath, marker)
    legacy = await deps.openLegacy()
    // Settings go first, so a failed file step cannot leave the app to boot on defaults.
    if (stores.has('localStorage') && !marker.localStorageCopied) {
      const entries = await legacy.readLocalStorage()
      if (entries === null) marker.localStorageUnreadable = true
      if (entries && entries.length > 0) {
        target = await deps.openTarget()
        marker.localStorageKeys = await target.writeLocalStorage(entries)
        await deps.flush()
      }
      marker.localStorageCopied = true
      await writeMarker(markerPath, marker)
    }
    const copied = new Set(marker.copiedFiles)
    const listed = stores.has('opfs') ? await legacy.listFiles() : []
    const pendingGroups = fileGroups(listed).filter((group) =>
      group.some((file) => !copied.has(keyOf(file))),
    )
    const files = pendingGroups.flat()
    if (files.length > 0) target ??= await deps.openTarget()
    const empty = !target
    if (target) {
      const writer = target
      const reader = legacy
      const staged: OriginFile[] = []
      const total = files.reduce((sum, file) => sum + file.size, 0)
      let done = 0
      const onChunk = (length: number) => deps.onProgress?.((done += length), total)
      try {
        for (const file of files) {
          deps.signal?.throwIfAborted()
          staged.push(file)
          await stageFile(reader, writer, file, onChunk, deps.signal)
        }
      } catch (error) {
        await Promise.all(
          staged.map((file) => writer.removeFile(stagingPath(file)).catch(() => undefined)),
        )
        throw error
      }
      // Past this point the moves run to the end, so an abort cannot split a database from its WAL.
      deps.signal?.throwIfAborted()
      let committed = 0
      try {
        for (const group of pendingGroups) {
          await commitGroup(writer, group)
          committed += 1
          // Recorded per group, so a crash after it never restores this group over later changes.
          // An older failed marker may already name one of its files; that one is not counted twice.
          for (const file of group) {
            if (copied.has(keyOf(file))) continue
            copied.add(keyOf(file))
            marker.files += 1
            marker.fileBytes += file.size
            marker.copiedFiles.push(keyOf(file))
          }
          await writeMarker(markerPath, marker)
        }
      } catch (error) {
        const left = pendingGroups.slice(committed).flat()
        await Promise.all(
          left.map((file) => writer.removeFile(stagingPath(file)).catch(() => undefined)),
        )
        throw error
      }
    }
    marker.state = 'done'
    delete marker.error
    marker.durationMs = Math.round(now() - started)
    await writeMarker(markerPath, marker)
    return { status: empty ? 'empty' : 'migrated', marker }
  } catch (error) {
    marker.state = 'failed'
    marker.error = errorCode(error)
    marker.durationMs = Math.round(now() - started)
    await writeMarker(markerPath, marker).catch(() => undefined)
    return { status: 'failed', marker, final: marker.attempts >= ORIGIN_MIGRATION_MAX_ATTEMPTS }
  } finally {
    legacy?.close()
    target?.close()
  }
}
