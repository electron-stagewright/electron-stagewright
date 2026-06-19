/**
 * Unit tests for the read tools, dispatched against a recording / canned
 * `FakeSession`. The renderer-bundle loader is mocked so the bundle-backed tools
 * (get_state / focused_element / elements_list) stay unit-fast and do not depend
 * on a built `dist/snapshot/injected-walker.js`. Each read body's `{ found, … }`
 * result is supplied via the fake's `evaluate`.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

import { type ErrorResponse, type SuccessResponse } from '../src/errors/envelope.js'
import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { type Snapshot, walkAccessibilityTree } from '../src/snapshot/index.js'
import { READ_TOOLS } from '../src/tools/read/index.js'
import type { TransportCapabilities } from '../src/transports/index.js'
import { FakeSession, FakeTransport, type FakeEvaluate } from './helpers/fake-transport.js'

vi.mock('../src/tools/snapshot/inject.js', () => ({
  buildProbeBody: () => 'PROBE',
  buildWalkBody: () => 'WALK',
  buildRetagBody: () => 'RETAG',
  loadInjectedWalker: () => 'BUNDLE',
}))

function snap(html: string): Snapshot {
  return walkAccessibilityTree(new JSDOM(html).window.document, {})
}

const NO_RENDERER_EVAL_CAPS: TransportCapabilities = {
  canLaunch: true,
  canAttach: true,
  canInject: true,
  canIntercept: true,
  canControlClock: true,
  canAccessStorage: true,
  supportsMainEval: true,
  supportsRendererEval: false,
  supportsInteraction: true,
}

function setup(
  opts: { readonly evaluate?: FakeEvaluate; readonly capabilities?: TransportCapabilities } = {},
) {
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = new FakeSession({
    id: 'sess',
    ...(opts.evaluate !== undefined ? { evaluate: opts.evaluate } : {}),
  })
  const transport =
    opts.capabilities !== undefined
      ? new FakeTransport({ capabilities: opts.capabilities })
      : new FakeTransport()
  sessions.register(transport, session)
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.registerAll(READ_TOOLS)
  return { dispatcher, session, snapshots }
}

/** A fake evaluate that always resolves to `value`, ignoring target/body/arg. */
const canned =
  (value: unknown): FakeEvaluate =>
  async () =>
    value

