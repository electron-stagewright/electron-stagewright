/**
 * Tests for the walker's `refAttribute` option — the `data-sw-ref` tagging that
 * makes a snapshot `ref` resolvable to a `[data-sw-ref="N"]` selector for later
 * interaction. The renderer-injected entry point delegates to this option.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { walkAccessibilityTree } from '../src/snapshot/index.js'

describe('walker refAttribute tagging', () => {
  it('tags each interactive element with its ref number', () => {
    const dom = new JSDOM('<button>One</button><a href="#">Two</a>')
    const document = dom.window.document
    const snapshot = walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })

    for (const entry of snapshot.entries) {
      if (entry.ref === null) continue
      const tagged = document.querySelector(`[data-sw-ref="${entry.ref}"]`)
      expect(tagged).not.toBeNull()
    }
    // At least the button + link were tagged.
    expect(document.querySelectorAll('[data-sw-ref]').length).toBeGreaterThanOrEqual(2)
  })

  it('does not tag the DOM when refAttribute is omitted (pure walk)', () => {
    const dom = new JSDOM('<button>One</button>')
    walkAccessibilityTree(dom.window.document, {})
    expect(dom.window.document.querySelectorAll('[data-sw-ref]').length).toBe(0)
  })

  it('removes stale tags before applying the current walk tags', () => {
    const dom = new JSDOM('<button>One</button><div data-sw-ref="99">stale</div>')
    const document = dom.window.document
    walkAccessibilityTree(document, { refAttribute: 'data-sw-ref' })

    expect(document.querySelector('div')?.hasAttribute('data-sw-ref')).toBe(false)
    expect(document.querySelector('button')?.getAttribute('data-sw-ref')).toBe('1')
  })
})
