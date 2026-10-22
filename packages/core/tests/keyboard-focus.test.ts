/**
 * Unit tests for focus-aware keyboard input: `electron_keyboard_type`, `electron_key` and
 * `electron_press_sequence` report where the keys went (`focused`), can wait for an editable
 * element to take focus (`waitForFocusMs`), and can refuse to type into nothing
 * (`requireEditable` → `NO_FOCUSED_EDITABLE`).
 */

import { describe, expect, it, vi } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import {
  makeKeyboardTypeTool,
  makeKeyTool,
  makePressSequenceTool,
} from '../src/tools/interaction/keyboard.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

const deps = { loadBundle: () => 'BUNDLE' }
const BUTTON = { found: true, role: 'button', name: 'Open palette', editable: false }
const INPUT = { found: true, role: 'combobox', name: 'Search commands', editable: true }

function setup(evaluate: FakeEvaluate) {
  const sessions = new SessionManager()
  const session = new FakeSession({ id: 'sess', evaluate })
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions, snapshots: new SnapshotStore() })
  dispatcher.registerAll([
    makeKeyboardTypeTool(deps),
    makeKeyTool(deps),
    makePressSequenceTool(deps),
  ])
  return { dispatcher, session }
}

/** An evaluate that answers the focus probe from `sequence`, repeating its last entry. */
function focusSequence(sequence: readonly unknown[]): { evaluate: FakeEvaluate; args: unknown[] } {
  const args: unknown[] = []
  const evaluate: FakeEvaluate = async (_target, _body, arg) => {
    args.push(arg)
    return sequence[Math.min(args.length - 1, sequence.length - 1)]
  }
  return { evaluate, args }
}

describe('focus reporting', () => {
  it('reports the focused element the keys went to', async () => {
    const { dispatcher, session } = setup(focusSequence([INPUT]).evaluate)
    const res = (await dispatcher.dispatch('electron_keyboard_type', {
      text: 'theme',
    })) as SuccessResponse & { focused: unknown; typed: number }
    expect(res).toMatchObject({
      ok: true,
      typed: 5,
      focused: { role: 'combobox', name: 'Search commands', editable: true },
    })
    expect(session.interactions.map((i) => i.method)).toEqual(['typeText'])
  })

  it('shows that keys went to a non-editable element without failing by default', async () => {
    const { dispatcher, session } = setup(focusSequence([BUTTON]).evaluate)
    const res = await dispatcher.dispatch('electron_keyboard_type', { text: 'theme' })
    expect(res).toMatchObject({ ok: true, focused: { role: 'button', editable: false } })
    expect(session.interactions).toHaveLength(1)
  })

  it('reports null when nothing has focus', async () => {
    const { dispatcher } = setup(focusSequence([{ found: false }]).evaluate)
    await expect(dispatcher.dispatch('electron_key', { key: 'Enter' })).resolves.toMatchObject({
      ok: true,
      key: 'Enter',
      focused: null,
    })
  })

  it('describes the target, not the previous focus, when a selector is given', async () => {
    const probe = focusSequence([INPUT])
    const { dispatcher } = setup(probe.evaluate)
    await dispatcher.dispatch('electron_press_sequence', {
      selector: '#search',
      keys: ['ArrowDown', 'Enter'],
    })
    expect(probe.args[0]).toEqual({ selector: '#search' })
  })

  it('still types when the focus read fails and no focus option was asked for', async () => {
    const { dispatcher, session } = setup(async () => {
      throw new Error('probe failed')
    })
    const res = await dispatcher.dispatch('electron_keyboard_type', { text: 'x' })
    expect(res).toMatchObject({ ok: true, focused: null })
    expect(session.interactions.map((i) => i.method)).toEqual(['typeText'])
  })
})

