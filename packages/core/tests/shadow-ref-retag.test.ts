import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

import { walkAccessibilityTree } from '../src/snapshot/index.js'
import { buildRetagBody } from '../src/tools/snapshot/inject.js'
import { reconcileWalkedSnapshot } from '../src/tools/snapshot/refs.js'

describe('shadow DOM ref reconciliation', () => {
  it.each(['open', 'closed-registration', 'closed-hook', 'nested'] as const)(
    'keeps %s DOM tags aligned with reconciled snapshot refs',
    (mode) => {
      const dom = new JSDOM('<main><div id="host"></div></main>')
      const document = dom.window.document
      const host = document.querySelector('#host')
      if (host === null) throw new Error('Missing host fixture')
      let root = host.attachShadow({ mode: mode.startsWith('closed') ? 'closed' : 'open' })
      if (mode === 'nested') {
        root.innerHTML = '<div id="nested"></div>'
        const nested = root.querySelector('#nested')
        if (nested === null) throw new Error('Missing nested fixture')
        root = nested.attachShadow({ mode: 'open' })
      }
      const exposed = dom.window as unknown as {
        __stagewright_closedShadowRoots?: ShadowRoot[]
        __stagewright_inspectShadow?: () => ShadowRoot[]
      }
      if (mode === 'closed-registration') exposed.__stagewright_closedShadowRoots = [root, root]
      if (mode === 'closed-hook') exposed.__stagewright_inspectShadow = () => [root]

      root.innerHTML = '<button>Save</button><button>Delete</button>'
      const prev = walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })
      const inserted = document.createElement('button')
      inserted.textContent = 'New'
      const main = document.querySelector('main')
      if (main === null) throw new Error('Missing main fixture')
      main.prepend(inserted)
      const walked = walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })
      const { snapshot, retags } = reconcileWalkedSnapshot(prev, walked)
      const retag = new Function('document', 'arg', buildRetagBody())
      retag(document, retags)
      for (const button of root.querySelectorAll('button')) {
        const entry = snapshot.entries.find((value) => value.name === button.textContent)
        expect(button.getAttribute('data-sw-ref')).toBe(String(entry?.ref))
      }
      dom.window.close()
    },
  )
  it('does not retag stale refs in a root moved beyond the walker depth limit', () => {
    const dom = new JSDOM('<main><button id="save">Save</button><div id="host"></div></main>')
    try {
      const document = dom.window.document
      const top = document.querySelector('#host')
      const save = document.querySelector('#save')
      const main = document.querySelector('main')
      if (top === null || save === null || main === null) throw new Error('Missing fixture')
      let host = top
      let root: ShadowRoot | undefined
      for (let depth = 1; depth <= 10; depth++) {
        root = host.attachShadow({ mode: 'open' })
        if (depth < 10) {
          host = document.createElement('div')
          root.append(host)
        }
      }
      if (root === undefined) throw new Error('Missing shadow fixture')
      const deep = document.createElement('button')
      deep.textContent = 'Deep'
      root.append(deep)
      const prev = walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })
      expect(deep.getAttribute('data-sw-ref')).toBe('2')
      const wrapper = document.createElement('div')
      top.before(wrapper)
      wrapper.attachShadow({ mode: 'open' }).append(top)
      const fresh = document.createElement('button')
      fresh.textContent = 'New'
      main.prepend(fresh)
      const walked = walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })
      expect(walked.entries.some((entry) => entry.name === 'Deep')).toBe(false)
      const { snapshot, retags } = reconcileWalkedSnapshot(prev, walked)
      new Function('document', 'arg', buildRetagBody())(document, retags)
      expect(save.getAttribute('data-sw-ref')).toBe(
        String(snapshot.entries.find((entry) => entry.name === 'Save')?.ref),
      )
      // The walker does not visit/clear this excluded root. Retagging must not consume its old tag.
      expect(deep.getAttribute('data-sw-ref')).toBe('2')
    } finally {
      dom.window.close()
    }
  })
  it('restarts the depth budget at each explicitly exposed closed root', () => {
    const dom = new JSDOM('<main><button>First</button><div id="host"></div></main>')
    try {
      const document = dom.window.document
      const main = document.querySelector('main')
      let host = document.querySelector('#host')
      if (host === null || main === null) throw new Error('Missing fixture')
      for (let depth = 1; depth <= 11; depth++) {
        const root = host.attachShadow({ mode: 'open' })
        host = document.createElement('div')
        root.append(host)
      }
      const closed = host.attachShadow({ mode: 'closed' })
      host = document.createElement('div')
      closed.append(host)
      let nested: ShadowRoot = closed
      for (let depth = 1; depth <= 10; depth++) {
        nested = host.attachShadow({ mode: 'open' })
        if (depth < 10) {
          host = document.createElement('div')
          nested.append(host)
        }
      }
      const save = document.createElement('button')
      save.textContent = 'Save'
      nested.append(save)
      const exposed = dom.window as unknown as { __stagewright_closedShadowRoots: ShadowRoot[] }
      exposed.__stagewright_closedShadowRoots = [closed]
      const prev = walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })
      expect(prev.entries.some((entry) => entry.name === 'Save')).toBe(true)
      const fresh = document.createElement('button')
      fresh.textContent = 'New'
      main.prepend(fresh)
      const walked = walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })
      const { snapshot, retags } = reconcileWalkedSnapshot(prev, walked)
      new Function('document', 'arg', buildRetagBody())(document, retags)
      expect(save.getAttribute('data-sw-ref')).toBe(
        String(snapshot.entries.find((entry) => entry.name === 'Save')?.ref),
      )
    } finally {
      dom.window.close()
    }
  })

  it('ignores malformed exposed roots rejected by the walker', () => {
    const dom = new JSDOM('<button data-sw-ref="2">Save</button>')
    try {
      const document = dom.window.document
      const scan = vi.fn(() => {
        throw new Error('Malformed root must not be visited')
      })
      const exposed = dom.window as unknown as { __stagewright_closedShadowRoots: unknown[] }
      exposed.__stagewright_closedShadowRoots = [
        null,
        { ownerDocument: document, host: { isConnected: true }, querySelectorAll: scan },
      ]
      new Function('document', 'arg', buildRetagBody())(document, [{ from: 2, to: 1 }])
      expect(scan).not.toHaveBeenCalled()
      expect(document.querySelector('button')?.getAttribute('data-sw-ref')).toBe('1')
    } finally {
      dom.window.close()
    }
  })
})
