/**
 * Unit tests for the closed-shadow-root opt-in hooks: the
 * `__stagewright_closedShadowRoots` registration array (the timing-independent
 * opt-in apps populate at attachShadow time) merged with the original
 * `__stagewright_inspectShadow` callback. Roots from both sources are walked,
 * deduplicated, validated, and skipped once their host is detached.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { walkAccessibilityTree } from '../src/snapshot/index.js'

type ShadowWindow = Window & {
  __stagewright_closedShadowRoots?: unknown[]
  __stagewright_inspectShadow?: () => unknown[]
}

function domWithClosedShadow(html: string) {
  const dom = new JSDOM(`<!doctype html><body>${html}<div id="host"></div></body>`)
  const host = dom.window.document.getElementById('host') as HTMLElement
  const root = host.attachShadow({ mode: 'closed' })
  const button = dom.window.document.createElement('button')
  button.textContent = 'Inside closed shadow'
  root.append(button)
  return { dom, host, root, window: dom.window as unknown as ShadowWindow }
}

describe('closed shadow root registration array', () => {
  it('walks roots pushed onto __stagewright_closedShadowRoots and marks them shadow_closed', () => {
    const { dom, root, window } = domWithClosedShadow('<button>Light</button>')
    window.__stagewright_closedShadowRoots = [root]

    const snapshot = walkAccessibilityTree(dom.window.document)
    const hidden = snapshot.entries.find((e) => e.name === 'Inside closed shadow')
    expect(hidden).toBeDefined()
    expect(hidden?.state.shadow_closed).toBe(true)
  })

  it('merges and deduplicates the registration array with the inspect callback', () => {
    const { dom, root, window } = domWithClosedShadow('<button>Light</button>')
    window.__stagewright_closedShadowRoots = [root]
    window.__stagewright_inspectShadow = () => [root]

    const snapshot = walkAccessibilityTree(dom.window.document)
    const hidden = snapshot.entries.filter((e) => e.name === 'Inside closed shadow')
    expect(hidden).toHaveLength(1)
  })

  it('ignores junk values in the registration array without breaking the walk', () => {
    const { dom, root, window } = domWithClosedShadow('<button>Light</button>')
    window.__stagewright_closedShadowRoots = [null, 42, {}, dom.window.document.body, root]

    const snapshot = walkAccessibilityTree(dom.window.document)
    expect(snapshot.entries.some((e) => e.name === 'Inside closed shadow')).toBe(true)
    expect(snapshot.entries.some((e) => e.name === 'Light')).toBe(true)
  })

  it('skips a registered root whose host has left the document', () => {
    const { dom, host, root, window } = domWithClosedShadow('<button>Light</button>')
    window.__stagewright_closedShadowRoots = [root]
    host.remove()

    const snapshot = walkAccessibilityTree(dom.window.document)
    expect(snapshot.entries.some((e) => e.name === 'Inside closed shadow')).toBe(false)
  })

  it('walks fine when neither hook is present', () => {
    const dom = new JSDOM('<!doctype html><body><button>Solo</button></body>')
    const snapshot = walkAccessibilityTree(dom.window.document)
    expect(snapshot.entries.some((e) => e.name === 'Solo')).toBe(true)
  })
})
