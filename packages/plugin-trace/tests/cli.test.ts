/** Unit tests for the standalone replay runner's contracts and CI exit taxonomy. */

import type { ToolResult } from '@electron-stagewright/core'
import { describe, expect, it, vi } from 'vitest'

import {
  REPLAY_EXIT_CODES,
  parseReplayCliArgs,
  runReplayCli,
  type ReplayCliDependencies,
  type ReplayCliIo,
  type ReplayCliOptions,
} from '../src/cli.js'

function options(overrides: Partial<ReplayCliOptions> = {}): ReplayCliOptions {
  return {
    command: 'run',
    specPath: '/tmp/regression.replay.json',
    json: true,
    allowEval: { main: false, renderer: false },
    toolProfile: 'full',
    pluginSpecs: [],
    pluginConfigs: {},
    ...overrides,
  }
}

function result(value: Record<string, unknown>): ToolResult {
  return { ok: true, _meta: { estimated_tokens: 1, elapsed_ms: 1 }, ...value } as ToolResult
}

function errorResult(): ToolResult {
  return {
    ok: false,
    code: 'core.NOT_RUNNING',
    error: 'The app is not running.',
    hint: 'Launch the app before retrying.',
    retryable: false,
    http: 409,
    _meta: { estimated_tokens: 1, elapsed_ms: 1 },
  }
}

function captureIo(): { readonly io: ReplayCliIo; readonly output: string[] } {
  const output: string[] = []
  return {
    io: {
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(`stderr:${text}`),
    },
    output,
  }
}

function dependencies(
  spec: unknown,
  dispatch: (tool: string, args: unknown) => Promise<ToolResult>,
): { readonly deps: ReplayCliDependencies; readonly close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => undefined)
  return {
    deps: {
      readFile: async () => JSON.stringify(spec),
      importPlugin: async () => {
        throw new Error('unexpected plugin import')
      },
      createServer: async () => ({ dispatcher: { dispatch }, close }),
    },
    close,
  }
}

const baseSpec = {
  format: 'stagewright-replay',
  version: 1,
  normalizers: [],
  redactions: ['result.password'],
  steps: [
    {
      tool: 'electron_launch',
      args: { main: '/app/main.js' },
      captureSession: '$stagewright.session.1',
      expect: { ok: true },
    },
    {
      tool: 'check_status',
      args: { sessionId: '$stagewright.session.1' },
      expect: { result: { mode: 'subset', value: { status: 'Ready' } } },
    },
  ],
} as const

describe('parseReplayCliArgs', () => {
  it('strictly parses CI filtering and shared server options', () => {
    expect(
      parseReplayCliArgs([
        'spec.json',
        '--json',
        '--include',
        'electron_snapshot,electron_click',
        '--plugin',
        '@scope/plugin',
        '--allow-eval=renderer',
      ]),
    ).toMatchObject({
      command: 'run',
      specPath: 'spec.json',
      json: true,
      include: ['electron_snapshot', 'electron_click'],
      pluginSpecs: ['@scope/plugin'],
      allowEval: { main: false, renderer: true },
    })
    expect(() => parseReplayCliArgs([])).toThrow('Expected one replay specification path')
    expect(() => parseReplayCliArgs(['spec.json', '--unknown'])).toThrow(
      'Unknown option: --unknown',
    )
  })
})

describe('runReplayCli', () => {
  it('reports a redacted checkpoint mismatch with the mismatch exit code', async () => {
    const { io, output } = captureIo()
    const { deps, close } = dependencies(baseSpec, async (tool) =>
      tool === 'electron_launch'
        ? result({ _meta: { session_id: 'fresh-session' } })
        : result({ status: 'Changed', password: 'never-print' }),
    )

    const replay = await runReplayCli(options(), io, deps)

    expect(replay.exitCode).toBe(REPLAY_EXIT_CODES.MISMATCH)
    expect(replay.report).toMatchObject({
      passed: false,
      exit_code: REPLAY_EXIT_CODES.MISMATCH,
      summary: { mismatched: 1 },
    })
    expect(replay.report.steps?.[1]).toMatchObject({ tool: 'check_status', matcher: 'subset' })
    expect(output.join('')).not.toContain('never-print')
    expect(close).toHaveBeenCalledOnce()
  })

  it('classifies a failed electron launch separately from an ordinary mismatch', async () => {
    const { io } = captureIo()
    const { deps } = dependencies(baseSpec, async () => errorResult())

    const replay = await runReplayCli(options(), io, deps)

    expect(replay).toMatchObject({
      exitCode: REPLAY_EXIT_CODES.APP_LAUNCH,
      report: { exit_code: REPLAY_EXIT_CODES.APP_LAUNCH, passed: false },
    })
  })

  it('rejects malformed JSON before constructing a server', async () => {
    const { io } = captureIo()
    const createServer = vi.fn()
    const deps: ReplayCliDependencies = {
      readFile: async () => '{',
      importPlugin: async () => {
        throw new Error('unexpected plugin import')
      },
      createServer,
    }

    const replay = await runReplayCli(options(), io, deps)

    expect(replay).toMatchObject({
      exitCode: REPLAY_EXIT_CODES.MALFORMED_SPEC,
      report: { error: { code: 'MALFORMED_SPEC' } },
    })
    expect(createServer).not.toHaveBeenCalled()
  })
})
