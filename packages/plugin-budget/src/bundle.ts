/**
 * Bundle-size measurement: bytes on disk for the files a budget names. Needs no Electron.
 *
 * @module
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import type { BundleEntryBudget } from './budget.js'
import type { BundleEntryMeasurement } from './run.js'

async function listFiles(target: string): Promise<string[]> {
  const info = await stat(target)
  if (info.isFile()) return [target]
  if (!info.isDirectory()) return []
  const entries = await readdir(target, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
}

/**
 * Measure each entry under `root`. A missing path, or one with no matching file, is reported as
 * `unavailable` instead of zero bytes: an empty measurement must never read as "within budget".
 */
export async function measureBundle(
  root: string,
  entries: readonly BundleEntryBudget[],
): Promise<{ entries: BundleEntryMeasurement[] }> {
  const measured: BundleEntryMeasurement[] = []
  for (const entry of entries) {
    const target = path.resolve(root, entry.path)
    const gzip = entry.gzip === true
    const base = { id: entry.name ?? entry.path, path: target, gzip }
    let files: string[]
    try {
      files = await listFiles(target)
    } catch {
      measured.push({ ...base, files: 0, bytes: 0, unavailable: `${target} does not exist` })
      continue
    }
    const extensions = entry.extensions
    const matching =
      extensions === undefined
        ? files
        : files.filter((file) => extensions.includes(path.extname(file)))
    if (matching.length === 0) {
      measured.push({ ...base, files: 0, bytes: 0, unavailable: `no file matched under ${target}` })
      continue
    }
    let bytes = 0
    for (const file of matching) {
      bytes += gzip ? gzipSync(await readFile(file)).byteLength : (await stat(file)).size
    }
    measured.push({ ...base, files: matching.length, bytes })
  }
  return { entries: measured }
}
