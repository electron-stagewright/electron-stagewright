/**
 * Benchmark scenarios — agent tasks expressed as sequences of MCP tool calls. The first
 * two are the SAME task (verify a greeting) done two ways, so their metric delta is the
 * token-economy headline. The third exercises an error-recovery path so the suite
 * measures the cost of a failed-then-recovered step, not just happy paths.
 *
 * @module
 */

import { call, findRef, type Envelope, type Scenario } from './harness.js'

const NAME = 'Ada Lovelace'
const GREETING = `Hello, ${NAME}`

/**
 * Turns in the long-running act-then-observe contrast. 30 mirrors a realistic
 * agent session length, so the diff-vs-rescan saving is measured at the scale
 * where it compounds rather than on a single observation.
 */
const MULTI_TURN_ROUNDS = 30

/** Assert a tool call that is expected to succeed, preserving the envelope for reads. */
function expectOk(env: Envelope, step: string): Envelope {
  if (!env.ok) {
    throw new Error(`${step} failed: ${env.code ?? 'UNKNOWN'} — ${env.error ?? env.message ?? ''}`)
  }
  return env
}

/** Assert a text read returned the expected value. */
function expectTextContains(env: Envelope, expected: string, step: string): void {
  expectOk(env, step)
  if (typeof env['text'] !== 'string' || !env['text'].includes(expected)) {
    throw new Error(`${step} expected text containing ${expected}, got ${String(env['text'])}`)
  }
}

/** Fill the greeting form and click Greet (shared setup for the two greeting scenarios). */
async function submitGreeting(driver: Parameters<Scenario['run']>[0]): Promise<void> {
  expectOk(await call(driver, 'electron_snapshot'), 'snapshot before greeting')
  expectOk(await call(driver, 'electron_type', { selector: '#name', text: NAME }), 'type name')
  const greetRef = await findRef(driver, 'button', 'Greet')
  expectOk(await call(driver, 'electron_click', { ref: greetRef }), 'click greet')
}

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: 'verify-greeting-primitive',
    description: 'Verify a greeting the primitive way: get_text, wait_for_state, get_text.',
    run: async (driver) => {
      await submitGreeting(driver)
      expectTextContains(
        await call(driver, 'electron_get_text', { selector: '#status' }),
        GREETING,
        'primitive first read',
      )
      expectOk(
        await call(driver, 'electron_wait_for_state', {
          selector: '#status',
          state: { visible: true },
        }),
        'primitive wait for status',
      )
      expectTextContains(
        await call(driver, 'electron_get_text', { selector: '#status' }),
        GREETING,
        'primitive second read',
      )
    },
  },
  {
    name: 'verify-greeting-expect',
    description: 'Verify the same greeting with a single expect_text call.',
    run: async (driver) => {
      await submitGreeting(driver)
      expectOk(
        await call(driver, 'electron_expect_text', {
          selector: '#status',
          contains: GREETING,
        }),
        'expect_text greeting',
      )
    },
  },
  {
    name: 'observe-change-rescan',
    description: 'See what changed after an action by re-scanning the FULL snapshot.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_snapshot'), 'rescan baseline snapshot')
      const refreshRef = await findRef(driver, 'button', 'Refresh list')
      expectOk(await call(driver, 'electron_click', { ref: refreshRef }), 'rescan refresh click')
      // The naive way to find what changed: snapshot the whole tree again.
      expectOk(await call(driver, 'electron_snapshot'), 'rescan full snapshot')
    },
  },
  {
    name: 'observe-change-diff',
    description: 'See the same change by asking for only the delta (snapshot since:last).',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_snapshot'), 'diff baseline snapshot')
      const refreshRef = await findRef(driver, 'button', 'Refresh list')
      expectOk(await call(driver, 'electron_click', { ref: refreshRef }), 'diff refresh click')
      // The agent-native way: ask for only what changed since the last snapshot.
      expectOk(await call(driver, 'electron_snapshot', { since: 'last' }), 'delta snapshot')
    },
  },
  {
    name: 'multi-turn-rescan-30',
    description: 'A 30-turn act-then-observe flow reacting via FULL snapshot re-scans.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_snapshot'), 'multi-turn rescan baseline')
      const refreshRef = await findRef(driver, 'button', 'Refresh list')
      for (let turn = 1; turn <= MULTI_TURN_ROUNDS; turn += 1) {
        expectOk(await call(driver, 'electron_click', { ref: refreshRef }), `turn ${turn} click`)
        expectOk(await call(driver, 'electron_snapshot'), `turn ${turn} full snapshot`)
      }
    },
  },
  {
    name: 'multi-turn-diff-30',
    description: 'The same 30-turn flow reacting via snapshot since:last deltas.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_snapshot'), 'multi-turn diff baseline')
      const refreshRef = await findRef(driver, 'button', 'Refresh list')
      for (let turn = 1; turn <= MULTI_TURN_ROUNDS; turn += 1) {
        expectOk(await call(driver, 'electron_click', { ref: refreshRef }), `turn ${turn} click`)
        expectOk(await call(driver, 'electron_snapshot', { since: 'last' }), `turn ${turn} delta`)
      }
    },
  },
  {
    name: 'error-recovery',
    description:
      'A read errors (SELECTOR_NO_MATCH) before the element exists; expect_visible + re-read recover.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_snapshot'), 'error-recovery baseline snapshot')
      // Read #late BEFORE triggering its load: the element does not exist yet, so this is
      // a deterministic SELECTOR_NO_MATCH (no wall-clock race against the load timer).
      const missed = await call(driver, 'electron_get_text', { selector: '#late' })
      if (missed.ok || missed.code !== 'SELECTOR_NO_MATCH') {
        throw new Error(`expected reading #late before load to return SELECTOR_NO_MATCH`)
      }
      // Recover: trigger the deferred load, wait for the element, then read it.
      const loadRef = await findRef(driver, 'button', 'Load details')
      expectOk(await call(driver, 'electron_click', { ref: loadRef }), 'load details click')
      expectOk(
        await call(driver, 'electron_expect_visible', { selector: '#late' }),
        'wait for late details',
      )
      const recovered = await call(driver, 'electron_get_text', { selector: '#late' })
      expectTextContains(recovered, 'Details loaded', 'recovery read of #late')
    },
  },
]
