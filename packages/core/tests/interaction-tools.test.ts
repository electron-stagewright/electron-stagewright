/**
 * Unit tests for the interaction tools, dispatched against a recording
 * `FakeSession`. Cover the option mapping each tool sends to the transport, the
 * ref/selector contract, set_files path validation, the ref-freshness guard, and
 * the failure-to-error-code diagnosis (with similar_refs).
 */

import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { StagewrightError } from '../src/errors/registry.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import { INTERACTION_TOOLS } from '../src/tools/interaction/index.js'
import type { TransportCapabilities } from '../src/transports/index.js'
import { FakeSession, FakeTransport, type FakeSessionOptions } from './helpers/fake-transport.js'

const THIS_FILE = fileURLToPath(import.meta.url)

function snap(html: string): Snapshot {
  return walkAccessibilityTree(new JSDOM(html).window.document, {})
}

const NO_INTERACTION_CAPS: TransportCapabilities = {
  canLaunch: true,
  canAttach: true,
  canInject: true,
  canIntercept: true,
  canControlClock: true,
  canAccessStorage: true,
  canAccessNativeUI: true,
  supportsMainEval: true,
  supportsRendererEval: true,
  supportsInteraction: false,
}

function setup(
  sessionOpts: FakeSessionOptions = {},
  opts: { readonly capabilities?: TransportCapabilities } = {},
) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = new FakeSession({ id: 'sess', ...sessionOpts })
  const transport =
    opts.capabilities !== undefined
      ? new FakeTransport({ capabilities: opts.capabilities })
      : new FakeTransport()
  sessions.register(transport, session)
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.registerAll(INTERACTION_TOOLS)
  return { dispatcher, session, snapshots }
}

type Recorded = { readonly method: string; readonly args: readonly unknown[] }

describe('electron_click', () => {
  it('forwards button + clickCount + a bounded timeout to the transport', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_click', {
      selector: '#go',
      button: 'right',
      clickCount: 2,
    })) as SuccessResponse & { target: string }
    expect(res.ok).toBe(true)
    expect(res.target).toBe('#go')
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'click', args: ['#go', { timeoutMs: 5000, button: 'right', clickCount: 2 }] },
    ])
  })

  it('resolves a ref to the data-sw-ref selector', async () => {
    const { dispatcher, session, snapshots } = setup()
    snapshots.set('sess', snap('<button>A</button><button>B</button>'))
    await dispatcher.dispatch('electron_click', { ref: 2 })
    expect(session.interactions[0]?.args[0]).toBe('[data-sw-ref="2"]')
  })

  it('rejects ref and selector together with BAD_ARGUMENT', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_click', {
      ref: 1,
      selector: '#go',
    })) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
  })

  it('rejects an interaction-unsupported transport before touching the session', async () => {
    const { dispatcher, session } = setup({}, { capabilities: NO_INTERACTION_CAPS })
    const res = (await dispatcher.dispatch('electron_click', {
      selector: '#go',
    })) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'TRANSPORT_UNSUPPORTED' })
    expect(session.interactions).toHaveLength(0)
  })
})

describe('electron_drag', () => {
  it('forwards source + target selectors with bounded options', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_drag', {
      selector: '#src',
      targetSelector: '#dst',
      force: true,
    })) as SuccessResponse & { source: string; target: string }
    expect(res).toMatchObject({ ok: true, source: '#src', target: '#dst' })
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'dragTo', args: ['#src', '#dst', { force: true, timeoutMs: 5000 }] },
    ])
  })

  it('resolves both sides from refs', async () => {
    const { dispatcher, session, snapshots } = setup()
    snapshots.set('sess', snap('<button>A</button><button>B</button>'))
    await dispatcher.dispatch('electron_drag', { ref: 1, targetRef: 2 })
    expect(session.interactions[0]?.args.slice(0, 2)).toEqual([
      '[data-sw-ref="1"]',
      '[data-sw-ref="2"]',
    ])
  })

  it('guards a stale source ref before touching the transport', async () => {
    const { dispatcher, session, snapshots } = setup()
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_drag', {
      ref: 99,
      targetSelector: '#dst',
    })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(session.interactions).toHaveLength(0)
  })

  it('guards a stale target ref too', async () => {
    const { dispatcher, session, snapshots } = setup()
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_drag', {
      selector: '#src',
      targetRef: 99,
    })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(session.interactions).toHaveLength(0)
  })

  it('rejects ref and selector on the same side with BAD_ARGUMENT', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_drag', {
      ref: 1,
      selector: '#src',
      targetSelector: '#dst',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })
})

