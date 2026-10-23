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

  describe('parameters', () => {
    const paramSpec = {
      format: 'stagewright-replay',
      version: 2,
      parameters: {
        language: { type: 'string', enum: ['en', 'es'], default: 'en' },
        token: { type: 'string', sensitive: true },
      },
      steps: [
        {
          tool: 'electron_launch',
          args: { main: '/app/main.js' },
          captureSession: '$stagewright.session.1',
          expect: { ok: true },
        },
        {
          tool: 'storage_local_set',
          args: {
            sessionId: '$stagewright.session.1',
            key: 'language',
            value: { $param: 'language' },
          },
          expect: { ok: true },
        },
        {
          tool: 'login',
          args: { sessionId: '$stagewright.session.1', token: { $param: 'token' } },
          expect: { ok: true },
        },
      ],
    }

    it('parses --param, --params-file and --param-env', () => {
      expect(
        parseReplayCliArgs([
          'spec.json',
          '--param',
          'language=es',
          '--param',
          'query=a=b',
          '--params-file',
          'params.json',
          '--param-env',
          'token=APP_TOKEN',
        ]),
      ).toMatchObject({
        parameters: { language: 'es', query: 'a=b' },
        paramsFile: 'params.json',
        paramEnv: { token: 'APP_TOKEN' },
      })
      expect(() => parseReplayCliArgs(['spec.json', '--param', 'language'])).toThrow(
        '--param expects <name>=<value>',
      )
    })

    it('merges file, environment and flags, reports the values, and redacts the secret', async () => {
      const { io, output } = captureIo()
      const dispatched: unknown[] = []
      let serverOptions: unknown
      const deps: ReplayCliDependencies = {
        readFile: async (file) =>
          file.endsWith('params.json')
            ? JSON.stringify({ language: 'en', token: 'from-file' })
            : JSON.stringify(paramSpec),
        importPlugin: async () => ({ name: 'trace', version: '0.0.0', coreVersionRange: '*' }),
        createServer: async (opts) => {
          serverOptions = opts
          return {
            dispatcher: {
              dispatch: async (tool, args) => {
                dispatched.push(args)
                return tool === 'electron_launch'
                  ? result({ _meta: { session_id: 'fresh' } })
                  : result({})
              },
            },
            close: async () => undefined,
          }
        },
        env: { APP_TOKEN: 'env-secret' },
      }

      const replay = await runReplayCli(
        options({
          paramsFile: '/tmp/params.json',
          paramEnv: { token: 'APP_TOKEN' },
          parameters: { language: 'es' },
          pluginSpecs: ['trace'],
          pluginConfigs: { trace: { redact: ['password'] } },
        }),
        io,
        deps,
      )

      expect(replay.exitCode).toBe(REPLAY_EXIT_CODES.SUCCESS)
      expect(replay.report.parameters).toEqual({ language: 'es', token: '[redacted]' })
      expect(dispatched[1]).toMatchObject({ value: 'es' })
      expect(dispatched[2]).toMatchObject({ token: 'env-secret' })
      expect(output.join('')).not.toContain('env-secret')
      expect(serverOptions).toMatchObject({
        pluginConfigs: { trace: { redact: ['password', 'token'] } },
      })
    })

    it('reports an invalid params file without echoing its content', async () => {
      const { io, output } = captureIo()
      const replay = await runReplayCli(options({ paramsFile: '/tmp/params.json' }), io, {
        readFile: async (file) =>
          file.endsWith('params.json') ? '{"token": super-secret-value' : JSON.stringify(paramSpec),
        importPlugin: async () => {
          throw new Error('unexpected plugin import')
        },
        createServer: vi.fn(),
        env: {},
      })
      expect(replay).toMatchObject({
        exitCode: REPLAY_EXIT_CODES.USAGE,
        report: {
          error: { code: 'INVALID_PARAMETERS', message: '--params-file is not valid JSON.' },
        },
      })
      expect(output.join('')).not.toContain('super-secret-value')
    })

    it('refuses bad values with exit 64 and bad specs with exit 2, before any server starts', async () => {
      const cases: [unknown, Partial<ReplayCliOptions>, number, string][] = [
        [
          paramSpec,
          { parameters: { language: 'fr', token: 't' } },
          REPLAY_EXIT_CODES.USAGE,
          'INVALID_PARAMETERS',
        ],
        [paramSpec, {}, REPLAY_EXIT_CODES.USAGE, 'INVALID_PARAMETERS'],
        [
          paramSpec,
          { paramEnv: { token: 'UNSET_VAR' } },
          REPLAY_EXIT_CODES.USAGE,
          'INVALID_PARAMETERS',
        ],
        [
          { ...paramSpec, parameters: { ...paramSpec.parameters, unused: { type: 'boolean' } } },
          { parameters: { token: 't' } },
          REPLAY_EXIT_CODES.MALFORMED_SPEC,
          'MALFORMED_SPEC',
        ],
      ]
      for (const [spec, overrides, exitCode, code] of cases) {
        const { io } = captureIo()
        const createServer = vi.fn()
        const replay = await runReplayCli(options(overrides), io, {
          readFile: async () => JSON.stringify(spec),
          importPlugin: async () => {
            throw new Error('unexpected plugin import')
          },
          createServer,
          env: {},
        })
        expect(replay).toMatchObject({ exitCode, report: { error: { code } } })
        expect(createServer).not.toHaveBeenCalled()
      }
    })
  })
})
