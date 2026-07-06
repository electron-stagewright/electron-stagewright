/**
 * Unit tests for the CDP interaction surface — Input.dispatch* synthesis over
 * the fake CDP endpoint. Covers the chord parser, pointer events at the
 * eval-resolved centre, the light actionability checks (and force bypass),
 * value-setting bodies, DOM.setFileInputFiles, drag, and wheel scrolling.
 *
 * The real-renderer behaviour is covered by the gated `cdp-attach-smoke`.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { CDPTransport, type FetchJson } from '../src/transports/cdp.js'
import { parseKeyChord, SELECT_OPTION_BODY } from '../src/transports/cdp-interaction.js'
import { FakeCdpServer, type Json } from './helpers/fake-cdp.js'

const BROWSER_WS = 'ws://127.0.0.1:9222/devtools/browser/b1'
const PAGE_T1_WS = 'ws://127.0.0.1:9222/devtools/page/T1'

interface PointOverrides {
  readonly status?: string
  readonly visible?: boolean
  readonly disabled?: boolean
}

function setup(point: PointOverrides = {}) {
  const server = new FakeCdpServer()
  const fetchJson: FetchJson = async (url) => {
    if (url.endsWith('/json/version')) return { webSocketDebuggerUrl: BROWSER_WS }
    if (url.endsWith('/json/list')) {
      return [
        { id: 'T1', type: 'page', title: 'Main', url: 'app://x', webSocketDebuggerUrl: PAGE_T1_WS },
      ]
    }
    throw new Error(`unexpected url ${url}`)
  }
  // Route Runtime.evaluate by body content: point resolution, focus, fill,
  // select, checked-state, and viewport-centre each return their fixture.
  server.respond('Runtime.evaluate', (params) => {
    const expr = String(params?.['expression'] ?? '')
    if (expr.includes('scrollIntoView({ block')) {
      return {
        result: {
          value: {
            status: point.status ?? 'ok',
            x: 100,
            y: 40,
            visible: point.visible ?? true,
            disabled: point.disabled ?? false,
          },
        },
      }
    }
    if (expr.includes('el.focus();') && expr.includes("return { status: 'ok' };")) {
      return { result: { value: { status: point.status ?? 'ok' } } }
    }
    if (expr.includes("dispatchEvent(new Event('input'")) {
      // FILL_BODY and SELECT_OPTION_BODY both fire input/change.
      if (expr.includes('option.selected')) {
        return { result: { value: { status: point.status ?? 'ok', selected: ['pear'] } } }
      }
      return { result: { value: { status: point.status ?? 'ok' } } }
    }
    if (expr.includes('checked: el.checked === true')) {
      return {
        result: {
          value: { status: 'ok', checked: false, disabled: point.disabled ?? false },
        },
      }
    }
    if (expr.includes('window.innerWidth')) {
      return { result: { value: { x: 400, y: 300 } } }
    }
    return { result: { value: true } }
  })
  const transport = new CDPTransport({
    wsFactory: server.factory,
    fetchJson,
    killProcess: () => {},
    defaultMethodTimeoutMs: 500,
  })
  const inputEvents = () =>
    server.sentTo('page/T1', 'Input.dispatchMouseEvent').map((f) => f.params as Json)
  const keyEvents = () =>
    server.sentTo('page/T1', 'Input.dispatchKeyEvent').map((f) => f.params as Json)
  return { server, transport, inputEvents, keyEvents }
}

describe('parseKeyChord', () => {
  it('parses named keys, single characters, and modifier chords', () => {
    expect(parseKeyChord('Enter')).toMatchObject({ key: 'Enter', windowsVirtualKeyCode: 13 })
    expect(parseKeyChord('a')).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' })
    expect(parseKeyChord('Control+A')).toMatchObject({ key: 'A', code: 'KeyA', modifiers: 2 })
    expect(parseKeyChord('Meta+Shift+z')).toMatchObject({ modifiers: 4 | 8, code: 'KeyZ' })
  })

  it('suppresses text insertion under ctrl/meta', () => {
    expect(parseKeyChord('Control+A').text).toBeUndefined()
    expect(parseKeyChord('Shift+a').text).toBe('A')
  })

  it('rejects unsupported modifiers and keys with BAD_ARGUMENT', () => {
    expect(() => parseKeyChord('Hyper+A')).toThrowError(/Unsupported modifier/)
    expect(() => parseKeyChord('NumLock')).toThrowError(/Unsupported key/)
    expect(() => parseKeyChord('Control+')).toThrowError(/has no key/)
  })

  it('parses a literal + key, bare and with a modifier', () => {
    // '+'.split('+') === ['', ''] and 'Control++'.split('+') === ['Control','','']: the
    // real key is the trailing '+', which must not be mistaken for "no key".
    expect(parseKeyChord('+')).toMatchObject({ key: '+', text: '+', modifiers: 0 })
    expect(parseKeyChord('Control++')).toMatchObject({ key: '+', modifiers: 2 })
  })
})

describe('CDP pointer interaction', () => {
  it('clicks at the eval-resolved element centre with button + clickCount', async () => {
    const { transport, inputEvents } = setup()
    const session = await transport.attach({ port: 9222 })

    await session.click('#go', { button: 'right', clickCount: 2 })

    expect(inputEvents()).toEqual([
      { type: 'mouseMoved', x: 100, y: 40, button: 'none' },
      { type: 'mousePressed', x: 100, y: 40, button: 'right', clickCount: 1 },
      { type: 'mouseReleased', x: 100, y: 40, button: 'right', clickCount: 1 },
      { type: 'mousePressed', x: 100, y: 40, button: 'right', clickCount: 2 },
      { type: 'mouseReleased', x: 100, y: 40, button: 'right', clickCount: 2 },
    ])
  })

  it('refuses a missing target with SELECTOR_NO_MATCH', async () => {
    const { transport } = setup({ status: 'no-match' })
    const session = await transport.attach({ port: 9222 })
    await expect(session.click('#gone')).rejects.toMatchObject({ code: 'SELECTOR_NO_MATCH' })
  })

  it('refuses invisible/disabled targets retryably — and force bypasses', async () => {
    const { transport } = setup({ visible: false })
    const session = await transport.attach({ port: 9222 })
    await expect(session.click('#hidden')).rejects.toMatchObject({ code: 'ELEMENT_NOT_VISIBLE' })
    await expect(session.click('#hidden', { force: true })).resolves.toBeUndefined()

    const disabled = setup({ disabled: true })
    const disabledSession = await disabled.transport.attach({ port: 9222 })
    await expect(disabledSession.click('#off')).rejects.toMatchObject({
      code: 'ELEMENT_DISABLED',
    })
  })

  it('drags from source centre to target centre with the left button held', async () => {
    const { transport, inputEvents } = setup()
    const session = await transport.attach({ port: 9222 })

    await session.dragTo('#src', '#dst')

    expect(inputEvents().map((e) => e['type'])).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseMoved',
      'mouseReleased',
    ])
  })

  it('releases the held button when the drop target cannot be resolved', async () => {
    const { server, transport, inputEvents } = setup()
    // The eval expression embeds the selector arg, so point resolution can be
    // routed per target: the source resolves, the drop target does not.
    server.respond('Runtime.evaluate', (params) => {
      const expr = String(params?.['expression'] ?? '')
      if (expr.includes('#gone')) return { result: { value: { status: 'no-match' } } }
      return {
        result: { value: { status: 'ok', x: 100, y: 40, visible: true, disabled: false } },
      }
    })
    const session = await transport.attach({ port: 9222 })

    await expect(session.dragTo('#src', '#gone')).rejects.toMatchObject({
      code: 'SELECTOR_NO_MATCH',
    })
    // The press must be undone at the source — a stuck left button would
    // corrupt every later pointer interaction on the page.
    expect(inputEvents().map((e) => e['type'])).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ])
    expect(inputEvents().at(-1)).toMatchObject({ x: 100, y: 40, button: 'left' })
  })

  it('scrolls the viewport with a wheel event at its centre', async () => {
    const { transport, inputEvents } = setup()
    const session = await transport.attach({ port: 9222 })

    await session.scroll({ dy: 480 })

    expect(inputEvents()).toEqual([{ type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 480 }])
  })
})

describe('CDP keyboard interaction', () => {
  it('presses a chord as keyDown/keyUp with the modifier mask', async () => {
    const { transport, keyEvents } = setup()
    const session = await transport.attach({ port: 9222 })

    await session.press('Control+A')

    expect(keyEvents()).toEqual([
      {
        type: 'rawKeyDown',
        modifiers: 2,
        key: 'A',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
      },
      { type: 'keyUp', modifiers: 2, key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65 },
    ])
  })

  it('focuses the selector first when one is given', async () => {
    const { transport, server } = setup()
    const session = await transport.attach({ port: 9222 })

    await session.press('Enter', { selector: '#input' })

    const evals = server.sentTo('page/T1', 'Runtime.evaluate')
    expect(evals.some((f) => String(f.params?.['expression']).includes('el.focus()'))).toBe(true)
  })

  it('types text as per-character keyDown/keyUp pairs', async () => {
    const { transport, keyEvents } = setup()
    const session = await transport.attach({ port: 9222 })

    await session.typeText('hi')

    expect(keyEvents()).toEqual([
      { type: 'keyDown', key: 'h', text: 'h', unmodifiedText: 'h' },
      { type: 'keyUp', key: 'h' },
      { type: 'keyDown', key: 'i', text: 'i', unmodifiedText: 'i' },
      { type: 'keyUp', key: 'i' },
    ])
  })
})

describe('CDP value-setting interaction', () => {
  it('fills via the renderer body and maps failure statuses', async () => {
    const { transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await expect(session.fill('#name', 'Ada')).resolves.toBeUndefined()

    const missing = setup({ status: 'no-match' })
    const missingSession = await missing.transport.attach({ port: 9222 })
    await expect(missingSession.fill('#gone', 'x')).rejects.toMatchObject({
      code: 'SELECTOR_NO_MATCH',
    })
  })

  it('selects options and returns the values actually selected', async () => {
    const { transport } = setup()
    const session = await transport.attach({ port: 9222 })
    await expect(session.selectOption('#fruit', ['pear'])).resolves.toEqual(['pear'])

    const missing = setup({ status: 'option-missing' })
    const missingSession = await missing.transport.attach({ port: 9222 })
    await expect(missingSession.selectOption('#fruit', ['missing'])).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    })
  })

  it('returns the post-mutation selection for single-select elements', async () => {
    const dom = new JSDOM(
      '<!doctype html><select id="fruit"><option value="apple">Apple</option><option value="pear">Pear</option></select>',
      { runScripts: 'outside-only' },
    )
    const run = dom.window.eval(`(async (arg) => { ${SELECT_OPTION_BODY} })`) as (arg: {
      selector: string
      values: readonly string[]
    }) => Promise<unknown>

    await expect(run({ selector: '#fruit', values: ['apple', 'pear'] })).resolves.toEqual({
      status: 'ok',
      selected: ['pear'],
    })
  })

  it('setChecked clicks only when the state differs', async () => {
    const { transport, inputEvents } = setup()
    const session = await transport.attach({ port: 9222 })

    // Fixture reports checked: false → checking requires a click…
    await session.setChecked('#agree', true)
    expect(inputEvents().length).toBeGreaterThan(0)

    // …while unchecking an already-unchecked box must NOT click (a click would toggle wrong).
    const fresh = setup()
    const freshSession = await fresh.transport.attach({ port: 9222 })
    await freshSession.setChecked('#agree', false)
    expect(fresh.inputEvents()).toEqual([])
  })

  it('sets file inputs through DOM.setFileInputFiles by nodeId', async () => {
    const { transport, server } = setup()
    server.respond('DOM.getDocument', () => ({ root: { nodeId: 1 } }))
    server.respond('DOM.querySelector', () => ({ nodeId: 42 }))
    const session = await transport.attach({ port: 9222 })

    await session.setInputFiles('#file', ['/abs/a.txt'])

    const setFiles = server.sentTo('page/T1', 'DOM.setFileInputFiles')
    expect(setFiles[0]?.params).toEqual({ files: ['/abs/a.txt'], nodeId: 42 })
  })

  it('maps a zero nodeId from DOM.querySelector to SELECTOR_NO_MATCH', async () => {
    const { transport, server } = setup()
    server.respond('DOM.getDocument', () => ({ root: { nodeId: 1 } }))
    server.respond('DOM.querySelector', () => ({ nodeId: 0 }))
    const session = await transport.attach({ port: 9222 })

    await expect(session.setInputFiles('#gone', ['/abs/a.txt'])).rejects.toMatchObject({
      code: 'SELECTOR_NO_MATCH',
    })
  })
})