describe('text + keyboard tools', () => {
  it('electron_type fills the value', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_type', { selector: '#name', text: 'Ada' })
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'fill', args: ['#name', 'Ada', { timeoutMs: 5000 }] },
    ])
  })

  it('rejects a press sequence longer than the cap (BAD_ARGUMENT, no unbounded loop)', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_press_sequence', {
      keys: Array.from({ length: 101 }, () => 'a'),
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('rejects keyboard_type text longer than the keystroke cap (BAD_ARGUMENT)', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_keyboard_type', {
      text: 'a'.repeat(10_001),
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('electron_keyboard_type types globally when no target is given', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_keyboard_type', {
      text: 'hi',
    })) as SuccessResponse & { typed: number }
    expect(res.typed).toBe(2)
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'typeText', args: ['hi', { timeoutMs: 5000 }] },
    ])
  })

  it('electron_keyboard_type forwards force to the transport (offscreen editor inputs)', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_keyboard_type', {
      selector: '.monaco-editor textarea',
      text: 'x',
      force: true,
    })
    expect(session.interactions).toEqual<Recorded[]>([
      {
        method: 'typeText',
        args: ['x', { selector: '.monaco-editor textarea', force: true, timeoutMs: 5000 }],
      },
    ])
  })

  it('electron_type_into_editor clicks the content area then types into the active element', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_type_into_editor', {
      selector: '.monaco-editor .view-lines',
      text: 'hello',
    })
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'click', args: ['.monaco-editor .view-lines', { timeoutMs: 5000 }] },
      { method: 'typeText', args: ['hello', undefined] },
    ])
  })

  it('electron_type_into_editor rejects when click-then-type leaves the editor unchanged', async () => {
    const { dispatcher } = setup({
      evaluate: async (_target, _body, arg) => {
        const input = arg as { readonly selector?: unknown; readonly settleMs?: unknown }
        if (input.selector === '.monaco-editor .view-lines' && 'settleMs' in input) return ''
        return undefined
      },
    })
    const res = (await dispatcher.dispatch('electron_type_into_editor', {
      selector: '.monaco-editor .view-lines',
      text: 'hello',
    })) as ErrorResponse
    expect(res.code).toBe('TYPE_NO_EFFECT')
    expect(res.retryable).toBe(false)
  })

  it('maps a TYPE_NO_EFFECT transport failure to the envelope with recovery next_actions', async () => {
    const { dispatcher } = setup({
      interactionError: new StagewrightError('TYPE_NO_EFFECT', 'editable content did not change', {
        selector: '.monaco-editor textarea',
      }),
    })
    const res = (await dispatcher.dispatch('electron_keyboard_type', {
      selector: '.monaco-editor textarea',
      text: 'x',
      force: true,
    })) as ErrorResponse
    expect(res.code).toBe('TYPE_NO_EFFECT')
    expect(res.retryable).toBe(false)
    expect(res.next_actions).toEqual([
      'electron_type_into_editor({ selector: "<editor content area, e.g. \'.monaco-editor .view-lines\'>", text })',
      'If custom focus is needed: electron_click({ selector: "<editor content area>" }) then electron_keyboard_type({ text }) with no selector.',
    ])
  })

  it('electron_key presses globally; focusing a ref when given', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_key', { key: 'Enter' })
    await dispatcher.dispatch('electron_key', { key: 'Tab', ref: 3 })
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'press', args: ['Enter', { timeoutMs: 5000 }] },
      { method: 'press', args: ['Tab', { selector: '[data-sw-ref="3"]', timeoutMs: 5000 }] },
    ])
  })

  it('electron_press_sequence with force focuses the selector once, then presses globally', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_press_sequence', {
      selector: '.monaco-editor textarea',
      keys: ['Control+A', 'Delete', 'Enter'],
      force: true,
    })
    // First key carries the focus target; the rest press the active element so a popup
    // opened mid-sequence is not dismissed by re-focusing the editor textarea.
    expect(session.interactions).toEqual<Recorded[]>([
      {
        method: 'press',
        args: ['Control+A', { selector: '.monaco-editor textarea', force: true, timeoutMs: 5000 }],
      },
      { method: 'press', args: ['Delete', {}] },
      { method: 'press', args: ['Enter', {}] },
    ])
  })

  it('electron_key guards a stale optional ref before touching the transport', async () => {
    const { dispatcher, session, snapshots } = setup()
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_key', {
      key: 'Enter',
      ref: 99,
    })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(session.interactions).toHaveLength(0)
  })

  it('electron_press_sequence presses each key in order', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_press_sequence', { keys: ['Control+A', 'Delete'] })
    expect(session.interactions.map((i) => i.args[0])).toEqual(['Control+A', 'Delete'])
  })

  it('electron_clear_input fills empty', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_clear_input', { selector: '#n' })
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'fill', args: ['#n', '', { timeoutMs: 5000 }] },
    ])
  })
})

