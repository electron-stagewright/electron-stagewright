/**
 * Real-Electron smoke for the utilityProcess transport: the host is killed and crashes mid-call,
 * the main process survives both, and a stop drains the last call. Opt-in via `STAGEWRIGHT_E2E=1`;
 * needs `pnpm build`, since Electron loads the built package.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const RUN_E2E = process.env['STAGEWRIGHT_E2E'] === '1'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAIN = path.join(HERE, 'fixtures', 'utility-app', 'main.mjs')

interface Outcome {
  readonly ok: boolean
  readonly value?: unknown
  readonly code?: string
  readonly cause?: string
  readonly causeCode?: string
}

function runApp(): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const electron = createRequire(path.join(HERE, '..', '..', 'core', 'package.json'))(
    'electron',
  ) as string
  return new Promise((resolve, reject) => {
    const child = spawn(electron, [MAIN], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    const timer = setTimeout(() => child.kill(), 90_000)
    child.on('error', reject)
    child.on('exit', (status) => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
  })
}

describe('utilityProcess host smoke (real Electron)', () => {
  it.skipIf(!RUN_E2E)(
    'survives a kill and a crash mid-call, restarts the host, and drains on stop',
    async () => {
      const run = await runApp()
      const line = run.stdout.split('\n').find((entry) => entry.startsWith('HOST_SMOKE '))
      expect(line, `stdout:\n${run.stdout}\nstderr:\n${run.stderr}`).toBeDefined()
      const result = JSON.parse(line?.slice('HOST_SMOKE '.length) ?? '{}') as Record<
        string,
        unknown
      >
      expect(result['error']).toBeUndefined()
      expect(run.status).toBe(0)

      expect(result['echo']).toBe('hello utility')
      expect(result['firstPid']).not.toBe(result['mainPid'])

      const killed = result['killed'] as Outcome
      expect(killed).toMatchObject({ ok: false, code: 'HOST_EXITED' })
      expect(result['afterKill']).toBe('hello again')
      expect(result['secondPid']).not.toBe(result['firstPid'])

      const crashed = result['crashed'] as Outcome
      // The host reports its uncaught exception before the process ends.
      expect(crashed).toMatchObject({
        ok: false,
        code: 'HOST_EXITED',
        cause: 'native state lost',
        causeCode: 'TEST_CRASH',
      })
      expect(result['afterCrash']).toBe('hello third')

      expect(result['exits']).toEqual([
        { kind: 'crash', pendingCalls: 1 },
        { kind: 'crash', pendingCalls: 1 },
      ])
      expect(result['stop']).toEqual({ ok: true })
      expect(result['drained']).toEqual({ ok: true, value: 'done' })
      expect(result['state']).toBe('closed')
    },
    120_000,
  )
})