describe('inline read tools', () => {
  it('electron_get_text returns trimmed text', async () => {
    const { dispatcher } = setup({ evaluate: canned({ found: true, text: 'Hello' }) })
    const res = (await dispatcher.dispatch('electron_get_text', {
      selector: '#h',
    })) as SuccessResponse & { text: string }
    expect(res).toMatchObject({ ok: true, text: 'Hello' })
  })

  it('electron_get_value returns the control value', async () => {
    const { dispatcher } = setup({ evaluate: canned({ found: true, value: 'Ada' }) })
    const res = (await dispatcher.dispatch('electron_get_value', {
      selector: '#n',
    })) as SuccessResponse & { value: string }
    expect(res.value).toBe('Ada')
  })

  it('electron_get_attribute returns null for an absent attribute (not an error)', async () => {
    const { dispatcher } = setup({ evaluate: canned({ found: true, value: null }) })
    const res = (await dispatcher.dispatch('electron_get_attribute', {
      selector: '#a',
      name: 'href',
    })) as SuccessResponse & { value: string | null }
    expect(res).toMatchObject({ ok: true, value: null })
  })

  it('electron_get_bbox returns the box', async () => {
    const { dispatcher } = setup({
      evaluate: canned({ found: true, bbox: { x: 1, y: 2, w: 3, h: 4 } }),
    })
    const res = (await dispatcher.dispatch('electron_get_bbox', {
      selector: '#b',
    })) as SuccessResponse & { bbox: { w: number } }
    expect(res.bbox).toEqual({ x: 1, y: 2, w: 3, h: 4 })
  })

  it('electron_get_computed_style returns only the requested props', async () => {
    const { dispatcher } = setup({ evaluate: canned({ found: true, style: { display: 'flex' } }) })
    const res = (await dispatcher.dispatch('electron_get_computed_style', {
      selector: '#s',
      properties: ['display'],
    })) as SuccessResponse & { style: Record<string, string> }
    expect(res.style).toEqual({ display: 'flex' })
  })

  it('electron_get_computed_style requires at least one property', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_get_computed_style', {
      selector: '#s',
      properties: [],
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('electron_get_computed_style caps the requested property list', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_get_computed_style', {
      selector: '#s',
      properties: Array.from({ length: 51 }, (_, i) => `--p${i}`),
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('electron_exists reports presence without erroring on a miss', async () => {
    const present = setup({ evaluate: canned({ found: true, exists: true }) })
    const a = (await present.dispatcher.dispatch('electron_exists', {
      selector: '#x',
    })) as SuccessResponse & { exists: boolean }
    expect(a).toMatchObject({ ok: true, exists: true })

    const absent = setup({ evaluate: canned({ found: true, exists: false }) })
    const b = (await absent.dispatcher.dispatch('electron_exists', {
      selector: '#x',
    })) as SuccessResponse & { exists: boolean }
    expect(b).toMatchObject({ ok: true, exists: false })
  })

  it('maps an invalid selector to BAD_ARGUMENT instead of INTERNAL_ERROR', async () => {
    const { dispatcher } = setup({
      evaluate: canned({ found: false, invalid_selector: true, error: 'bad selector' }),
    })
    const res = (await dispatcher.dispatch('electron_get_text', {
      selector: ':::',
    })) as ErrorResponse
    expect(res).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
    expect(res.error).toContain('Invalid CSS selector')
  })

  it('electron_exists still errors on an invalid selector', async () => {
    const { dispatcher } = setup({
      evaluate: canned({ found: false, invalid_selector: true, error: 'bad selector' }),
    })
    const res = (await dispatcher.dispatch('electron_exists', {
      selector: ':::',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('maps a found:false read to SELECTOR_NO_MATCH with similar_refs', async () => {
    const { dispatcher, snapshots } = setup({ evaluate: canned({ found: false }) })
    snapshots.set('sess', snap('<button>Save</button><button>Cancel</button>'))
    const res = (await dispatcher.dispatch('electron_get_text', {
      selector: '#missing',
    })) as ErrorResponse
    expect(res.code).toBe('SELECTOR_NO_MATCH')
    expect(res.similar_refs?.map((r) => r.name)).toContain('Save')
  })
})

describe('bundle-backed read tools', () => {
  it('electron_get_state returns the full state envelope', async () => {
    const state = {
      visible: true,
      enabled: true,
      disabled: false,
      checked: null,
      selected: null,
      expanded: null,
      pressed: null,
      focused: false,
      readonly: null,
      required: null,
      invalid: null,
      busy: false,
      shadow_closed: false,
    }
    const { dispatcher } = setup({
      evaluate: canned({ found: true, ref: 2, role: 'button', name: 'Save', state }),
    })
    const res = (await dispatcher.dispatch('electron_get_state', {
      ref: 2,
    })) as SuccessResponse & { role: string; state: { visible: boolean } }
    // No stored snapshot, so the freshness guard does not fire; the probe answers.
    expect(res).toMatchObject({ ok: true, role: 'button', state })
  })

  it('electron_focused_element returns the focused element or null', async () => {
    const focused = setup({
      evaluate: canned({ found: true, ref: 1, role: 'textbox', name: 'Email' }),
    })
    const a = (await focused.dispatcher.dispatch(
      'electron_focused_element',
      {},
    )) as SuccessResponse & {
      focused: { role: string } | null
    }
    expect(a.focused).toEqual({ ref: 1, role: 'textbox', name: 'Email' })

    const none = setup({ evaluate: canned({ found: false }) })
    const b = (await none.dispatcher.dispatch(
      'electron_focused_element',
      {},
    )) as SuccessResponse & {
      focused: unknown
    }
    expect(b.focused).toBeNull()
  })

  it('electron_elements_list returns matches with count and truncation', async () => {
    const { dispatcher } = setup({
      evaluate: canned({
        found: true,
        matches: [{ ref: 1, role: 'button', name: 'A', bbox: { x: 0, y: 0, w: 0, h: 0 } }],
        count: 3,
        truncated: 2,
      }),
    })
    const res = (await dispatcher.dispatch('electron_elements_list', {
      selector: 'button',
      limit: 1,
    })) as SuccessResponse & { count: number; truncated: number; matches: unknown[] }
    expect(res).toMatchObject({ ok: true, count: 3, truncated: 2 })
    expect(res.matches).toHaveLength(1)
  })

  it('electron_elements_list rejects a limit above the ceiling', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_elements_list', {
      selector: 'button',
      limit: 9999,
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('electron_elements_list reports invalid selector syntax as BAD_ARGUMENT', async () => {
    const { dispatcher } = setup({
      evaluate: canned({ found: false, invalid_selector: true, error: 'bad selector' }),
    })
    const res = (await dispatcher.dispatch('electron_elements_list', {
      selector: ':::',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })
})

describe('read-tool target + capability contract', () => {
  it('documents renderer-eval capability failures in each read tool description', () => {
    for (const tool of READ_TOOLS) {
      expect(tool.description, tool.name).toContain('TRANSPORT_UNSUPPORTED')
    }
  })

  it('rejects ref and selector together with BAD_ARGUMENT', async () => {
    const { dispatcher } = setup()
    const res = (await dispatcher.dispatch('electron_get_text', {
      ref: 1,
      selector: '#h',
    })) as ErrorResponse
    expect(res.code).toBe('BAD_ARGUMENT')
  })

  it('guards a stale ref with REF_NOT_FOUND + similar_refs', async () => {
    const { dispatcher, snapshots } = setup()
    snapshots.set('sess', snap('<button>Save</button>'))
    const res = (await dispatcher.dispatch('electron_get_text', { ref: 99 })) as ErrorResponse
    expect(res.code).toBe('REF_NOT_FOUND')
    expect(res.similar_refs?.map((r) => r.name)).toContain('Save')
  })

  it('refuses a transport that cannot evaluate the renderer', async () => {
    const { dispatcher } = setup({ capabilities: NO_RENDERER_EVAL_CAPS })
    const res = (await dispatcher.dispatch('electron_get_text', {
      selector: '#h',
    })) as ErrorResponse
    expect(res.code).toBe('TRANSPORT_UNSUPPORTED')
  })
})
