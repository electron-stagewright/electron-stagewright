/**
 * Shared agent tasks + the built-in stagewright adapters for the cross-server comparison. Each task is
 * expressed ONLY via generic interactions (type / click / find / assert-text), so a competing Electron
 * MCP server can express the SAME task through its own tools — see the bench README ("Comparing against
 * other MCP servers") for how to write a competitor adapter. The stagewright adapters here are the
 * comparison's baseline target.
 *
 * @module
 */

import {
  call,
  findRef,
  stagewrightAdapter,
  type ComparableTask,
  type Driver,
  type Envelope,
  type TaskAdapter,
} from './harness.js'

const NAME = 'Ada Lovelace'
const GREETING = `Hello, ${NAME}`

/** Assert a tool call succeeded; throw (failing the task) with the envelope's code/error otherwise. */
function expectOk(env: Envelope, step: string): Envelope {
  if (!env.ok) {
    throw new Error(`${step} failed: ${env.code ?? 'UNKNOWN'} — ${env.error ?? env.message ?? ''}`)
  }
  return env
}

/** Type a name, submit, and assert the greeting — a form-fill-and-verify task any UI driver can do. */
export const GREETING_TASK: ComparableTask = {
  name: 'verify-greeting',
  description: 'Type a name, submit the form, and assert the greeting text appears.',
}

/** Click a deferred-load button and assert the loaded content — an act-then-assert task. */
export const LOAD_DETAILS_TASK: ComparableTask = {
  name: 'load-details',
  description: 'Click the deferred-load button and assert the loaded details appear.',
}

/** Every fair shared task the comparison runs (more than one, so it is not a single data point). */
export const SHARED_TASKS: readonly ComparableTask[] = [GREETING_TASK, LOAD_DETAILS_TASK]

/** The greeting task expressed via our tools. */
async function stagewrightGreeting(driver: Driver): Promise<void> {
  expectOk(await call(driver, 'electron_type', { selector: '#name', text: NAME }), 'type name')
  const greetRef = await findRef(driver, 'button', 'Greet')
  expectOk(await call(driver, 'electron_click', { ref: greetRef }), 'click greet')
  expectOk(
    await call(driver, 'electron_expect_text', { selector: '#status', contains: GREETING }),
    'assert greeting',
  )
}

/** The load-details task expressed via our tools. */
async function stagewrightLoadDetails(driver: Driver): Promise<void> {
  const loadRef = await findRef(driver, 'button', 'Load details')
  expectOk(await call(driver, 'electron_click', { ref: loadRef }), 'click load details')
  expectOk(
    await call(driver, 'electron_expect_text', { selector: '#late', contains: 'Details loaded' }),
    'assert details',
  )
}

/**
 * The built-in stagewright adapters — one per shared task. These are the comparison's BASELINE target;
 * a competitor adapter (the same tasks expressed via that server's tools) joins the comparison
 * alongside them. The README shows the competitor-adapter skeleton.
 */
export function stagewrightAdapters(): readonly TaskAdapter[] {
  return [
    stagewrightAdapter(GREETING_TASK, stagewrightGreeting),
    stagewrightAdapter(LOAD_DETAILS_TASK, stagewrightLoadDetails),
  ]
}
