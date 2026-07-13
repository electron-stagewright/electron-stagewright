/** Root-confined filesystem operations for visual baselines and diagnostic artifacts. */

import { randomUUID } from 'node:crypto'
import { mkdir, lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class VisualPathError extends Error {
  override readonly name = 'VisualPathError'
}

export class VisualBaselineMissingError extends Error {
  override readonly name = 'VisualBaselineMissingError'
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/

/** Validate the leaf name before it ever participates in a filesystem path. */
export function assertVisualName(name: string): void {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
    throw new VisualPathError(
      'Visual baseline names must be 1–120 letters, numbers, dots, underscores, or hyphens and cannot be paths.',
    )
  }
}

/** Resolve an operator-configured root, creating it only for a write operation. */
export async function canonicalRoot(root: string, writable: boolean): Promise<string> {
  if (!path.isAbsolute(root)) {
    throw new VisualPathError(`Configured visual root must be absolute: ${root}`)
  }
  if (writable) await mkdir(root, { recursive: true })
  let stat
  try {
    stat = await lstat(root)
  } catch (cause) {
    if (isNotFound(cause)) {
      if (!writable)
        throw new VisualBaselineMissingError(`No visual baseline root exists at ${root}.`)
      throw new VisualPathError(`Configured visual root does not exist: ${root}`)
    }
    throw cause
  }
  if (!stat.isDirectory())
    throw new VisualPathError(`Configured visual root is not a directory: ${root}`)
  return realpath(root)
}

/** Read a regular non-symlink file from a canonical root, rejecting an escape at every step. */
export async function readConfinedFile(root: string, filename: string): Promise<Buffer> {
  const target = containedPath(root, filename)
  let stat
  try {
    stat = await lstat(target)
  } catch (cause) {
    if (isNotFound(cause))
      throw new VisualBaselineMissingError(`No baseline exists at ${filename}.`)
    throw cause
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new VisualPathError(`Visual file must be a regular non-symlink file: ${filename}`)
  }
  const canonical = await realpath(target)
  assertContained(root, canonical)
  return readFile(canonical)
}

/** Write a complete file through a unique sibling temporary and atomic rename. */
export async function writeConfinedAtomically(
  root: string,
  filename: string,
  contents: string | Buffer,
): Promise<string> {
  const target = containedPath(root, filename)
  const temp = containedPath(root, `.${filename}.${randomUUID()}.tmp`)
  await writeFile(temp, contents, { flag: 'wx' })
  try {
    // rename replaces a symlink itself rather than following it, keeping the write inside root.
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
  return target
}

/**
 * Publish the actual and diff images as one directory replacement so a failed
 * mismatch write never leaves a misleading half-set of review evidence.
 */
export async function writeConfinedMismatchPairAtomically(
  root: string,
  directoryName: string,
  actual: Buffer,
  diff: Buffer,
): Promise<{ readonly actualPath: string; readonly diffPath: string }> {
  const target = containedPath(root, directoryName)
  const temp = containedPath(root, `.${directoryName}.${randomUUID()}.tmp`)
  const actualPath = path.join(target, 'actual.png')
  const diffPath = path.join(target, 'diff.png')

  await mkdir(temp)
  try {
    await writeFile(path.join(temp, 'actual.png'), actual, { flag: 'wx' })
    await writeFile(path.join(temp, 'diff.png'), diff, { flag: 'wx' })
    await rename(temp, target)
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
  return { actualPath, diffPath }
}

/** Unique artifact stem keeps concurrent mismatch evidence separate. */
export function artifactStem(name: string, now: number): string {
  assertVisualName(name)
  return `${name}--${new Date(now).toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
}

function containedPath(root: string, filename: string): string {
  if (path.basename(filename) !== filename) {
    throw new VisualPathError(`Visual path must be a root-level file: ${filename}`)
  }
  const target = path.resolve(root, filename)
  assertContained(root, target)
  return target
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new VisualPathError(`Visual path escapes its configured root: ${target}`)
  }
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT'
}
