/**
 * Real-Electron replay smoke (ADR-009) — the acceptance proof that a recorded session replays
 * deterministically. Records a minimal-app session (launch -> snapshot -> click -> stop) into a
 * trace artifact, then replays that artifact against a FRESH server and asserts every call matched
 * (session ids are remapped to the new run). Exercises the whole seam end to end: the recorder's
 * observer, the `ctx.dispatch` re-dispatch path, and session-id remapping against a live renderer.
 *
 * Opt-in: runs only when `STAGEWRIGHT_E2E=1` (with `electron` + `playwright` installed). Skipped by
 * default so `pnpm test` stays fast and headless-CI-safe. Run locally with:
 *
 *   pnpm test:real
 *
 * @module
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from '@electron-stagewright/core'
import { afterEach, describe, expect, it } from 'vitest'

import { REPLAY_EXIT_CODES, runReplayCli, type ReplayCliIo } from '../src/cli.js'
import tracePlugin from '../src/index.js'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'

// The minimal-app fixture lives in the core package's test fixtures; reach it by relative path
// within the monorepo (it is not part of core's published surface).
const FIXTURE_MAIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'core',
  'tests',
  'fixtures',
  'minimal-electron',
  'main.js',
)

const created: string[] = []
afterEach(async () => {
  await Promise.all(created.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})

async function tmpTraceFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-trace-replay-'))
  created.push(dir)
  return path.join(dir, 'trace.jsonl')
}

/** Read the session id a launch envelope carries (payload field, with the `_meta` fallback). */
function sessionIdOf(result: unknown): string {
  const r = result as { session_id?: string; _meta?: { session_id?: string } }
  const id = r.session_id ?? r._meta?.session_id
  if (typeof id !== 'string') throw new Error('launch returned no session id')
  return id
}

describe('trace replay smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'records a minimal-app session and replays it with every call matched',
    async () => {
      const file = await tmpTraceFile()

      // Record: launch -> snapshot -> click -> stop, with a trace active the whole time.
      const recordServer = await createServer({ plugins: [tracePlugin] })
      try {
        await recordServer.dispatcher.dispatch('trace_start', { path: file })
        const launched = await recordServer.dispatcher.dispatch('electron_launch', {
          main: FIXTURE_MAIN,
        })
        expect(launched.ok).toBe(true)
        const sessionId = sessionIdOf(launched)
        expect(
          (await recordServer.dispatcher.dispatch('electron_snapshot', { sessionId })).ok,
        ).toBe(true)
        expect(
          (
            await recordServer.dispatcher.dispatch('electron_click', {
              sessionId,
              selector: '#ping',
            })
          ).ok,
        ).toBe(true)
        expect((await recordServer.dispatcher.dispatch('electron_stop', { sessionId })).ok).toBe(
          true,
        )
        expect(await recordServer.dispatcher.dispatch('trace_stop', {})).toMatchObject({
          ok: true,
          records: 4,
        })
      } finally {
        await recordServer.close().catch(() => undefined)
      }

      // Replay against a fresh server: the recorded session id is defunct, so the engine must
      // remap to the newly launched one for every call to match.
      const replayServer = await createServer({ plugins: [tracePlugin] })
      try {
        const report = (await replayServer.dispatcher.dispatch('trace_replay', {
          path: file,
        })) as unknown as { ok: boolean; replayed: number; matched: number; diverged: number }
        expect(report.ok).toBe(true)
        expect(report.replayed).toBe(4)
        expect(report.diverged).toBe(0)
        expect(report.matched).toBe(report.replayed)
      } finally {
        await replayServer.close().catch(() => undefined)
      }
    },
    60_000,
  )

  it.skipIf(!RUN_E2E)(
    'runs one parameterized spec with different values through the headless runner',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'sw-replay-params-'))
      created.push(dir)
      const specPath = path.join(dir, 'type-name.replay.json')
      await writeFile(
        specPath,
        JSON.stringify({
          format: 'stagewright-replay',
          version: 2,
          parameters: {
            main: { type: 'path' },
            name: { type: 'string', minLength: 1, default: 'Ada' },
          },
          steps: [
            { tool: 'electron_launch', args: { main: { $param: 'main' } }, expect: { ok: true } },
            {
              tool: 'electron_type',
              args: { selector: '#name', text: { $param: 'name' } },
              expect: { ok: true },
            },
            {
              tool: 'electron_get_value',
              args: { selector: '#name' },
              expect: { result: { mode: 'subset', value: { value: { $param: 'name' } } } },
            },
            { tool: 'electron_stop', args: {}, expect: { ok: true } },
          ],
        }),
      )
      const io: ReplayCliIo = { stdout: () => undefined, stderr: () => undefined }
      const run = (parameters: Record<string, string>) =>
        runReplayCli(
          {
            command: 'run',
            specPath,
            json: true,
            allowEval: { main: false, renderer: false },
            toolProfile: 'full',
            pluginSpecs: [],
            pluginConfigs: {},
            parameters,
          },
          io,
        )

      for (const name of ['Ada', 'Grace Hopper']) {
        const replay = await run({ main: FIXTURE_MAIN, name })
        expect(replay.exitCode).toBe(REPLAY_EXIT_CODES.SUCCESS)
        expect(replay.report).toMatchObject({
          passed: true,
          summary: { matched: 4, mismatched: 0 },
          parameters: { main: FIXTURE_MAIN, name },
        })
      }
      // A value that breaks the declaration stops before the app launches.
      await expect(run({ main: FIXTURE_MAIN, name: '' })).resolves.toMatchObject({
        exitCode: REPLAY_EXIT_CODES.USAGE,
        report: { error: { code: 'INVALID_PARAMETERS' } },
      })
    },
    60_000,
  )
})
