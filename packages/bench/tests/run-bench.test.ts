import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { formatBenchHelp, parseBenchArguments, resolveBenchOutputPath } from '../src/run-bench.js'

const execFile = promisify(execFileCallback)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const RUNNER = path.join(REPO_ROOT, 'packages', 'bench', 'src', 'run-bench.ts')

describe('benchmark CLI arguments', () => {
  it('parses help without selecting a benchmark mode', () => {
    expect(parseBenchArguments(['--help'])).toEqual({
      command: 'help',
      check: false,
      updateThresholds: false,
    })
    expect(formatBenchHelp()).toContain('without launching Electron')
    expect(formatBenchHelp()).toContain('--compare-iterations <count>')
  })

  it('resolves report paths from the repository root instead of pnpm package script cwd', () => {
    expect(resolveBenchOutputPath('output/benchmark.json')).toBe(
      path.join(REPO_ROOT, 'output', 'benchmark.json'),
    )
  })

  it('rejects typos and incompatible mode flags before any Electron work starts', () => {
    expect(() => parseBenchArguments(['--unknown'])).toThrow('Unknown option: --unknown')
    expect(() => parseBenchArguments(['unexpected'])).toThrow('Unexpected argument: unexpected')
    expect(() => parseBenchArguments(['--compare', '--check'])).toThrow(
      '--check is only valid for the first-party benchmark',
    )
    expect(() => parseBenchArguments(['--compare-warmup', '1'])).toThrow(
      '--compare-warmup and --compare-iterations require --compare',
    )
  })

  it('prints help and exits without running the real-Electron scenarios', async () => {
    const { stdout, stderr } = await execFile(
      process.execPath,
      ['--import', 'tsx', RUNNER, '--help'],
      { cwd: REPO_ROOT, timeout: 5_000 },
    )

    expect(stdout).toContain('Usage: pnpm bench [options]')
    expect(stdout).toContain('without launching Electron')
    expect(stderr).not.toContain('Running the benchmark')
    expect(stderr).not.toContain('electron-stagewright MCP server ready')
  })
})
