/**
 * Reproducibility metadata for a local competitive-benchmark artifact. It deliberately records
 * executable identity, fixture hashes, checkout state, and host facts without collecting the tool
 * payloads themselves (which can contain private application data in real benchmarks).
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { cpus, release, type } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BENCH_APP_MAIN, type ServerTarget } from './harness.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '../../..')

/** A content hash plus repo-relative label for a fixture or source file that defines the benchmark. */
export interface FileFingerprint {
  readonly path: string
  readonly sha256: string
}

/** Environment and source facts required to reproduce or correctly qualify a local observation. */
export interface ComparisonProvenance {
  readonly environment: {
    readonly node: string
    readonly platform: string
    readonly arch: string
    readonly osType: string
    readonly osRelease: string
    readonly cpuModel: string | null
    readonly cpuCount: number
  }
  readonly checkout: {
    readonly commit: string | null
    readonly dirty: boolean | null
  }
  readonly fixture: readonly FileFingerprint[]
  readonly targets: ReadonlyArray<{
    readonly name: string
    readonly command: string
    readonly args: readonly string[]
    /** Names of explicit child-environment values; values stay out of the artifact. */
    readonly childEnvironment: readonly string[]
    /** SHA-256 of the executable entry passed to Node, when it is a local file. */
    readonly entrySha256: string | null
    readonly provenance: ServerTarget['provenance']
  }>
}

/** SHA-256 a benchmark-defining file, returning a repo-relative label for stable artifacts. */
async function fingerprint(file: string): Promise<FileFingerprint> {
  const content = await readFile(file)
  return {
    path: path.relative(REPOSITORY_ROOT, file),
    sha256: createHash('sha256').update(content).digest('hex'),
  }
}

/** Hash a target's first argument only when it is a readable local entry file. */
async function entryHash(target: ServerTarget): Promise<string | null> {
  const entry = target.args[0]
  if (entry === undefined || !path.isAbsolute(entry)) return null
  try {
    return createHash('sha256')
      .update(await readFile(entry))
      .digest('hex')
  } catch {
    return null
  }
}

/** Read a Git fact without making artifact creation fail in source archives or exported trees. */
function git(args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

/** Build the immutable provenance block written beside raw warmups and retained observations. */
export async function collectComparisonProvenance(
  targets: readonly ServerTarget[],
): Promise<ComparisonProvenance> {
  const uniqueTargets = [...new Map(targets.map((target) => [target.name, target])).values()]
  const cpu = cpus()
  const dirtyOutput = git(['status', '--porcelain', '--untracked-files=no'])
  return {
    environment: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osType: type(),
      osRelease: release(),
      cpuModel: cpu[0]?.model ?? null,
      cpuCount: cpu.length,
    },
    checkout: {
      commit: git(['rev-parse', 'HEAD']),
      dirty: dirtyOutput === null ? null : dirtyOutput.length > 0,
    },
    fixture: await Promise.all([
      fingerprint(BENCH_APP_MAIN),
      fingerprint(path.join(path.dirname(BENCH_APP_MAIN), 'index.html')),
      fingerprint(path.join(path.dirname(BENCH_APP_MAIN), 'server.js')),
      fingerprint(path.join(HERE, 'adapters.ts')),
      fingerprint(path.join(HERE, 'comparison.ts')),
      fingerprint(path.join(HERE, 'harness.ts')),
      fingerprint(path.join(HERE, 'provenance.ts')),
      fingerprint(path.join(HERE, 'run-bench.ts')),
      fingerprint(path.join(HERE, 'tokenizer.ts')),
    ]),
    targets: await Promise.all(
      uniqueTargets.map(async (target) => ({
        name: target.name,
        command: target.command,
        args: target.args,
        childEnvironment: Object.keys(target.env ?? {}).sort(),
        entrySha256: await entryHash(target),
        provenance: target.provenance,
      })),
    ),
  }
}
