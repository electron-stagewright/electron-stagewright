/**
 * Shared agent tasks and the pinned adapters that express them against each server. A task owns one
 * exact-text success oracle; every adapter must prove that same observable result. This avoids a
 * comparison where one target merely completes an action while another has to verify its outcome.
 *
 * @module
 */

import { fileURLToPath } from 'node:url'

import {
  BENCH_APP_MAIN,
  call,
  rawCall,
  stagewrightAdapter,
  STAGEWRIGHT_COMPARISON_TARGET,
  type ComparableTask,
  type Driver,
  type Envelope,
  type ServerTarget,
  type TaskAdapter,
} from './harness.js'

const NAME = 'Ada Lovelace'

/** The first-party competitor currently exercised by the reproducible comparison. */
const ELECTRON_DRIVER_ENTRY = fileURLToPath(import.meta.resolve('electron-driver'))

/**
 * The target is launched through the installed, lockfile-pinned entry rather than npx. The source
 * commit and tarball hashes were read from the 0.3.1 npm metadata when this adapter was added.
 */
export const ELECTRON_DRIVER_TARGET: ServerTarget = {
  name: 'electron-driver',
  command: process.execPath,
  args: [ELECTRON_DRIVER_ENTRY],
  provenance: {
    source: 'npm',
    package: { name: 'electron-driver', version: '0.3.1' },
    sourceCommit: '377341e38caec84cf9dbd5dd7a3a0e4baed0d1b1',
    // electron-driver@0.3.1's package.json is correct; its MCP Server constructor still announces 0.3.0.
    reportedServerVersion: '0.3.0',
    dist: {
      tarball: 'https://registry.npmjs.org/electron-driver/-/electron-driver-0.3.1.tgz',
      sha256: '3365bc1c5c05c1a4e49fab11a7ee0526b229e171767c9c690962cbdf31180495',
      integrity:
        'sha512-X37McAhW+b73oiKPpKpnDPJGoB+Pe/+ySQ25KUs4sHN0Y6cId5LLCqRBBgRHF1A3BSI/nMIs8cZW3TrFMgB9tw==',
    },
  },
}

/** Assert a tool call succeeded; throw (failing the task) with its code/error otherwise. */
function expectOk(env: Envelope, step: string): Envelope {
  if (!env.ok) {
    throw new Error(`${step} failed: ${env.code ?? 'UNKNOWN'} — ${env.error ?? env.message ?? ''}`)
  }
  return env
}

/** Comparisons only register tasks with a concrete shared oracle. */
function oracleFor(task: ComparableTask): NonNullable<ComparableTask['oracle']> {
  if (task.oracle === undefined) throw new Error(`${task.name} has no cross-server success oracle`)
  return task.oracle
}

/** Run the canonical, target-independent task oracle against a normalized text response. */
function expectOracleText(env: Envelope, task: ComparableTask, step: string): void {
  expectOk(env, step)
  const oracle = oracleFor(task)
  const text = env['text']
  if (text !== oracle.expectedText) {
    throw new Error(
      `${step} failed the ${task.name} oracle: expected ${JSON.stringify(oracle.expectedText)}, received ${JSON.stringify(text)}`,
    )
  }
}

/** Type a name, submit, and prove the greeting through a single exact-text oracle. */
export const GREETING_TASK: ComparableTask = {
  name: 'verify-greeting',
  description: 'Type a name, submit the form, and prove the exact greeting appears.',
  oracle: { selector: '#status', expectedText: `Hello, ${NAME}!` },
}

/** Click a deferred-load button and prove the rendered details through the same kind of oracle. */
export const LOAD_DETAILS_TASK: ComparableTask = {
  name: 'load-details',
  description: 'Click the deferred-load button and prove the exact loaded details appear.',
  oracle: { selector: '#late', expectedText: 'Details loaded' },
}

/** Every fair shared task the comparison runs (more than one, so it is not a single data point). */
export const SHARED_TASKS: readonly ComparableTask[] = [GREETING_TASK, LOAD_DETAILS_TASK]

