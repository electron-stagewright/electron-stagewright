import { execFile as execFileCallback } from 'node:child_process'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it, vi } from 'vitest'

import {
  directRetainedProfileOrder,
  formatStartupHelp,
  forwardedNetworkEnvironment,
  parseStartupArguments,
  resolveStartupOutputPath,
  resolveStartupProgressPath,
} from '../src/run-startup.js'
import {
  createStdioStartupProbe,
  measureStartupTarget,
  publishedNpxServerArguments,
  publishedPackageSpecs,
  runStartupSeries,
  setupFailureSample,
  summarizeStartupSamples,
  type StartupProbe,
  type StartupTarget,
} from '../src/startup.js'

const execFile = promisify(execFileCallback)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(HERE, '../../..')
const RUNNER = path.join(REPOSITORY_ROOT, 'packages', 'bench', 'src', 'run-startup.ts')

function target(overrides: Partial<StartupTarget> = {}): StartupTarget {
  return {
    mode: 'published-npx-cold',
    profile: 'full',
    cacheState: 'empty',
    iteration: 1,
    command: 'npx',
    args: [],
    initializeTimeoutMs: 100,
    toolsListTimeoutMs: 100,
    ...overrides,
  }
}

describe('published startup protocol', () => {
  it('derives exact core and peer package specs from the canonical manifest pins', () => {
    expect(
      publishedPackageSpecs({
        name: '@electron-stagewright/core',
        version: '0.4.1',
        devDependencies: { playwright: '^1.61.1', electron: '^42.3.0' },
      }),
    ).toEqual(['@electron-stagewright/core@0.4.1', 'playwright@1.61.1', 'electron@42.3.0'])
    expect(() =>
      publishedPackageSpecs({
        name: '@electron-stagewright/core',
        version: 'latest',
        devDependencies: { playwright: '^1.61.1', electron: '^42.3.0' },
      }),
    ).toThrow('Expected an exact release version for core')
  })

  it('builds a pinned npx command before server flags', () => {
    expect(
      publishedNpxServerArguments(
        ['@electron-stagewright/core@0.4.1', 'playwright@1.61.1'],
        ['--tool-profile', 'full', '--app-root', '/project'],
      ),
    ).toEqual([
      '-y',
      '--package',
      '@electron-stagewright/core@0.4.1',
      '--package',
      'playwright@1.61.1',
      'electron-stagewright',
      '--tool-profile',
      'full',
      '--app-root',
      '/project',
    ])
  })

  it('times MCP initialize and tools/list as separate phases and always closes the probe', async () => {
    let clock = 100
    const close = vi.fn(async () => undefined)
    const probe: StartupProbe = {
      async connect() {
        clock += 35
      },
      async listTools() {
        clock += 7
        return 18
      },
      close,
      diagnostics: () => '',
    }

    await expect(
      measureStartupTarget(target(), {
        createProbe: () => probe,
        now: () => clock,
      }),
    ).resolves.toEqual({
      mode: 'published-npx-cold',
      profile: 'full',
      cache_state: 'empty',
      iteration: 1,
      ok: true,
      server_ready_ms: 35,
      tools_list_ms: 7,
      tool_count: 18,
    })
    expect(close).toHaveBeenCalledOnce()
  })

  it('retains partial initialize timing and bounded redacted failure evidence', async () => {
    let clock = 0
    const close = vi.fn(async () => undefined)
    const scratch = '/private/scratch/startup'
    const probe: StartupProbe = {
      async connect() {
        clock += 12
      },
      async listTools() {
        throw new Error(`manifest failed under ${scratch}: ${'x'.repeat(3_000)}`)
      },
      close,
      diagnostics: () => `log path ${scratch}`,
    }

    const sample = await measureStartupTarget(target({ redactPaths: [scratch] }), {
      createProbe: () => probe,
      now: () => clock,
    })

    expect(sample).toMatchObject({
      ok: false,
      failure_phase: 'tools/list',
      server_ready_ms: 12,
      tools_list_ms: null,
      tool_count: null,
    })
    expect(sample.error).toContain('<scratch>')
    expect(sample.error).not.toContain(scratch)
    expect(sample.error?.length).toBeLessThanOrEqual(2_001)
    expect(close).toHaveBeenCalledOnce()
  })

  it('awaits child termination before resolving an initialize-timeout sample', async () => {
    const timedTarget = target({
      command: process.execPath,
      args: [
        '-e',
        [
          'process.stdin.resume()',
          "process.stdin.on('end', () => setTimeout(() => process.exit(0), 75))",
          'setInterval(() => undefined, 1000)',
        ].join(';'),
      ],
      initializeTimeoutMs: 25,
      toolsListTimeoutMs: 25,
    })
    const realProbe = createStdioStartupProbe(timedTarget)
    let childPid: number | null = null
    const observingProbe: StartupProbe = {
      async connect() {
        const connecting = realProbe.connect()
        while (realProbe.pid?.() == null) await delay(1)
        childPid = realProbe.pid?.() ?? null
        await connecting
      },
      listTools: () => realProbe.listTools(),
      close: () => realProbe.close(),
      diagnostics: () => realProbe.diagnostics(),
    }

    const sample = await measureStartupTarget(timedTarget, {
      createProbe: () => observingProbe,
    })

    expect(sample).toMatchObject({ ok: false, failure_phase: 'initialize' })
    expect(childPid).not.toBeNull()
    expect(() => process.kill(childPid ?? 0, 0)).toThrow()
  })

  it('summarizes only available observations without converting failures to zeroes', () => {
    const successful = {
      mode: 'direct-installed',
      profile: 'essential',
      cache_state: 'installed',
      iteration: 1,
      ok: true,
      server_ready_ms: 10,
      tools_list_ms: 4,
      tool_count: 12,
    } as const
    const failed = setupFailureSample(
      target({
        mode: 'direct-installed',
        profile: 'essential',
        cacheState: 'installed',
        iteration: 2,
      }),
      new Error('install failed'),
    )

    expect(summarizeStartupSamples([successful, failed])).toEqual({
      retained_runs: 2,
      successful_runs: 1,
      failed_runs: 1,
      server_ready_ms: { samples: 1, min: 10, median: 10, max: 10 },
      tools_list_ms: { samples: 1, min: 4, median: 4, max: 4 },
      tool_count: { samples: 1, min: 12, median: 12, max: 12 },
    })
  })

  it('checkpoints each completed sample through the series observer', async () => {
    const observed: number[] = []
    const probe = (): StartupProbe => ({
      connect: async () => undefined,
      listTools: async () => 27,
      close: async () => undefined,
      diagnostics: () => '',
    })

    const samples = await runStartupSeries([target({ iteration: 1 }), target({ iteration: 2 })], {
      createProbe: probe,
      onSample: (sample) => {
        observed.push(sample.iteration)
      },
    })

    expect(samples).toHaveLength(2)
    expect(observed).toEqual([1, 2])
  })
})