describe('waitForFocusMs', () => {
  it('waits until an editable element takes focus, then types', async () => {
    vi.useFakeTimers()
    try {
      const probe = focusSequence([BUTTON, BUTTON, INPUT])
      const { dispatcher, session } = setup(probe.evaluate)
      const pending = dispatcher.dispatch('electron_keyboard_type', {
        text: 'theme',
        waitForFocusMs: 500,
      })
      await vi.advanceTimersByTimeAsync(100)
      const res = await pending
      expect(res).toMatchObject({ ok: true, focused: { editable: true } })
      expect(probe.args).toHaveLength(3)
      expect(session.interactions.map((i) => i.method)).toEqual(['typeText'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('types after the wait expires and reports where the keys went', async () => {
    vi.useFakeTimers()
    try {
      const { dispatcher, session } = setup(focusSequence([BUTTON]).evaluate)
      const pending = dispatcher.dispatch('electron_keyboard_type', {
        text: 'x',
        waitForFocusMs: 100,
      })
      await vi.advanceTimersByTimeAsync(200)
      await expect(pending).resolves.toMatchObject({ ok: true, focused: { editable: false } })
      expect(session.interactions).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops waiting and sends no keys once the request is cancelled', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const { dispatcher, session } = setup(focusSequence([BUTTON]).evaluate)
      const pending = dispatcher.dispatch(
        'electron_keyboard_type',
        { text: 'x', waitForFocusMs: 5000 },
        { signal: controller.signal },
      )
      await vi.advanceTimersByTimeAsync(50)
      controller.abort()
      await expect(pending).resolves.toMatchObject({ code: 'OPERATION_CANCELLED' })
      expect(vi.getTimerCount()).toBe(0)
      expect(session.interactions).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait when a target is given', async () => {
    const probe = focusSequence([BUTTON])
    const { dispatcher } = setup(probe.evaluate)
    await dispatcher.dispatch('electron_key', {
      selector: '#go',
      key: 'Enter',
      waitForFocusMs: 5000,
    })
    expect(probe.args).toHaveLength(1)
  })
})

describe('requireEditable', () => {
  it('fails with NO_FOCUSED_EDITABLE and sends no keys when focus is not editable', async () => {
    const { dispatcher, session } = setup(focusSequence([BUTTON]).evaluate)
    const res = (await dispatcher.dispatch('electron_keyboard_type', {
      text: 'theme',
      requireEditable: true,
    })) as ErrorResponse
    expect(res).toMatchObject({
      ok: false,
      code: 'NO_FOCUSED_EDITABLE',
      retryable: true,
      details: { focused: { role: 'button', editable: false } },
    })
    expect(res.error).toContain('Open palette')
    expect(session.interactions).toEqual([])
  })

  it('fails when nothing has focus', async () => {
    const { dispatcher } = setup(focusSequence([{ found: false }]).evaluate)
    await expect(
      dispatcher.dispatch('electron_press_sequence', { keys: ['a'], requireEditable: true }),
    ).resolves.toMatchObject({ code: 'NO_FOCUSED_EDITABLE', details: { focused: null } })
  })

  it('leaves a missing target to the transport miss instead', async () => {
    const { dispatcher, session } = setup(focusSequence([{ found: false }]).evaluate)
    await dispatcher.dispatch('electron_key', {
      selector: '#gone',
      key: 'Enter',
      requireEditable: true,
    })
    expect(session.interactions.map((i) => i.method)).toEqual(['press'])
  })

  it('does not type when the focus read fails', async () => {
    const { dispatcher, session } = setup(async () => {
      throw new Error('probe failed')
    })
    const res = await dispatcher.dispatch('electron_keyboard_type', {
      text: 'x',
      requireEditable: true,
    })
    expect(res).toMatchObject({ ok: false })
    expect(session.interactions).toEqual([])
  })

  it('names a long focused element briefly in the error message', async () => {
    const long = { ...BUTTON, name: 'x'.repeat(500) }
    const { dispatcher } = setup(focusSequence([long]).evaluate)
    const res = (await dispatcher.dispatch('electron_keyboard_type', {
      text: 'x',
      requireEditable: true,
    })) as ErrorResponse
    expect(res.code).toBe('NO_FOCUSED_EDITABLE')
    expect(res.error.length).toBeLessThan(150)
  })

  it('passes when the keys go to an editable element', async () => {
    const { dispatcher } = setup(focusSequence([INPUT]).evaluate)
    await expect(
      dispatcher.dispatch('electron_keyboard_type', { text: 'x', requireEditable: true }),
    ).resolves.toMatchObject({ ok: true })
  })
})
