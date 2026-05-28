/**
 * Tests for snapshot diffing, ref reconciliation, semantic find, hot-reload
 * detection, and open/closed shadow-root traversal.
 *
 * The diff / reconcile / find functions are pure over `Snapshot` objects. Most
 * tests build snapshots by walking jsdom DOMs so the inputs are realistic
 * rather than hand-rolled.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import {
  detectRendererReload,
  diffSnapshots,
  findEntries,
  markRecentlyChanged,
  reconcileRefs,
  walkAccessibilityTree,
  withReloadFlag,
  type Snapshot,
  type SnapshotEntry,
} from '../src/snapshot/index.js'

function snapshotOf(html: string, url = 'http://localhost/test'): Snapshot {
  const dom = new JSDOM(html, { url })
  return walkAccessibilityTree(dom.window.document)
}

function byName(name: string) {
  return (e: SnapshotEntry) => e.name === name
}

// ---------------------------------------------------------------------------
// diffSnapshots
// ---------------------------------------------------------------------------

describe('diffSnapshots', () => {
  it('identical snapshots produce empty added/removed/changed', () => {
    const html = '<main><button>Save</button><button>Cancel</button></main>'
    const a = snapshotOf(html)
    const b = snapshotOf(html)
    const diff = diffSnapshots(a, b)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.changed).toEqual([])
    expect(diff._meta.entries_added).toBe(0)
    expect(diff._meta.entries_removed).toBe(0)
    expect(diff._meta.entries_changed).toBe(0)
  })

  it('detects an added element', () => {
    const prev = snapshotOf('<main><button>Save</button></main>')
    const curr = snapshotOf('<main><button>Save</button><button>Delete</button></main>')
    const diff = diffSnapshots(prev, curr)
    expect(diff.added.map((e) => e.name)).toContain('Delete')
    expect(diff.removed).toEqual([])
    expect(diff._meta.entries_added).toBe(1)
  })

  it('detects a removed element', () => {
    const prev = snapshotOf('<main><button>Save</button><button>Delete</button></main>')
    const curr = snapshotOf('<main><button>Save</button></main>')
    const diff = diffSnapshots(prev, curr)
    expect(diff.removed.map((e) => e.name)).toContain('Delete')
    expect(diff.added).toEqual([])
    expect(diff._meta.entries_removed).toBe(1)
  })

  it('detects a state change (button became disabled)', () => {
    const prev = snapshotOf('<main><button>Save</button></main>')
    const curr = snapshotOf('<main><button disabled>Save</button></main>')
    const diff = diffSnapshots(prev, curr)
    expect(diff.changed.length).toBe(1)
    expect(diff.changed[0]?.changed_fields).toContain('state')
    expect(diff.changed[0]?.curr.state.disabled).toBe(true)
  })

  it('detects a value change (input text edited)', () => {
    const prevDom = new JSDOM(
      '<label for="x">Name</label><input id="x" type="text" value="alice" />',
    )
    const currDom = new JSDOM('<label for="x">Name</label><input id="x" type="text" value="bob" />')
    const diff = diffSnapshots(
      walkAccessibilityTree(prevDom.window.document),
      walkAccessibilityTree(currDom.window.document),
    )
    expect(diff.changed.length).toBe(1)
    expect(diff.changed[0]?.changed_fields).toContain('value')
  })

  it('an unchanged element is not in the changed list', () => {
    const html = '<main><button>Save</button></main>'
    const diff = diffSnapshots(snapshotOf(html), snapshotOf(html))
    expect(diff.changed).toEqual([])
  })

  it('ref_map maps fingerprint to previous ref for reuse', () => {
    const prev = snapshotOf('<main><button>Save</button></main>')
    const curr = snapshotOf('<main><button>Save</button></main>')
    const saveEntry = curr.entries.find(byName('Save'))
    expect(saveEntry).toBeDefined()
    if (saveEntry !== undefined) {
      const diff = diffSnapshots(prev, curr)
      expect(diff.ref_map[saveEntry.fingerprint]).toBe(1)
      const serialized = JSON.parse(JSON.stringify(diff)) as {
        ref_map: Record<string, number>
      }
      expect(serialized.ref_map[saveEntry.fingerprint]).toBe(1)
    }
  })

  it('_meta.estimated_tokens is a positive number for a non-empty diff', () => {
    const prev = snapshotOf('<main><button>Save</button></main>')
    const curr = snapshotOf('<main><button>Save</button><button>New</button></main>')
    const diff = diffSnapshots(prev, curr)
    expect(diff._meta.estimated_tokens).toBeGreaterThan(0)
  })

  it('returns added entries in document order, not fingerprint-group order', () => {
    const prev = snapshotOf('<main><button>Keep</button></main>')
    // Two new buttons; "Alpha" appears before "Keep", "Zeta" after.
    const curr = snapshotOf(
      '<main><button>Alpha</button><button>Keep</button><button>Zeta</button></main>',
    )
    const diff = diffSnapshots(prev, curr)
    const addedNames = diff.added.map((e) => e.name)
    expect(addedNames).toEqual(['Alpha', 'Zeta'])
  })

  it('handles two entries sharing a fingerprint by position', () => {
    // Two "Save" buttons under the same ancestor chain share a fingerprint.
    const prev = snapshotOf('<form><button>Save</button><button>Save</button></form>')
    const curr = snapshotOf('<form><button>Save</button></form>')
    const diff = diffSnapshots(prev, curr)
    // One of the two duplicates was removed.
    expect(diff.removed.length).toBe(1)
    expect(diff.removed[0]?.name).toBe('Save')
  })
})

// ---------------------------------------------------------------------------
// markRecentlyChanged
// ---------------------------------------------------------------------------

describe('markRecentlyChanged', () => {
  it('sets recently_changed on entries the diff flagged as changed', () => {
    const prev = snapshotOf('<main><button>Save</button></main>')
    const curr = snapshotOf('<main><button disabled>Save</button></main>')
    const diff = diffSnapshots(prev, curr)
    const annotated = markRecentlyChanged(curr, diff)
    const save = annotated.entries.find(byName('Save'))
    expect(save?.recently_changed).toBe(true)
  })

  it('leaves unchanged entries with recently_changed false', () => {
    const prev = snapshotOf('<main><button>Save</button><button>Cancel</button></main>')
    const curr = snapshotOf('<main><button disabled>Save</button><button>Cancel</button></main>')
    const diff = diffSnapshots(prev, curr)
    const annotated = markRecentlyChanged(curr, diff)
    expect(annotated.entries.find(byName('Cancel'))?.recently_changed).toBe(false)
    expect(annotated.entries.find(byName('Save'))?.recently_changed).toBe(true)
  })

  it('returns the same snapshot object when nothing changed', () => {
    const html = '<main><button>Save</button></main>'
    const curr = snapshotOf(html)
    const diff = diffSnapshots(snapshotOf(html), curr)
    expect(markRecentlyChanged(curr, diff)).toBe(curr)
  })
})

// ---------------------------------------------------------------------------
// detectRendererReload / withReloadFlag
// ---------------------------------------------------------------------------

describe('detectRendererReload', () => {
  it('same url → not a reload', () => {
    const a = snapshotOf('<main></main>', 'http://localhost/app')
    const rawB = snapshotOf('<main></main>', 'http://localhost/app')
    const b: Snapshot = {
      ...rawB,
      meta: { ...rawB.meta, navigation_started_at_ms: a.meta.navigation_started_at_ms },
    }
    expect(detectRendererReload(a, b)).toBe(false)
  })

  it('different url → reload', () => {
    const a = snapshotOf('<main></main>', 'http://localhost/app')
    const b = snapshotOf('<main></main>', 'http://localhost/app2')
    expect(detectRendererReload(a, b)).toBe(true)
  })

  it('same url but different navigation start → reload', () => {
    const a = snapshotOf('<main></main>', 'http://localhost/app')
    const rawB = snapshotOf('<main></main>', 'http://localhost/app')
    const b: Snapshot = {
      ...rawB,
      meta: {
        ...rawB.meta,
        navigation_started_at_ms: a.meta.navigation_started_at_ms + 1,
      },
    }
    expect(detectRendererReload(a, b)).toBe(true)
  })

  it('empty url on one side → cannot conclude reload', () => {
    const a = snapshotOf('<main></main>', 'http://localhost/app')
    const b: Snapshot = {
      ...a,
      meta: {
        ...a.meta,
        url: '',
        navigation_started_at_ms: a.meta.navigation_started_at_ms,
      },
    }
    expect(detectRendererReload(a, b)).toBe(false)
  })
})

describe('withReloadFlag', () => {
  it('stamps the meta flag without mutating the input', () => {
    const snap = snapshotOf('<main></main>')
    const flagged = withReloadFlag(snap, true)
    expect(flagged.meta.renderer_reloaded_since_last_snapshot).toBe(true)
    expect(snap.meta.renderer_reloaded_since_last_snapshot).toBe(false)
  })

  it('returns the same object when the flag already matches', () => {
    const snap = snapshotOf('<main></main>')
    expect(withReloadFlag(snap, false)).toBe(snap)
  })
})

// ---------------------------------------------------------------------------
// reconcileRefs
// ---------------------------------------------------------------------------

describe('reconcileRefs', () => {
  it('reuses the previous ref for an element with a stable fingerprint', () => {
    const prev = snapshotOf('<main><button>Save</button><button>Cancel</button></main>')
    // Insert a new button BEFORE Save so document order shifts.
    const curr = snapshotOf(
      '<main><button>New</button><button>Save</button><button>Cancel</button></main>',
    )
    const { snapshot, reused, fresh } = reconcileRefs(prev, curr)
    const save = snapshot.entries.find(byName('Save'))
    const cancel = snapshot.entries.find(byName('Cancel'))
    const prevSave = prev.entries.find(byName('Save'))
    const prevCancel = prev.entries.find(byName('Cancel'))
    // Save and Cancel keep their previous refs despite the document-order shift.
    expect(save?.ref).toBe(prevSave?.ref)
    expect(cancel?.ref).toBe(prevCancel?.ref)
    expect(reused).toBe(2)
    expect(fresh).toBe(1) // the New button
  })

  it('assigns fresh refs above the max reused ref (no collision)', () => {
    const prev = snapshotOf('<main><button>Save</button><button>Cancel</button></main>')
    const curr = snapshotOf(
      '<main><button>Save</button><button>Cancel</button><button>New</button></main>',
    )
    const { snapshot } = reconcileRefs(prev, curr)
    const refs = snapshot.entries.filter((e) => e.ref !== null).map((e) => e.ref as number)
    // No duplicate refs.
    expect(new Set(refs).size).toBe(refs.length)
    const newButton = snapshot.entries.find(byName('New'))
    expect(newButton?.ref).toBeGreaterThan(2)
  })

  it('counts dropped refs for removed elements', () => {
    const prev = snapshotOf('<main><button>Save</button><button>Cancel</button></main>')
    const curr = snapshotOf('<main><button>Save</button></main>')
    const { dropped } = reconcileRefs(prev, curr)
    expect(dropped).toBe(1) // Cancel dropped
  })

  it('handles heavy churn without ref collision', () => {
    const prev = snapshotOf('<main><button>A</button><button>B</button><button>C</button></main>')
    const curr = snapshotOf(
      '<main><button>B</button><button>D</button><button>E</button><button>F</button></main>',
    )
    const { snapshot, reused, fresh, dropped } = reconcileRefs(prev, curr)
    const refs = snapshot.entries.filter((e) => e.ref !== null).map((e) => e.ref as number)
    expect(new Set(refs).size).toBe(refs.length)
    expect(reused).toBe(1) // B
    expect(fresh).toBe(3) // D, E, F
    expect(dropped).toBe(2) // A, C
  })
})

// ---------------------------------------------------------------------------
// findEntries
// ---------------------------------------------------------------------------

describe('findEntries', () => {
  const snap = snapshotOf(
    '<main><button>Save changes</button><button>Save</button><a href="#">Save link</a><button disabled style="display:none">Hidden Save</button></main>',
  )

  it('filters by role', () => {
    const buttons = findEntries(snap, { role: 'button' })
    expect(buttons.every((e) => e.role === 'button')).toBe(true)
    expect(buttons.find((e) => e.role === 'link')).toBeUndefined()
  })

  it('filters by name_contains (case-insensitive substring)', () => {
    const matches = findEntries(snap, { name_contains: 'save' })
    // All four entries contain "save" case-insensitively.
    expect(matches.length).toBe(4)
  })

  it('filters by name_exact (case-insensitive equality)', () => {
    const matches = findEntries(snap, { name_exact: 'save' })
    // Only the exact "Save" button (case-insensitive) matches, not "Save changes".
    expect(matches.length).toBe(1)
    expect(matches[0]?.name).toBe('Save')
  })

  it('filters by visible', () => {
    const visible = findEntries(snap, { role: 'button', visible: true })
    expect(visible.find((e) => e.name === 'Hidden Save')).toBeUndefined()
  })

  it('filters by interactive', () => {
    const interactive = findEntries(snap, { interactive: true })
    expect(interactive.every((e) => e.interactive)).toBe(true)
  })

  it('combines filters with logical AND', () => {
    const matches = findEntries(snap, { role: 'button', name_contains: 'changes' })
    expect(matches.length).toBe(1)
    expect(matches[0]?.name).toBe('Save changes')
  })

  it('returns empty array for no matches', () => {
    expect(findEntries(snap, { name_exact: 'nonexistent' })).toEqual([])
  })

  it('empty query returns all entries', () => {
    expect(findEntries(snap, {}).length).toBe(snap.entries.length)
  })
})

// ---------------------------------------------------------------------------
// Shadow-root traversal
// ---------------------------------------------------------------------------

describe('shadow-root traversal', () => {
  it('walks open shadow root contents', () => {
    const dom = new JSDOM('<main><my-widget id="w"></my-widget></main>', {
      url: 'http://localhost/test',
    })
    const host = dom.window.document.getElementById('w')
    expect(host).not.toBeNull()
    if (host !== null) {
      const root = host.attachShadow({ mode: 'open' })
      const button = dom.window.document.createElement('button')
      button.textContent = 'Inside Shadow'
      root.appendChild(button)
      const snap = walkAccessibilityTree(dom.window.document)
      const entry = snap.entries.find(byName('Inside Shadow'))
      expect(entry).toBeDefined()
      expect(entry?.state.shadow_closed).toBe(false)
    }
  })

  it('does not walk closed shadow roots without the opt-in hook', () => {
    const dom = new JSDOM('<main><my-secret id="s"></my-secret></main>', {
      url: 'http://localhost/test',
    })
    const host = dom.window.document.getElementById('s')
    expect(host).not.toBeNull()
    if (host !== null) {
      const root = host.attachShadow({ mode: 'closed' })
      const button = dom.window.document.createElement('button')
      button.textContent = 'Secret Button'
      root.appendChild(button)
      const snap = walkAccessibilityTree(dom.window.document)
      // Closed shadow is opaque — element.shadowRoot is null, no hook present.
      expect(snap.entries.find(byName('Secret Button'))).toBeUndefined()
    }
  })

  it('walks closed shadow roots exposed via __stagewright_inspectShadow and marks them shadow_closed', () => {
    const dom = new JSDOM('<main><my-secret id="s"></my-secret></main>', {
      url: 'http://localhost/test',
    })
    const host = dom.window.document.getElementById('s')
    expect(host).not.toBeNull()
    if (host !== null) {
      const root = host.attachShadow({ mode: 'closed' })
      const button = dom.window.document.createElement('button')
      button.textContent = 'Exposed Secret'
      root.appendChild(button)
      // App author opts in by exposing the closed root through the hook.
      ;(
        dom.window as unknown as { __stagewright_inspectShadow: () => ShadowRoot[] }
      ).__stagewright_inspectShadow = () => [root]
      const snap = walkAccessibilityTree(dom.window.document)
      const entry = snap.entries.find(byName('Exposed Secret'))
      expect(entry).toBeDefined()
      expect(entry?.state.shadow_closed).toBe(true)
    }
  })

  it('ignores malformed and duplicate inspect hook returns', () => {
    const dom = new JSDOM('<main><my-secret id="s"></my-secret></main>', {
      url: 'http://localhost/test',
    })
    const host = dom.window.document.getElementById('s')
    expect(host).not.toBeNull()
    if (host !== null) {
      const root = host.attachShadow({ mode: 'closed' })
      const button = dom.window.document.createElement('button')
      button.textContent = 'Exposed Once'
      root.appendChild(button)
      ;(
        dom.window as unknown as { __stagewright_inspectShadow: () => unknown[] }
      ).__stagewright_inspectShadow = () => [root, root, null, {}, dom.window.document.body]
      const snap = walkAccessibilityTree(dom.window.document)
      const exposed = snap.entries.filter(byName('Exposed Once'))
      expect(exposed.length).toBe(1)
      expect(exposed[0]?.state.shadow_closed).toBe(true)
    }
  })

  it('survives a throwing inspect hook without breaking the snapshot', () => {
    const dom = new JSDOM('<main><button>Visible</button></main>', {
      url: 'http://localhost/test',
    })
    ;(
      dom.window as unknown as { __stagewright_inspectShadow: () => ShadowRoot[] }
    ).__stagewright_inspectShadow = () => {
      throw new Error('hook boom')
    }
    const snap = walkAccessibilityTree(dom.window.document)
    // The light DOM still walks fine despite the throwing hook.
    expect(snap.entries.find(byName('Visible'))).toBeDefined()
  })

  it('walks nested open shadow roots', () => {
    const dom = new JSDOM('<main><outer-el id="o"></outer-el></main>', {
      url: 'http://localhost/test',
    })
    const outer = dom.window.document.getElementById('o')
    expect(outer).not.toBeNull()
    if (outer !== null) {
      const outerRoot = outer.attachShadow({ mode: 'open' })
      const inner = dom.window.document.createElement('inner-el')
      outerRoot.appendChild(inner)
      const innerRoot = inner.attachShadow({ mode: 'open' })
      const button = dom.window.document.createElement('button')
      button.textContent = 'Deep Button'
      innerRoot.appendChild(button)
      const snap = walkAccessibilityTree(dom.window.document)
      expect(snap.entries.find(byName('Deep Button'))).toBeDefined()
    }
  })

  it('orders open shadow entries at their host position', () => {
    const dom = new JSDOM('<main><my-widget id="w"></my-widget><button>After</button></main>', {
      url: 'http://localhost/test',
    })
    const host = dom.window.document.getElementById('w')
    expect(host).not.toBeNull()
    if (host !== null) {
      const root = host.attachShadow({ mode: 'open' })
      const button = dom.window.document.createElement('button')
      button.textContent = 'Inside Shadow'
      root.appendChild(button)
      const snap = walkAccessibilityTree(dom.window.document)
      const buttons = snap.entries.filter((entry) => entry.role === 'button')
      expect(buttons.map((entry) => entry.name)).toEqual(['Inside Shadow', 'After'])
      expect(buttons.map((entry) => entry.ref)).toEqual([1, 2])
    }
  })

  it('applies host visibility to open shadow entries', () => {
    const dom = new JSDOM('<main><my-widget id="w" style="display:none"></my-widget></main>', {
      url: 'http://localhost/test',
    })
    const host = dom.window.document.getElementById('w')
    expect(host).not.toBeNull()
    if (host !== null) {
      const root = host.attachShadow({ mode: 'open' })
      const button = dom.window.document.createElement('button')
      button.textContent = 'Hidden Shadow'
      root.appendChild(button)
      const snap = walkAccessibilityTree(dom.window.document)
      const entry = snap.entries.find(byName('Hidden Shadow'))
      expect(entry).toBeDefined()
      expect(entry?.state.visible).toBe(false)
    }
  })

  it('includes composed ancestor roles in open shadow fingerprints', () => {
    const dom = new JSDOM(
      '<main><form><first-widget id="first"></first-widget></form><nav><second-widget id="second"></second-widget></nav></main>',
      {
        url: 'http://localhost/test',
      },
    )
    for (const id of ['first', 'second']) {
      const host = dom.window.document.getElementById(id)
      expect(host).not.toBeNull()
      if (host !== null) {
        const root = host.attachShadow({ mode: 'open' })
        const button = dom.window.document.createElement('button')
        button.textContent = 'Save'
        root.appendChild(button)
      }
    }
    const snap = walkAccessibilityTree(dom.window.document)
    const saves = snap.entries.filter(byName('Save'))
    expect(saves.length).toBe(2)
    expect(saves[0]?.fingerprint).not.toBe(saves[1]?.fingerprint)
  })

  it('resolves labels and descriptions inside open shadow roots', () => {
    const dom = new JSDOM('<main><my-widget id="w"></my-widget></main>', {
      url: 'http://localhost/test',
    })
    const host = dom.window.document.getElementById('w')
    expect(host).not.toBeNull()
    if (host !== null) {
      const root = host.attachShadow({ mode: 'open' })
      const label = dom.window.document.createElement('span')
      label.id = 'shadow-label'
      label.textContent = 'Shadow Submit'
      const description = dom.window.document.createElement('span')
      description.id = 'shadow-description'
      description.textContent = 'Runs inside the component'
      const button = dom.window.document.createElement('button')
      button.setAttribute('aria-labelledby', 'shadow-label')
      button.setAttribute('aria-describedby', 'shadow-description')
      const formLabel = dom.window.document.createElement('label')
      formLabel.setAttribute('for', 'shadow-email')
      formLabel.textContent = 'Shadow Email'
      const input = dom.window.document.createElement('input')
      input.id = 'shadow-email'
      input.type = 'email'
      root.append(label, description, button, formLabel, input)
      const snap = walkAccessibilityTree(dom.window.document)
      const buttonEntry = snap.entries.find(byName('Shadow Submit'))
      expect(buttonEntry).toBeDefined()
      expect(buttonEntry?.description).toBe('Runs inside the component')
      expect(snap.entries.find(byName('Shadow Email'))?.role).toBe('textbox')
    }
  })

  it('applies host aria-disabled to open shadow entries', () => {
    const dom = new JSDOM('<main><my-widget id="w" aria-disabled="true"></my-widget></main>', {
      url: 'http://localhost/test',
    })
    const host = dom.window.document.getElementById('w')
    expect(host).not.toBeNull()
    if (host !== null) {
      const root = host.attachShadow({ mode: 'open' })
      const button = dom.window.document.createElement('button')
      button.textContent = 'Disabled From Host'
      root.appendChild(button)
      const snap = walkAccessibilityTree(dom.window.document)
      const entry = snap.entries.find(byName('Disabled From Host'))
      expect(entry).toBeDefined()
      expect(entry?.state.disabled).toBe(true)
    }
  })
})
