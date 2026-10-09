import { fileURLToPath } from 'node:url'

import { buildSync } from 'esbuild'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

import { Dispatcher } from '../src/server/dispatcher.js'
import { SessionManager } from '../src/server/session-manager.js'
import { SnapshotStore } from '../src/server/snapshot-store.js'
import { queryTarget, TARGET_RESOLVER_FN } from '../src/snapshot/resolve-target.js'
import { MAX_SHADOW_DEPTH, walkAccessibilityTree } from '../src/snapshot/walker.js'
import { EXPECT_TOOLS, makeExpectStateTool } from '../src/tools/expect/index.js'
import { READ_TOOLS } from '../src/tools/read/index.js'
import { makeGetStateTool } from '../src/tools/read/state.js'
import { buildRetagBody } from '../src/tools/snapshot/inject.js'
import { reconcileWalkedSnapshot } from '../src/tools/snapshot/refs.js'
import { WAIT_TOOLS, makeWaitForStateTool } from '../src/tools/wait/index.js'
import {
  CHECKED_STATE_BODY,
  FILL_BODY,
  FOCUS_BODY,
  RESOLVE_POINT_BODY,
  SELECT_OPTION_BODY,
} from '../src/transports/cdp-interaction.js'
import {
  buildScrollIntoViewBody,
  EDITABLE_SIGNATURE_BODY,
} from '../src/transports/playwright-electron-bodies.js'
import { FakeSession, FakeTransport } from './helpers/fake-transport.js'

// Exercise the production bundle and inline bodies, not canned renderer replies.
const bundle = buildSync({
  entryPoints: [fileURLToPath(new URL('../src/snapshot/renderer-entry.ts', import.meta.url))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
}).outputFiles[0]?.text
if (bundle === undefined) throw new Error('Missing renderer bundle')
const loadBundle = (): string => bundle

type ExposedWindow = Window & {
  __stagewright_closedShadowRoots?: unknown[]
  __stagewright_inspectShadow?: () => unknown[]
}
type Mode = 'open' | 'nested' | 'closed-registration' | 'closed-hook'

function fixture(mode: Mode = 'open') {
  const dom = new JSDOM('<main><div id="host"></div></main>', { runScripts: 'outside-only' })
  const document = dom.window.document
  const host = document.querySelector('#host')
  if (host === null) throw new Error('Missing host fixture')
  let root = host.attachShadow({ mode: mode.startsWith('closed') ? 'closed' : 'open' })
  const view = dom.window as unknown as ExposedWindow
  if (mode === 'closed-registration') view.__stagewright_closedShadowRoots = [root, root]
  if (mode === 'closed-hook') view.__stagewright_inspectShadow = () => [root]
  if (mode === 'nested') {
    root.innerHTML = '<div></div>'
    const nested = root.firstElementChild
    if (nested === null) throw new Error('Missing nested fixture')
    root = nested.attachShadow({ mode: 'open' })
  }
  root.innerHTML = '<input aria-label="Name" value="Ada" title="Person">'
  const input = root.querySelector('input')
  if (input === null) throw new Error('Missing input fixture')
  const run = (body: string, arg: unknown): Promise<unknown> => {
    const execute = dom.window.eval(`(async (arg) => { ${body} })`) as (
      arg: unknown,
    ) => Promise<unknown>
    return execute(arg)
  }
  const sessions = new SessionManager()
  const snapshots = new SnapshotStore()
  const session = new FakeSession({
    id: 'shadow',
    evaluate: (_target, body, arg) => run(body, arg),
  })
  sessions.register(new FakeTransport(), session)
  const dispatcher = new Dispatcher({ sessions, snapshots })
  dispatcher.registerAll([
    ...READ_TOOLS.filter((tool) => tool.name !== 'electron_get_state'),
    makeGetStateTool({ loadBundle }),
    ...WAIT_TOOLS.filter((tool) => tool.name !== 'electron_wait_for_state'),
    makeWaitForStateTool({ loadBundle }),
    ...EXPECT_TOOLS.filter((tool) => tool.name !== 'electron_expect_state'),
    makeExpectStateTool({ loadBundle }),
  ])
  const snapshot = walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })
  snapshots.set('shadow', snapshot)
  return { dom, document, host, root, input, view, run, dispatcher, snapshots, snapshot }
}