describe('form tools', () => {
  it('electron_select_option returns the selected values', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_select_option', {
      selector: '#s',
      values: ['x', 'y'],
    })) as SuccessResponse & { selected: readonly string[] }
    expect(res.selected).toEqual(['x', 'y'])
    expect(session.interactions[0]).toEqual<Recorded>({
      method: 'selectOption',
      args: ['#s', ['x', 'y'], { timeoutMs: 5000 }],
    })
  })

  it('electron_check / electron_uncheck route to setChecked', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_check', { selector: '#c' })
    await dispatcher.dispatch('electron_uncheck', { selector: '#c' })
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'setChecked', args: ['#c', true, { timeoutMs: 5000 }] },
      { method: 'setChecked', args: ['#c', false, { timeoutMs: 5000 }] },
    ])
  })

  it('electron_set_files attaches existing absolute paths', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_set_files', {
      selector: '#f',
      paths: [THIS_FILE],
    })) as SuccessResponse & { files: number }
    expect(res.files).toBe(1)
    expect(session.interactions[0]?.method).toBe('setInputFiles')
  })

  it('electron_set_files rejects a relative path with ABSOLUTE_PATH_REQUIRED', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_set_files', {
      selector: '#f',
      paths: ['relative/file.txt'],
    })) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'ABSOLUTE_PATH_REQUIRED' })
    expect(session.interactions).toHaveLength(0)
  })

  it('electron_set_files rejects a missing path with FILE_NOT_FOUND', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_set_files', {
      selector: '#f',
      paths: ['/nonexistent/path/to/file.bin'],
    })) as ErrorResponse
    expect(res.code).toBe('FILE_NOT_FOUND')
  })

  it('electron_set_files rejects too many files with BAD_ARGUMENT', async () => {
    const { dispatcher } = setup()
    const paths = Array.from({ length: 21 }, () => THIS_FILE)
    const res = (await dispatcher.dispatch('electron_set_files', {
      selector: '#f',
      paths,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })
})

describe('scroll tools', () => {
  it('electron_scroll dispatches a wheel delta with no target', async () => {
    const { dispatcher, session } = setup()
    const res = (await dispatcher.dispatch('electron_scroll', {
      dy: 480,
    })) as SuccessResponse & { dy: number }
    expect(res.dy).toBe(480)
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'scroll', args: [{ dy: 480, timeoutMs: 5000 }] },
    ])
  })

  it('electron_scroll_into_view scrolls the resolved selector', async () => {
    const { dispatcher, session } = setup()
    await dispatcher.dispatch('electron_scroll_into_view', { selector: '#deep' })
    expect(session.interactions).toEqual<Recorded[]>([
      { method: 'scroll', args: [{ selector: '#deep', timeoutMs: 5000 }] },
    ])
  })

  it('electron_scroll guards a stale optional ref before touching the transport', async () => {
    const { dispatcher, session, snapshots } = setup()
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_scroll', {
      ref: 99,
    })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(session.interactions).toHaveLength(0)
  })
})

describe('failure diagnosis', () => {
  it('maps a disabled-element throw to ELEMENT_DISABLED with a recovery hint', async () => {
    const { dispatcher } = setup({ interactionError: new Error('element is not enabled') })
    const res = (await dispatcher.dispatch('electron_click', { selector: '#go' })) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'ELEMENT_DISABLED' })
    expect(res.next_actions).toContain('electron_snapshot()')
  })

  it('maps a not-visible throw to ELEMENT_NOT_VISIBLE (retryable)', async () => {
    const { dispatcher } = setup({ interactionError: new Error('element is not visible') })
    const res = (await dispatcher.dispatch('electron_click', { selector: '#go' })) as ErrorResponse
    expect(res.code).toBe('ELEMENT_NOT_VISIBLE')
    expect(res.retryable).toBe(true)
  })

  it('attaches similar_refs on a SELECTOR_NO_MATCH', async () => {
    const { dispatcher, snapshots } = setup({
      interactionError: new StagewrightError('SELECTOR_NO_MATCH', 'no element'),
    })
    snapshots.set('sess', snap('<button>Save</button><button>Cancel</button>'))
    const res = (await dispatcher.dispatch('electron_click', {
      selector: '#missing',
    })) as ErrorResponse
    expect(res.code).toBe('SELECTOR_NO_MATCH')
    expect(res.similar_refs?.length).toBeGreaterThan(0)
    expect(res.similar_refs?.map((r) => r.name)).toContain('Save')
  })
})

describe('ref-freshness guard', () => {
  it('fails fast with REF_NOT_FOUND + similar_refs when the ref is absent from the latest snapshot', async () => {
    const { dispatcher, session, snapshots } = setup()
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_click', { ref: 99 })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(res.similar_refs?.map((r) => r.name)).toContain('Save')
    // The transport must never be touched once the ref is known-stale.
    expect(session.interactions).toHaveLength(0)
  })

  it('lets a ref through when it is present in the latest snapshot', async () => {
    const { dispatcher, session, snapshots } = setup()
    snapshots.set('sess', snap('<button>Save</button>'))
    await dispatcher.dispatch('electron_click', { ref: 1 })
    expect(session.interactions[0]?.args[0]).toBe('[data-sw-ref="1"]')
  })
})
