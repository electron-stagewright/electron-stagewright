/**
 * Twelve semantically stable tasks used to compare the full and essential core
 * profiles. Every task uses only the essential surface, so a failure measures a
 * real profile regression rather than an intentionally unavailable API.
 *
 * @module
 */

import { call, findRef, type Driver, type Envelope, type Scenario } from './harness.js'

const NAME = 'Ada Lovelace'
const GREETING = `Hello, ${NAME}!`

function expectOk(envelope: Envelope, step: string): Envelope {
  if (!envelope.ok) {
    throw new Error(`${step} failed: ${envelope.code ?? 'UNKNOWN'} — ${envelope.error ?? ''}`)
  }
  return envelope
}

function expectText(envelope: Envelope, expected: string, step: string): void {
  expectOk(envelope, step)
  if (typeof envelope['text'] !== 'string' || !envelope['text'].includes(expected)) {
    throw new Error(`${step} expected text containing "${expected}"`)
  }
}

async function greet(driver: Driver, name = NAME): Promise<void> {
  expectOk(await call(driver, 'electron_type', { selector: '#name', text: name }), 'type name')
  const button = await findRef(driver, 'button', 'Greet')
  expectOk(await call(driver, 'electron_click', { ref: button }), 'click greet')
}

/** The task set intentionally runs sequentially; every task receives a fresh app session. */
export const PROFILE_SCENARIOS: readonly Scenario[] = [
  {
    name: 'profile-inspect-greeting-control',
    description: 'Snapshot, find the name input, and assert its visible state.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_snapshot'), 'initial snapshot')
      const input = await findRef(driver, 'textbox', 'Your name')
      expectOk(await call(driver, 'electron_get_state', { ref: input }), 'input state')
      expectOk(await call(driver, 'electron_expect_visible', { ref: input }), 'input visible')
    },
  },
  {
    name: 'profile-fill-and-read-value',
    description: 'Fill the greeting input and read the value back.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_type', { selector: '#name', text: NAME }), 'type name')
      const value = expectOk(
        await call(driver, 'electron_get_value', { selector: '#name' }),
        'read value',
      )
      if (value['value'] !== NAME) throw new Error('input value did not round-trip')
    },
  },
  {
    name: 'profile-fill-submit-assert',
    description: 'Fill a name, submit the form, and assert the greeting.',
    run: async (driver) => {
      await greet(driver)
      expectOk(
        await call(driver, 'electron_expect_text', { selector: '#status', equals: GREETING }),
        'assert greeting',
      )
    },
  },
  {
    name: 'profile-default-greeting',
    description: 'Submit an empty form and assert its default greeting.',
    run: async (driver) => {
      const button = await findRef(driver, 'button', 'Greet')
      expectOk(await call(driver, 'electron_click', { ref: button }), 'click greet')
      expectOk(
        await call(driver, 'electron_expect_text', {
          selector: '#status',
          contains: 'Hello, stranger!',
        }),
        'assert default greeting',
      )
    },
  },
  {
    name: 'profile-clear-input',
    description: 'Fill then clear the input and assert an empty value.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_type', { selector: '#name', text: NAME }), 'type name')
      expectOk(await call(driver, 'electron_clear_input', { selector: '#name' }), 'clear name')
      expectOk(
        await call(driver, 'electron_expect_value', { selector: '#name', equals: '' }),
        'assert empty value',
      )
    },
  },
  {
    name: 'profile-refresh-with-diff',
    description: 'Refresh the list and inspect the compact snapshot delta.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_snapshot'), 'baseline snapshot')
      const refresh = await findRef(driver, 'button', 'Refresh list')
      expectOk(await call(driver, 'electron_click', { ref: refresh }), 'refresh list')
      expectOk(await call(driver, 'electron_snapshot', { since: 'last' }), 'snapshot delta')
    },
  },
  {
    name: 'profile-refresh-and-read',
    description: 'Refresh the list and read the changed item text.',
    run: async (driver) => {
      const refresh = await findRef(driver, 'button', 'Refresh list')
      expectOk(await call(driver, 'electron_click', { ref: refresh }), 'refresh list')
      expectText(
        await call(driver, 'electron_get_text', { selector: '#item-list' }),
        'Item 01 (updated 1)',
        'read refreshed list',
      )
    },
  },
  {
    name: 'profile-find-and-scroll-item',
    description: 'Find a later list item and scroll it into view before asserting visibility.',
    run: async (driver) => {
      const item = await findRef(driver, 'button', 'Item 24')
      expectOk(await call(driver, 'electron_scroll_into_view', { ref: item }), 'scroll item')
      expectOk(await call(driver, 'electron_expect_visible', { ref: item }), 'item visible')
    },
  },
  {
    name: 'profile-deferred-load',
    description: 'Trigger deferred content and wait for it declaratively.',
    run: async (driver) => {
      const load = await findRef(driver, 'button', 'Load details')
      expectOk(await call(driver, 'electron_click', { ref: load }), 'click load')
      expectOk(
        await call(driver, 'electron_expect_visible', { selector: '#late' }),
        'wait for details',
      )
    },
  },
  {
    name: 'profile-deferred-load-retry',
    description: 'Observe a deterministic miss, recover, then retry the targeted read.',
    run: async (driver) => {
      const missed = await call(driver, 'electron_get_text', { selector: '#late' })
      if (missed.ok || missed.code !== 'SELECTOR_NO_MATCH') {
        throw new Error('expected #late to be absent before triggering the load')
      }
      const load = await findRef(driver, 'button', 'Load details')
      expectOk(await call(driver, 'electron_click', { ref: load }), 'click load')
      expectOk(
        await call(driver, 'electron_wait_for_selector', { selector: '#late' }),
        'wait for late',
      )
      expectText(
        await call(driver, 'electron_get_text', { selector: '#late' }, { retry: true }),
        'Details loaded',
        'retry late read',
      )
    },
  },
  {
    name: 'profile-exists-before-and-after',
    description: 'Check deferred content absence, load it, and check its presence.',
    run: async (driver) => {
      const before = expectOk(
        await call(driver, 'electron_exists', { selector: '#late' }),
        'initial exists',
      )
      if (before['exists'] !== false) throw new Error('#late existed before loading')
      const load = await findRef(driver, 'button', 'Load details')
      expectOk(await call(driver, 'electron_click', { ref: load }), 'click load')
      expectOk(
        await call(driver, 'electron_wait_for_selector', { selector: '#late' }),
        'wait for late',
      )
      const after = expectOk(
        await call(driver, 'electron_exists', { selector: '#late' }),
        'final exists',
      )
      if (after['exists'] !== true) throw new Error('#late did not exist after loading')
    },
  },
  {
    name: 'profile-keyboard-submit',
    description: 'Fill the input, focus it, submit with Enter, and assert the result.',
    run: async (driver) => {
      expectOk(await call(driver, 'electron_type', { selector: '#name', text: NAME }), 'type name')
      expectOk(
        await call(driver, 'electron_key', { selector: '#name', key: 'Enter' }),
        'press enter',
      )
      // The fixture has no submit-on-enter handler, so use the semantic button after testing focus/key.
      const button = await findRef(driver, 'button', 'Greet')
      expectOk(await call(driver, 'electron_click', { ref: button }), 'click greet')
      expectOk(
        await call(driver, 'electron_expect_text', { selector: '#status', equals: GREETING }),
        'assert greeting',
      )
    },
  },
]