describe.each<Mode>(['open', 'nested', 'closed-registration', 'closed-hook'])(
  '%s shadow refs',
  (mode) => {
    it('supports all inline reads and the bundled state probe after reconciliation', async () => {
      const f = fixture(mode)
      try {
        const extra = f.document.createElement('button')
        extra.textContent = 'New'
        f.document.querySelector('main')?.prepend(extra)
        const walked = walkAccessibilityTree(f.document, { refAttribute: 'data-sw-ref' })
        const { snapshot, retags } = reconcileWalkedSnapshot(f.snapshot, walked)
        await f.run(buildRetagBody(), retags)
        f.snapshots.set('shadow', snapshot)
        const ref = f.snapshot.entries.find((entry) => entry.name === 'Name')?.ref
        if (ref == null) throw new Error('Missing snapshot ref')
        const checks: [string, Record<string, unknown>, Record<string, unknown>][] = [
          ['electron_get_text', {}, { text: 'Name' }],
          ['electron_get_value', {}, { value: 'Ada' }],
          ['electron_get_attribute', { name: 'title' }, { value: 'Person' }],
          ['electron_get_bbox', {}, { bbox: { x: 0, y: 0, w: 0, h: 0 } }],
          [
            'electron_get_computed_style',
            { properties: ['display'] },
            { style: { display: 'inline-block' } },
          ],
          ['electron_exists', {}, { exists: true }],
          ['electron_get_state', {}, { ref, name: 'Name', state: { disabled: false } }],
        ]
        for (const [name, args, result] of checks) {
          expect(await f.dispatcher.dispatch(name, { ref, ...args })).toMatchObject({
            ok: true,
            ...result,
          })
        }
      } finally {
        f.dom.window.close()
      }
    })

    it('supports bounded waits, assertions and target-specific events', async () => {
      const f = fixture(mode)
      try {
        const checks: [string, Record<string, unknown>][] = [
          ['electron_wait_for_selector', { state: 'attached' }],
          ['electron_wait_for_state', { state: { disabled: false } }],
          ['electron_expect_state', { state: { disabled: false } }],
          ['electron_expect_text', { equals: 'Name' }],
          ['electron_expect_value', { equals: 'Ada' }],
          ['electron_assert_pattern', { equals: 'Name' }],
        ]
        for (const [name, args] of checks) {
          expect(
            await f.dispatcher.dispatch(name, { ref: 1, timeoutMs: 0, ...args }),
          ).toMatchObject({ ok: true })
        }
        const waiting = f.dispatcher.dispatch('electron_wait_for_event', {
          ref: 1,
          eventName: 'change',
          timeoutMs: 100,
        })
        setTimeout(() => f.input.dispatchEvent(new f.dom.window.Event('change')), 10)
        expect(await waiting).toMatchObject({ ok: true, fired: true })
      } finally {
        f.dom.window.close()
      }
    })

    it('resolves transport helper bodies without altering their mutation semantics', async () => {
      const f = fixture(mode)
      try {
        const arg = { selector: '[data-sw-ref="1"]' }
        await expect(f.run(FOCUS_BODY, arg)).resolves.toEqual({ status: 'ok' })
        expect(f.root.activeElement).toBe(f.input)
        const onInput = vi.fn()
        f.input.addEventListener('input', onInput)
        await expect(f.run(FILL_BODY, { ...arg, value: 'Grace' })).resolves.toEqual({
          status: 'ok',
        })
        expect(f.input.value).toBe('Grace')
        expect(onInput).toHaveBeenCalledOnce()
        await expect(f.run(EDITABLE_SIGNATURE_BODY, arg)).resolves.toBe('Grace')
        await expect(f.run(CHECKED_STATE_BODY, arg)).resolves.toEqual({
          status: 'ok',
          checked: false,
          disabled: false,
        })
        await expect(f.run(RESOLVE_POINT_BODY, arg)).resolves.toMatchObject({
          status: 'ok',
          visible: false,
          disabled: false,
        })
        const scroll = vi.fn()
        f.input.scrollIntoView = scroll
        await expect(f.run(buildScrollIntoViewBody(), arg)).resolves.toBe(true)
        expect(scroll).toHaveBeenCalledOnce()
        f.root.innerHTML =
          '<select data-sw-ref="1"><option value="a">A</option><option value="b">B</option></select>'
        await expect(f.run(SELECT_OPTION_BODY, { ...arg, values: ['b'] })).resolves.toEqual({
          status: 'ok',
          selected: ['b'],
        })
      } finally {
        f.dom.window.close()
      }
    })
  },
)