/** The greeting task expressed via Stagewright's primitive tools plus the shared oracle. */
async function stagewrightGreeting(driver: Driver): Promise<void> {
  expectOk(await call(driver, 'electron_type', { selector: '#name', text: NAME }), 'type name')
  expectOk(await call(driver, 'electron_click', { selector: '#greet' }), 'click greet')
  expectOracleText(
    await call(driver, 'electron_get_text', { selector: oracleFor(GREETING_TASK).selector }),
    GREETING_TASK,
    'read greeting',
  )
}

/** The deferred-load task expressed via Stagewright's condition wait plus the shared oracle. */
async function stagewrightLoadDetails(driver: Driver): Promise<void> {
  expectOk(await call(driver, 'electron_click', { selector: '#load' }), 'click load details')
  expectOk(
    await call(driver, 'electron_wait_for_selector', {
      selector: oracleFor(LOAD_DETAILS_TASK).selector,
      state: 'attached',
      timeoutMs: 2_000,
    }),
    'wait for details',
  )
  expectOracleText(
    await call(driver, 'electron_get_text', { selector: oracleFor(LOAD_DETAILS_TASK).selector }),
    LOAD_DETAILS_TASK,
    'read details',
  )
}

/** Stagewright's baseline adapters — both tasks use the canonical exact-text oracle. */
export function stagewrightAdapters(): readonly TaskAdapter[] {
  return [
    stagewrightAdapter(GREETING_TASK, stagewrightGreeting, STAGEWRIGHT_COMPARISON_TARGET),
    stagewrightAdapter(LOAD_DETAILS_TASK, stagewrightLoadDetails, STAGEWRIGHT_COMPARISON_TARGET),
  ]
}

/** The greeting task expressed through electron-driver's equivalent primitive tools. */
async function electronDriverGreeting(driver: Driver): Promise<void> {
  expectOk(await call(driver, 'type', { selector: '#name', text: NAME }), 'type name')
  expectOk(await call(driver, 'click', { selector: '#greet' }), 'click greet')
  expectOracleText(
    await call(driver, 'get_text', { selector: oracleFor(GREETING_TASK).selector }),
    GREETING_TASK,
    'read greeting',
  )
}

/** The deferred-load task expressed through electron-driver's equivalent primitive tools. */
async function electronDriverLoadDetails(driver: Driver): Promise<void> {
  expectOk(await call(driver, 'click', { selector: '#load' }), 'click load details')
  expectOk(
    await call(driver, 'wait_for_selector', {
      selector: oracleFor(LOAD_DETAILS_TASK).selector,
      state: 'attached',
      timeoutMs: 2_000,
    }),
    'wait for details',
  )
  expectOracleText(
    await call(driver, 'get_text', { selector: oracleFor(LOAD_DETAILS_TASK).selector }),
    LOAD_DETAILS_TASK,
    'read details',
  )
}

/**
 * Pinned electron-driver adapters. Its process is server-global rather than session-scoped, so
 * `sessionArgs` deliberately returns `{}`: injecting Stagewright's sessionId would inflate its request
 * payload and produce an unfair comparison.
 */
export function electronDriverAdapters(): readonly TaskAdapter[] {
  const base = {
    target: ELECTRON_DRIVER_TARGET,
    launch: async (client: Driver['client']) => {
      expectOk(await rawCall(client, 'start_app', { main: BENCH_APP_MAIN }), 'launch app')
      return 'electron-driver-process'
    },
    sessionArgs: () => ({}),
    stop: async (client: Driver['client']) => {
      await rawCall(client, 'stop_app', {}).catch(() => undefined)
    },
  } as const
  return [
    { ...base, task: GREETING_TASK, run: electronDriverGreeting },
    { ...base, task: LOAD_DETAILS_TASK, run: electronDriverLoadDetails },
  ]
}

/** Every built-in target used by `pnpm bench --compare`. */
export function comparisonAdapters(): readonly TaskAdapter[] {
  return [...stagewrightAdapters(), ...electronDriverAdapters()]
}