describe('startup benchmark CLI', () => {
  it('parses bounded sample counts and a repository-relative JSON path', () => {
    expect(
      parseStartupArguments([
        '--cold-runs',
        '2',
        '--warm-runs',
        '4',
        '--direct-runs',
        '5',
        '--json',
        'output/startup.json',
      ]),
    ).toEqual({
      command: 'benchmark',
      coldRuns: 2,
      warmRuns: 4,
      directRuns: 5,
      jsonPath: 'output/startup.json',
    })
    expect(resolveStartupOutputPath('output/startup.json')).toBe(
      path.join(REPOSITORY_ROOT, 'output', 'startup.json'),
    )
    expect(resolveStartupProgressPath('output/startup.json')).toBe(
      path.join(REPOSITORY_ROOT, 'output', 'startup-progress.ndjson'),
    )
  })

  it('warms both direct profiles, then alternates the retained execution order', () => {
    expect(directRetainedProfileOrder(3)).toEqual([
      'full',
      'essential',
      'essential',
      'full',
      'full',
      'essential',
    ])
  })

  it('forwards package network routing without copying unrelated secrets', () => {
    expect(
      forwardedNetworkEnvironment({
        HTTPS_PROXY: 'https://proxy.example',
        NODE_EXTRA_CA_CERTS: '/certs/company.pem',
        PRIVATE_TOKEN: 'do-not-forward',
      }),
    ).toEqual({
      HTTPS_PROXY: 'https://proxy.example',
      NODE_EXTRA_CA_CERTS: '/certs/company.pem',
    })
  })

  it('rejects unknown, duplicate, missing, and excessive options before package work', () => {
    expect(() => parseStartupArguments(['--unknown'])).toThrow('Unknown option: --unknown')
    expect(() => parseStartupArguments(['--cold-runs'])).toThrow('--cold-runs expects a value')
    expect(() => parseStartupArguments(['--warm-runs', '0'])).toThrow(
      '--warm-runs must be between 1 and 5',
    )
    expect(() => parseStartupArguments(['--cold-runs', '3'])).toThrow(
      '--cold-runs must be between 1 and 2',
    )
    expect(() => parseStartupArguments(['--direct-runs', '6'])).toThrow(
      '--direct-runs must be between 1 and 5',
    )
    expect(() => parseStartupArguments(['--json', 'a', '--json', 'b'])).toThrow(
      '--json may be specified only once',
    )
    expect(() => parseStartupArguments(['--json', ''])).toThrow('--json expects a non-empty path')
  })

  it('prints help without creating caches, installing packages, or spawning a server', async () => {
    const { stdout, stderr } = await execFile(
      process.execPath,
      ['--import', 'tsx', RUNNER, '--help'],
      { cwd: REPOSITORY_ROOT, timeout: 5_000 },
    )

    expect(stdout).toBe(`${formatStartupHelp()}\n`)
    expect(stderr).not.toContain('Measuring published startup')
    expect(stderr).not.toContain('electron-stagewright MCP server ready')
  })
})