describe('shadow resolver boundaries', () => {
  it('retains CSS errors, document-only CSS matching and first-match semantics', async () => {
    const f = fixture()
    try {
      expect(queryTarget(f.document, 'input', MAX_SHADOW_DEPTH)).toBeNull()
      const first = f.document.createElement('input')
      f.document.body.append(first, f.document.createElement('input'))
      expect(queryTarget(f.document, 'input', MAX_SHADOW_DEPTH)).toBe(first)
      expect(() => queryTarget(f.document, ':::', MAX_SHADOW_DEPTH)).toThrow()
      for (const name of [
        'electron_get_text',
        'electron_exists',
        'electron_wait_for_selector',
        'electron_expect_text',
      ]) {
        expect(
          await f.dispatcher.dispatch(name, { selector: ':::', equals: 'x', timeoutMs: 0 }),
        ).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' })
      }
    } finally {
      f.dom.window.close()
    }
  })

  it('preserves invalid/stale ref errors and absent-ref existence results', async () => {
    const f = fixture()
    try {
      expect(await f.dispatcher.dispatch('electron_get_text', { ref: 0 })).toMatchObject({
        ok: false,
        code: 'BAD_ARGUMENT',
      })
      expect(await f.dispatcher.dispatch('electron_get_text', { ref: 999 })).toMatchObject({
        ok: false,
        code: 'REF_NOT_FOUND',
      })
      f.input.remove()
      expect(await f.dispatcher.dispatch('electron_exists', { ref: 1 })).toMatchObject({
        ok: true,
        exists: false,
      })
      expect(await f.run(FOCUS_BODY, { selector: '[data-sw-ref="1"]' })).toEqual({
        status: 'no-match',
      })
    } finally {
      f.dom.window.close()
    }
  })

  it('re-resolves a ref during polling when a shadow element is replaced', async () => {
    const f = fixture()
    try {
      const pending = f.dispatcher.dispatch('electron_expect_value', {
        ref: 1,
        equals: 'Grace',
        timeoutMs: 500,
      })
      setTimeout(() => {
        f.root.innerHTML = '<input data-sw-ref="1" value="Grace">'
      }, 10)
      expect(await pending).toMatchObject({ ok: true, actual: 'Grace' })
    } finally {
      f.dom.window.close()
    }
  })

  it('ignores unexposed closed, detached, foreign and malformed roots, and throwing hooks', () => {
    const f = fixture('closed-registration')
    const foreign = fixture()
    try {
      delete f.view.__stagewright_closedShadowRoots
      expect(queryTarget(f.document, '[data-sw-ref="1"]', MAX_SHADOW_DEPTH)).toBeNull()
      const scan = vi.fn()
      f.view.__stagewright_closedShadowRoots = [
        null,
        foreign.root,
        { ownerDocument: f.document, host: {}, querySelectorAll: scan },
      ]
      f.view.__stagewright_inspectShadow = () => {
        throw new Error('broken hook')
      }
      expect(queryTarget(f.document, '[data-sw-ref="1"]', MAX_SHADOW_DEPTH)).toBeNull()
      expect(scan).not.toHaveBeenCalled()
      f.view.__stagewright_closedShadowRoots = [f.root]
      expect(queryTarget(f.document, '[data-sw-ref="1"]', MAX_SHADOW_DEPTH)).toBe(f.input)
      f.host.remove()
      expect(queryTarget(f.document, '[data-sw-ref="1"]', MAX_SHADOW_DEPTH)).toBeNull()
    } finally {
      f.dom.window.close()
      foreign.dom.window.close()
    }
  })

  it('excludes stale tags past the depth limit and restarts the budget for exposed roots', async () => {
    const f = fixture()
    try {
      let host: Element = f.host
      let root = f.root
      for (let depth = 1; depth <= MAX_SHADOW_DEPTH; depth++) {
        host = f.document.createElement('div')
        root.append(host)
        root = host.attachShadow({ mode: 'open' })
      }
      root.append(f.input)
      expect(queryTarget(f.document, '[data-sw-ref="1"]', MAX_SHADOW_DEPTH)).toBeNull()
      const body = `${TARGET_RESOLVER_FN} return __swQueryTarget(arg.selector) !== null;`
      expect(await f.run(body, { selector: '[data-sw-ref="1"]' })).toBe(false)
      f.view.__stagewright_closedShadowRoots = [f.root]
      expect(queryTarget(f.document, '[data-sw-ref="1"]', MAX_SHADOW_DEPTH)).toBe(f.input)
      expect(await f.run(body, { selector: '[data-sw-ref="1"]' })).toBe(true)
    } finally {
      f.dom.window.close()
    }
  })
})
