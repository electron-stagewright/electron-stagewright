/**
 * Snapshot walker test suite.
 *
 * The walker is pure: given a `Document` it produces a `Snapshot`. The slice
 * exercises it against three framework-shape HTML fixtures loaded via jsdom,
 * plus a battery of targeted DOM cases for edge behaviours (hidden elements,
 * disabled buttons, shadow roots, fingerprint stability, accname precedence,
 * state extraction).
 *
 * jsdom limitations relevant to these tests:
 *
 * - No layout engine: `getBoundingClientRect` returns zeros. Tests assert
 *   `bbox` shape (`{ x, y, w, h }` all numbers) but never asserts non-zero
 *   values.
 * - Partial computed styles: inline `style="display:none"` works, cascade
 *   from external stylesheets does not. Tests use inline styles for hidden
 *   cases.
 * - Active element semantics differ slightly. Tests use `.focus()` calls so
 *   jsdom updates `document.activeElement`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { JSDOM } from 'jsdom'
import { describe, expect, it, beforeEach } from 'vitest'

import {
  SnapshotJsonSchema,
  computeAccessibleName,
  computeFingerprint,
  fnv1a32,
  isEntryReachable,
  isRoleInteractive,
  isVisible,
  resolveRole,
  walkAccessibilityTree,
  type Snapshot,
  type SnapshotEntry,
  type SnapshotRole,
} from '../src/snapshot/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = path.resolve(HERE, 'fixtures')

function loadFixtureDom(filename: string): JSDOM {
  const html = readFileSync(path.join(FIXTURE_DIR, filename), 'utf8')
  return new JSDOM(html, {
    runScripts: 'dangerously', // we control the fixtures; we want inline <script> to run for the Lit fixture's shadow root setup
    url: 'http://localhost/test',
  })
}

function snapshotOf(html: string): Snapshot {
  const dom = new JSDOM(html, { url: 'http://localhost/test' })
  return walkAccessibilityTree(dom.window.document)
}

function findEntry(
  snap: Snapshot,
  predicate: (entry: SnapshotEntry) => boolean,
): SnapshotEntry | undefined {
  return snap.entries.find(predicate)
}

function byRoleAndName(role: SnapshotRole, name: string) {
  return (entry: SnapshotEntry) => entry.role === role && entry.name === name
}

// ---------------------------------------------------------------------------
// fnv1a32 hash
// ---------------------------------------------------------------------------

describe('fnv1a32 hash', () => {
  it('matches standard FNV-1a 32-bit vectors', () => {
    expect(fnv1a32('')).toBe('811c9dc5')
    expect(fnv1a32('a')).toBe('e40c292c')
    expect(fnv1a32('hello')).toBe('4f9f2cab')
    expect(fnv1a32('foobar')).toBe('bf9cf968')
  })

  it('returns deterministic 8-character hex for the same input', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'))
    expect(fnv1a32('hello')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('produces different hashes for different inputs', () => {
    expect(fnv1a32('hello')).not.toBe(fnv1a32('world'))
    expect(fnv1a32('Hello')).not.toBe(fnv1a32('hello'))
  })

  it('handles empty input deterministically', () => {
    expect(fnv1a32('')).toBe('811c9dc5')
  })

  it('handles unicode without throwing', () => {
    expect(() => fnv1a32('héllo 世界 🎉')).not.toThrow()
    expect(fnv1a32('héllo 世界 🎉')).toBe('d1018fb6')
  })
})

describe('computeFingerprint', () => {
  it('mixes role, name, and ancestor chain into the hash', () => {
    const a = computeFingerprint('button', 'Save', ['form', 'main'])
    const b = computeFingerprint('button', 'Save', ['form', 'main'])
    const c = computeFingerprint('button', 'Save', ['form', 'aside'])
    const d = computeFingerprint('button', 'Cancel', ['form', 'main'])
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
  })

  it('uses only the last three ancestor roles for stability', () => {
    const shallow = computeFingerprint('button', 'Save', ['form', 'main'])
    const deep = computeFingerprint('button', 'Save', ['region', 'article', 'form', 'main'])
    // Last three ancestors differ — fingerprints differ.
    expect(shallow).not.toBe(deep)
    // Identical last-three ancestors — fingerprint stable.
    const a = computeFingerprint('button', 'Save', ['region', 'article', 'form', 'main'])
    const b = computeFingerprint('button', 'Save', ['banner', 'article', 'form', 'main'])
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// Accessible name (W3C accname-1.2)
// ---------------------------------------------------------------------------

describe('computeAccessibleName — W3C accname-1.2 precedence', () => {
  function nameOf(html: string, selector: string): string {
    const dom = new JSDOM(html)
    const target = dom.window.document.querySelector(selector)
    if (target === null) throw new Error(`selector "${selector}" matched nothing`)
    return computeAccessibleName(target)
  }

  it('1. aria-labelledby resolves text content of referenced elements', () => {
    const html =
      '<span id="label">Save</span><button aria-labelledby="label">unused content</button>'
    expect(nameOf(html, 'button')).toBe('Save')
  })

  it('1b. aria-labelledby with multiple ids concatenates text', () => {
    const html =
      '<span id="a">Save</span><span id="b">changes</span><button aria-labelledby="a b">unused</button>'
    expect(nameOf(html, 'button')).toBe('Save changes')
  })

  it('1c. aria-labelledby cycle is broken by the visited set', () => {
    const html =
      '<button id="a" aria-labelledby="b">A content</button><button id="b" aria-labelledby="a">B content</button>'
    // Cycle handling MUST return something (not infinite-loop). The actual
    // content depends on which element the visited set blocks first; the
    // important behaviour is termination + non-empty.
    const dom = new JSDOM(html)
    const a = dom.window.document.getElementById('a')
    expect(a).not.toBeNull()
    if (a !== null) {
      const name = computeAccessibleName(a)
      expect(typeof name).toBe('string')
    }
  })

  it('2. aria-label wins over text content', () => {
    expect(nameOf('<button aria-label="Save changes">SAVE</button>', 'button')).toBe('Save changes')
  })

  it('2b. empty aria-label falls through to next step', () => {
    expect(nameOf('<button aria-label="">Real name</button>', 'button')).toBe('Real name')
  })

  it('3a. label[for] resolution for inputs', () => {
    const html =
      '<label for="email">Email address</label><input id="email" type="email" placeholder="you@example.com" />'
    expect(nameOf(html, 'input')).toBe('Email address')
  })

  it('3b. wrapping <label> resolution for inputs', () => {
    const html = '<label>Newsletter <input type="checkbox" /></label>'
    expect(nameOf(html, 'input')).toBe('Newsletter')
  })

  it('3c. <fieldset><legend> resolution', () => {
    const html =
      '<fieldset><legend>Theme</legend><label><input type="radio" />Light</label></fieldset>'
    expect(nameOf(html, 'fieldset')).toBe('Theme')
  })

  it('3d. <details><summary> resolution', () => {
    expect(nameOf('<details><summary>More info</summary><p>Body</p></details>', 'details')).toBe(
      'More info',
    )
  })

  it('3e. <img alt> resolution', () => {
    expect(nameOf('<img src="x" alt="Profile photo" />', 'img')).toBe('Profile photo')
  })

  it('3f. <img alt=""> emits empty name (decorative)', () => {
    expect(nameOf('<img src="x" alt="" />', 'img')).toBe('')
  })

  it('4. name from content for button/link/heading', () => {
    expect(nameOf('<button>Save changes</button>', 'button')).toBe('Save changes')
    expect(nameOf('<a href="#">Read more</a>', 'a')).toBe('Read more')
    expect(nameOf('<h1>Welcome</h1>', 'h1')).toBe('Welcome')
  })

  it('5. title attribute is used when nothing else matches', () => {
    expect(nameOf('<div role="img" title="Logo"></div>', 'div')).toBe('Logo')
  })

  it('6. placeholder fallback for empty inputs only', () => {
    expect(nameOf('<input type="text" placeholder="Search…" />', 'input')).toBe('Search…')
    // When a real label exists the placeholder must NOT win.
    expect(
      nameOf(
        '<label for="x">Real label</label><input id="x" placeholder="placeholder text" />',
        'input',
      ),
    ).toBe('Real label')
  })

  it('whitespace is collapsed and trimmed', () => {
    expect(nameOf('<button>  Save   changes  \n  now </button>', 'button')).toBe('Save changes now')
  })

  it('name from content excludes nested form-control values', () => {
    const html = '<label>Newsletter <input type="checkbox" value="opted-in" /></label>'
    // Wrapping <label> for the checkbox; computing the checkbox's name uses
    // the label's text content excluding the input itself.
    expect(nameOf(html, 'input')).toBe('Newsletter')
  })
})

// ---------------------------------------------------------------------------
// Role resolution
// ---------------------------------------------------------------------------

describe('resolveRole — explicit role wins, falls back to implicit', () => {
  function roleOf(html: string, selector: string): SnapshotRole {
    const dom = new JSDOM(html)
    const el = dom.window.document.querySelector(selector)
    if (el === null) throw new Error(`selector "${selector}" matched nothing`)
    return resolveRole(el)
  }

  it('uses explicit role attribute when recognised', () => {
    expect(roleOf('<div role="button">Click</div>', 'div')).toBe('button')
    expect(roleOf('<span role="link">Go</span>', 'span')).toBe('link')
  })

  it('falls back to implicit when role attribute is unrecognised', () => {
    expect(roleOf('<button role="banana">Click</button>', 'button')).toBe('button')
  })

  it('maps HTML form controls to ARIA roles', () => {
    expect(roleOf('<input type="text" />', 'input')).toBe('textbox')
    expect(roleOf('<input type="search" />', 'input')).toBe('searchbox')
    expect(roleOf('<input type="checkbox" />', 'input')).toBe('checkbox')
    expect(roleOf('<input type="radio" />', 'input')).toBe('radio')
    expect(roleOf('<input type="range" />', 'input')).toBe('slider')
    expect(roleOf('<input type="number" />', 'input')).toBe('spinbutton')
    expect(roleOf('<input type="submit" />', 'input')).toBe('button')
    expect(roleOf('<input type="hidden" />', 'input')).toBe('unknown')
  })

  it('maps <select> with multiple to listbox, plain select to combobox', () => {
    expect(roleOf('<select></select>', 'select')).toBe('combobox')
    expect(roleOf('<select multiple></select>', 'select')).toBe('listbox')
    expect(roleOf('<select size="5"></select>', 'select')).toBe('listbox')
  })

  it('maps <a href> to link, <a> without href to unknown', () => {
    expect(roleOf('<a href="#">Go</a>', 'a')).toBe('link')
    expect(roleOf('<a>Go</a>', 'a')).toBe('unknown')
  })

  it('maps landmarks to their ARIA roles', () => {
    expect(roleOf('<main></main>', 'main')).toBe('main')
    expect(roleOf('<nav></nav>', 'nav')).toBe('navigation')
    expect(roleOf('<header></header>', 'header')).toBe('banner')
    expect(roleOf('<footer></footer>', 'footer')).toBe('contentinfo')
    expect(roleOf('<aside></aside>', 'aside')).toBe('complementary')
    expect(roleOf('<section></section>', 'section')).toBe('region')
    expect(roleOf('<article></article>', 'article')).toBe('article')
  })

  it('maps <h1>..<h6> all to heading', () => {
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(roleOf(`<${tag}>title</${tag}>`, tag)).toBe('heading')
    }
  })

  it('maps generic contenteditable elements to textbox', () => {
    expect(roleOf('<div contenteditable="true">Draft</div>', 'div')).toBe('textbox')
    expect(roleOf('<section contenteditable="">Draft</section>', 'section')).toBe('textbox')
  })
})

// ---------------------------------------------------------------------------
// State extraction
// ---------------------------------------------------------------------------

describe('extractState — full state envelope, role-aware nulls', () => {
  it('button entry: applicable flags populated, non-applicable are null', () => {
    const snap = snapshotOf('<button>Save</button>')
    const entry = findEntry(snap, byRoleAndName('button', 'Save'))
    expect(entry).toBeDefined()
    if (entry !== undefined) {
      expect(entry.state.disabled).toBe(false)
      expect(entry.state.busy).toBe(false)
      // button has no checked/selected/readonly/required/invalid
      expect(entry.state.checked).toBeNull()
      expect(entry.state.selected).toBeNull()
      expect(entry.state.readonly).toBeNull()
      expect(entry.state.required).toBeNull()
      expect(entry.state.invalid).toBeNull()
      // expanded and pressed apply to buttons but null when not explicitly set
      expect(entry.state.expanded).toBeNull()
      expect(entry.state.pressed).toBeNull()
    }
  })

  it('<button disabled> is interactive but state.disabled is true', () => {
    const snap = snapshotOf('<button disabled>Reset</button>')
    const entry = findEntry(snap, byRoleAndName('button', 'Reset'))
    expect(entry).toBeDefined()
    if (entry !== undefined) {
      expect(entry.interactive).toBe(true)
      expect(entry.state.disabled).toBe(true)
    }
  })

  it('aria-disabled also drives disabled state', () => {
    const snap = snapshotOf('<button aria-disabled="true">Locked</button>')
    const entry = findEntry(snap, byRoleAndName('button', 'Locked'))
    expect(entry?.state.disabled).toBe(true)
  })

  it('<fieldset disabled> propagates to its descendants', () => {
    const snap = snapshotOf('<fieldset disabled><label>x<input type="text" /></label></fieldset>')
    const input = findEntry(snap, (e) => e.role === 'textbox')
    expect(input?.state.disabled).toBe(true)
  })

  it('checkbox: checked flag reflects checked attribute', () => {
    const snapChecked = snapshotOf('<label>Newsletter <input type="checkbox" checked /></label>')
    const snapUnchecked = snapshotOf('<label>Newsletter <input type="checkbox" /></label>')
    expect(findEntry(snapChecked, byRoleAndName('checkbox', 'Newsletter'))?.state.checked).toBe(
      true,
    )
    expect(findEntry(snapUnchecked, byRoleAndName('checkbox', 'Newsletter'))?.state.checked).toBe(
      false,
    )
  })

  it('aria-checked drives checked for role=checkbox without input', () => {
    const snap = snapshotOf('<div role="checkbox" aria-checked="true">Subscribe</div>')
    const entry = findEntry(snap, byRoleAndName('checkbox', 'Subscribe'))
    expect(entry?.state.checked).toBe(true)
  })

  it('button with aria-expanded reports expanded tri-state', () => {
    const snapOpen = snapshotOf('<button aria-expanded="true">Menu</button>')
    const snapClosed = snapshotOf('<button aria-expanded="false">Menu</button>')
    const snapPlain = snapshotOf('<button>Plain</button>')
    expect(findEntry(snapOpen, byRoleAndName('button', 'Menu'))?.state.expanded).toBe(true)
    expect(findEntry(snapClosed, byRoleAndName('button', 'Menu'))?.state.expanded).toBe(false)
    expect(findEntry(snapPlain, byRoleAndName('button', 'Plain'))?.state.expanded).toBeNull()
  })

  it('toggle button aria-pressed', () => {
    const snapOn = snapshotOf('<button aria-pressed="true">Star</button>')
    const snapOff = snapshotOf('<button aria-pressed="false">Star</button>')
    expect(findEntry(snapOn, byRoleAndName('button', 'Star'))?.state.pressed).toBe(true)
    expect(findEntry(snapOff, byRoleAndName('button', 'Star'))?.state.pressed).toBe(false)
  })

  it('option aria-selected', () => {
    const snap = snapshotOf(
      '<ul role="listbox"><li role="option" aria-selected="true">A</li><li role="option" aria-selected="false">B</li></ul>',
    )
    expect(findEntry(snap, byRoleAndName('option', 'A'))?.state.selected).toBe(true)
    expect(findEntry(snap, byRoleAndName('option', 'B'))?.state.selected).toBe(false)
  })

  it('native <option selected> reflects current selected property', () => {
    const dom = new JSDOM('<select><option>One</option><option selected>Two</option></select>')
    const selected = dom.window.document.querySelector('option[selected]')
    expect(selected).not.toBeNull()
    if (selected !== null) {
      selected.selected = false
      const snap = walkAccessibilityTree(dom.window.document)
      expect(findEntry(snap, byRoleAndName('option', 'Two'))?.state.selected).toBe(false)
    }
  })

  it('textbox readonly and required', () => {
    const snap = snapshotOf(
      '<label for="x">Name</label><input id="x" type="text" readonly required />',
    )
    const entry = findEntry(snap, byRoleAndName('textbox', 'Name'))
    expect(entry?.state.readonly).toBe(true)
    expect(entry?.state.required).toBe(true)
  })

  it('aria-invalid', () => {
    const snap = snapshotOf(
      '<label for="x">Email</label><input id="x" type="email" aria-invalid="true" />',
    )
    expect(findEntry(snap, byRoleAndName('textbox', 'Email'))?.state.invalid).toBe(true)
  })

  it('aria-busy as global state', () => {
    const snap = snapshotOf('<button aria-busy="true">Saving…</button>')
    expect(findEntry(snap, byRoleAndName('button', 'Saving…'))?.state.busy).toBe(true)
  })

  it('focused state reflects document.activeElement', () => {
    const dom = new JSDOM('<button id="b">Save</button>')
    const button = dom.window.document.getElementById('b')
    expect(button).not.toBeNull()
    if (button !== null) {
      ;(button as HTMLButtonElement).focus()
      const snap = walkAccessibilityTree(dom.window.document)
      const entry = findEntry(snap, byRoleAndName('button', 'Save'))
      expect(entry?.state.focused).toBe(true)
    }
  })

  it('<details open> reports expanded=true on the summary entry', () => {
    const snap = snapshotOf('<details open><summary>More</summary><p>Body</p></details>')
    const entry = findEntry(snap, byRoleAndName('button', 'More'))
    expect(entry?.state.expanded).toBe(true)
  })

  it('<details> closed reports expanded=false on the summary entry', () => {
    const snap = snapshotOf('<details><summary>More</summary><p>Body</p></details>')
    const entry = findEntry(snap, byRoleAndName('button', 'More'))
    expect(entry?.state.expanded).toBe(false)
  })

  it('does NOT emit duplicate button for <details> + <summary>', () => {
    const snap = snapshotOf('<details><summary>More</summary><p>Body</p></details>')
    // Only the summary is the clickable button; the details container is
    // dropped from the snapshot to avoid double-counting the same
    // interaction surface.
    const moreButtons = snap.entries.filter((e) => e.role === 'button' && e.name === 'More')
    expect(moreButtons.length).toBe(1)
    expect(moreButtons[0]?.tag).toBe('summary')
  })
})

describe('regression — JS-mutated boolean state', () => {
  it('reads checkbox.checked from the property when JS overrides the attribute', () => {
    // <input checked /> with a subsequent `el.checked = false` should read
    // FALSE (current state) not TRUE (default-state attribute).
    const dom = new JSDOM('<label>Subscribe <input type="checkbox" checked /></label>')
    const checkbox = dom.window.document.querySelector('input')
    expect(checkbox).not.toBeNull()
    if (checkbox !== null) {
      // Sanity: attribute is still present, property is true initially.
      expect(checkbox.hasAttribute('checked')).toBe(true)
      expect(checkbox.checked).toBe(true)
      // Mutate the property as a user interaction would.
      checkbox.checked = false
      const snap = walkAccessibilityTree(dom.window.document)
      const entry = findEntry(snap, byRoleAndName('checkbox', 'Subscribe'))
      expect(entry?.state.checked).toBe(false)
    }
  })

  it('reads disabled from the property when JS sets it imperatively', () => {
    const dom = new JSDOM('<button>Save</button>')
    const button = dom.window.document.querySelector('button')
    expect(button).not.toBeNull()
    if (button !== null) {
      // No `disabled` attribute, but JS sets the property.
      button.disabled = true
      const snap = walkAccessibilityTree(dom.window.document)
      const entry = findEntry(snap, byRoleAndName('button', 'Save'))
      expect(entry?.state.disabled).toBe(true)
    }
  })

  it('aria-checked is read from the attribute (no matching property)', () => {
    // Custom checkbox-roled div with aria-checked drives state.checked via
    // the attribute path; this exercises the aria-* branch of readBooleanAttr.
    const snap = snapshotOf('<div role="checkbox" aria-checked="false">Opt in</div>')
    const entry = findEntry(snap, byRoleAndName('checkbox', 'Opt in'))
    expect(entry?.state.checked).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

describe('isVisible — walks ancestor chain', () => {
  function visibilityOf(html: string, selector: string): boolean {
    const dom = new JSDOM(html)
    const target = dom.window.document.querySelector(selector)
    if (target === null) throw new Error('selector matched nothing')
    return isVisible(target)
  }

  it('plain element is visible', () => {
    expect(visibilityOf('<button>Save</button>', 'button')).toBe(true)
  })

  it('display:none inline hides the element', () => {
    expect(visibilityOf('<button style="display:none">Save</button>', 'button')).toBe(false)
  })

  it('visibility:hidden inline hides the element', () => {
    expect(visibilityOf('<button style="visibility:hidden">Save</button>', 'button')).toBe(false)
  })

  it('display:none ANCESTOR hides descendants', () => {
    expect(visibilityOf('<div style="display:none"><button>Hidden</button></div>', 'button')).toBe(
      false,
    )
  })

  it('hidden attribute hides', () => {
    expect(visibilityOf('<button hidden>Save</button>', 'button')).toBe(false)
  })

  it('aria-hidden=true on ancestor hides descendants', () => {
    expect(visibilityOf('<div aria-hidden="true"><button>Hidden</button></div>', 'button')).toBe(
      false,
    )
  })

  it('aria-hidden=true on the element itself hides', () => {
    expect(visibilityOf('<button aria-hidden="true">Hidden</button>', 'button')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Walker — empty / shape / refs / interactive flag
// ---------------------------------------------------------------------------

describe('walkAccessibilityTree — top-level shape', () => {
  it('handles empty DOM without crashing', () => {
    const snap = snapshotOf('')
    expect(snap.schemaVersion).toBe(1)
    expect(snap.entries).toEqual([])
    expect(snap.meta.diff_baseline).toBe('full')
    expect(typeof snap.meta.navigation_started_at_ms).toBe('number')
    expect(snap.meta.renderer_reloaded_since_last_snapshot).toBe(false)
  })

  it('assigns sequential refs to interactive entries only', () => {
    const snap = snapshotOf('<main><h1>Welcome</h1><button>One</button><button>Two</button></main>')
    const buttonOne = findEntry(snap, byRoleAndName('button', 'One'))
    const buttonTwo = findEntry(snap, byRoleAndName('button', 'Two'))
    const heading = findEntry(snap, byRoleAndName('heading', 'Welcome'))
    expect(buttonOne?.ref).toBe(1)
    expect(buttonTwo?.ref).toBe(2)
    expect(heading?.ref).toBeNull()
    expect(heading?.interactive).toBe(false)
  })

  it('every entry carries the full state envelope shape', () => {
    const snap = snapshotOf('<button>X</button>')
    const entry = snap.entries[0]
    expect(entry).toBeDefined()
    if (entry !== undefined) {
      expect(typeof entry.state.visible).toBe('boolean')
      expect(typeof entry.state.disabled).toBe('boolean')
      expect(typeof entry.state.busy).toBe('boolean')
      expect(typeof entry.state.focused).toBe('boolean')
      expect(typeof entry.state.shadow_closed).toBe('boolean')
      // Nullable flags: either boolean or null, never undefined.
      expect(entry.state.checked === null || typeof entry.state.checked === 'boolean').toBe(true)
      expect(entry.state.selected === null || typeof entry.state.selected === 'boolean').toBe(true)
      expect(entry.state.expanded === null || typeof entry.state.expanded === 'boolean').toBe(true)
      expect(entry.state.pressed === null || typeof entry.state.pressed === 'boolean').toBe(true)
      expect(entry.state.readonly === null || typeof entry.state.readonly === 'boolean').toBe(true)
      expect(entry.state.required === null || typeof entry.state.required === 'boolean').toBe(true)
      expect(entry.state.invalid === null || typeof entry.state.invalid === 'boolean').toBe(true)
    }
  })

  it('every entry carries the bbox shape with numeric values', () => {
    const snap = snapshotOf('<button>X</button>')
    const entry = snap.entries[0]
    expect(entry).toBeDefined()
    if (entry !== undefined) {
      expect(typeof entry.bbox.x).toBe('number')
      expect(typeof entry.bbox.y).toBe('number')
      expect(typeof entry.bbox.w).toBe('number')
      expect(typeof entry.bbox.h).toBe('number')
    }
  })

  it('value field reflects input value', () => {
    const html = '<label for="x">Name</label><input id="x" type="text" value="prefilled" />'
    const snap = snapshotOf(html)
    const entry = findEntry(snap, byRoleAndName('textbox', 'Name'))
    expect(entry?.value).toBe('prefilled')
  })

  it('placeholder field reflects placeholder attribute', () => {
    const html = '<label for="x">Search</label><input id="x" placeholder="Type here…" />'
    const snap = snapshotOf(html)
    const entry = findEntry(snap, byRoleAndName('textbox', 'Search'))
    expect(entry?.placeholder).toBe('Type here…')
  })

  it('omits non-interactive elements from outside the role allow-list', () => {
    // <div> with no role attribute is not in the candidate selector and is
    // silently skipped — the <button> child is the only emitted entry.
    const snap = snapshotOf('<div><button>Real</button></div>')
    expect(snap.entries.length).toBe(1)
    expect(snap.entries.find((e) => e.role === 'unknown')).toBeUndefined()
  })

  it('omits elements whose explicit role attribute is unrecognised', () => {
    // <div role="banana"> does not match the CANDIDATE_SELECTOR because the
    // selector only enumerates the recognised role values. The walker treats
    // unrecognised role attributes the same as no role at all — silently
    // skipped. The agent doesn't see noise it can't act on.
    const snap = snapshotOf('<div role="banana">Mystery</div>')
    expect(snap.entries).toEqual([])
  })

  it('description reflects aria-describedby content', () => {
    const html =
      '<button aria-describedby="hint">Submit</button><span id="hint">Sends to server</span>'
    const snap = snapshotOf(html)
    const entry = findEntry(snap, byRoleAndName('button', 'Submit'))
    expect(entry?.description).toBe('Sends to server')
  })

  it('description falls back to title when aria-describedby is absent', () => {
    const snap = snapshotOf('<button title="Runs validation">Validate</button>')
    const entry = findEntry(snap, byRoleAndName('button', 'Validate'))
    expect(entry?.description).toBe('Runs validation')
  })

  it('plain contenteditable surfaces are emitted as textboxes with value', () => {
    const snap = snapshotOf('<div contenteditable="true">Draft body</div>')
    const entry = findEntry(snap, (e) => e.role === 'textbox')
    expect(entry).toBeDefined()
    expect(entry?.interactive).toBe(true)
    expect(entry?.value).toBe('Draft body')
  })
})

// ---------------------------------------------------------------------------
// Fingerprint stability across DOM mutation
// ---------------------------------------------------------------------------

describe('fingerprint stability under DOM mutation', () => {
  let dom: JSDOM

  beforeEach(() => {
    dom = new JSDOM('<main><form><button>Save</button><button>Cancel</button></form></main>')
  })

  it('inserting a sibling does NOT drift the fingerprint of existing entries', () => {
    const before = walkAccessibilityTree(dom.window.document)
    const saveBefore = findEntry(before, byRoleAndName('button', 'Save'))
    expect(saveBefore).toBeDefined()

    // Insert a new button BEFORE the Save button — sibling reorder.
    const form = dom.window.document.querySelector('form')
    if (form === null) throw new Error('form vanished')
    const newButton = dom.window.document.createElement('button')
    newButton.textContent = 'New'
    form.insertBefore(newButton, form.firstChild)

    const after = walkAccessibilityTree(dom.window.document)
    const saveAfter = findEntry(after, byRoleAndName('button', 'Save'))
    expect(saveAfter).toBeDefined()
    expect(saveAfter?.fingerprint).toBe(saveBefore?.fingerprint)
  })

  it('changing the parent role DOES drift the fingerprint', () => {
    const before = walkAccessibilityTree(dom.window.document)
    const saveBefore = findEntry(before, byRoleAndName('button', 'Save'))
    expect(saveBefore).toBeDefined()

    // Wrap the form in a nav (changes ancestor chain near the Save button).
    const form = dom.window.document.querySelector('form')
    const main = dom.window.document.querySelector('main')
    if (form === null || main === null) throw new Error('structure vanished')
    const nav = dom.window.document.createElement('nav')
    main.removeChild(form)
    nav.appendChild(form)
    main.appendChild(nav)

    const after = walkAccessibilityTree(dom.window.document)
    const saveAfter = findEntry(after, byRoleAndName('button', 'Save'))
    expect(saveAfter).toBeDefined()
    expect(saveAfter?.fingerprint).not.toBe(saveBefore?.fingerprint)
  })

  it('two distinct entries share fingerprints only when role+name+ancestors match', () => {
    const snap = snapshotOf(
      '<main><form><button>Save</button></form><nav><button>Save</button></nav></main>',
    )
    const matches = snap.entries.filter((e) => e.role === 'button' && e.name === 'Save')
    expect(matches.length).toBe(2)
    // Different ancestors (form vs nav) — fingerprints differ.
    expect(matches[0]?.fingerprint).not.toBe(matches[1]?.fingerprint)
  })
})

// ---------------------------------------------------------------------------
// isEntryReachable predicate
// ---------------------------------------------------------------------------

describe('isEntryReachable predicate', () => {
  it('returns false when the element is hidden', () => {
    const dom = new JSDOM('<button style="display:none">Hidden</button>')
    const button = dom.window.document.querySelector('button')
    expect(button).not.toBeNull()
    if (button !== null) {
      expect(isEntryReachable(button, 'button')).toBe(false)
    }
  })

  it('returns false when the role is not interactive', () => {
    const dom = new JSDOM('<main>Main content</main>')
    const main = dom.window.document.querySelector('main')
    expect(main).not.toBeNull()
    if (main !== null) {
      expect(isEntryReachable(main, 'main')).toBe(false)
    }
  })

  it('returns true when visible and interactive', () => {
    const dom = new JSDOM('<button>Save</button>')
    const button = dom.window.document.querySelector('button')
    expect(button).not.toBeNull()
    if (button !== null) {
      expect(isEntryReachable(button, 'button')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// isRoleInteractive
// ---------------------------------------------------------------------------

describe('isRoleInteractive', () => {
  it('returns true for action-bearing roles', () => {
    for (const role of [
      'button',
      'link',
      'checkbox',
      'radio',
      'textbox',
      'searchbox',
      'combobox',
      'listbox',
      'option',
      'switch',
      'slider',
      'spinbutton',
      'menuitem',
      'menuitemcheckbox',
      'menuitemradio',
      'tab',
      'treeitem',
    ] as const) {
      expect(isRoleInteractive(role)).toBe(true)
    }
  })

  it('returns false for landmarks and content roles', () => {
    for (const role of [
      'main',
      'navigation',
      'banner',
      'contentinfo',
      'complementary',
      'region',
      'search',
      'form',
      'heading',
      'article',
      'text',
      'image',
      'separator',
      'progressbar',
      'status',
      'alert',
      'unknown',
    ] as const) {
      expect(isRoleInteractive(role)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// JSON Schema export
// ---------------------------------------------------------------------------

describe('SnapshotJsonSchema export', () => {
  it('is a valid Draft-07 schema descriptor', () => {
    expect(SnapshotJsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#')
    expect(SnapshotJsonSchema.type).toBe('object')
    expect(SnapshotJsonSchema.required).toContain('schemaVersion')
    expect(SnapshotJsonSchema.required).toContain('entries')
    expect(SnapshotJsonSchema.required).toContain('meta')
  })

  it('declares every state flag in $defs.SnapshotState', () => {
    const stateProps = SnapshotJsonSchema.$defs.SnapshotState.properties
    expect(Object.keys(stateProps)).toEqual(
      expect.arrayContaining([
        'visible',
        'disabled',
        'checked',
        'selected',
        'expanded',
        'pressed',
        'focused',
        'readonly',
        'required',
        'invalid',
        'busy',
        'shadow_closed',
      ]),
    )
  })

  it('schema entry shape matches the TS SnapshotEntry surface', () => {
    const entryProps = SnapshotJsonSchema.$defs.SnapshotEntry.properties
    expect(Object.keys(entryProps)).toEqual(
      expect.arrayContaining([
        'ref',
        'tag',
        'role',
        'name',
        'description',
        'interactive',
        'state',
        'bbox',
        'fingerprint',
        'recently_changed',
        'value',
        'placeholder',
      ]),
    )
  })
})

// ---------------------------------------------------------------------------
// Fixture-driven tests (framework shapes)
// ---------------------------------------------------------------------------

describe('framework-shape fixtures', () => {
  describe('React-shape fixture', () => {
    let snap: Snapshot
    beforeEach(() => {
      const dom = loadFixtureDom('snapshot-react.html')
      snap = walkAccessibilityTree(dom.window.document)
    })

    it('detects all standard form controls', () => {
      expect(findEntry(snap, byRoleAndName('textbox', 'Display name'))).toBeDefined()
      expect(findEntry(snap, byRoleAndName('textbox', 'Email address'))).toBeDefined()
      expect(
        findEntry(snap, byRoleAndName('checkbox', 'Subscribe to the newsletter')),
      ).toBeDefined()
      expect(findEntry(snap, byRoleAndName('button', 'Save changes'))).toBeDefined()
    })

    it('detects the disabled Reset button with state.disabled=true', () => {
      const reset = findEntry(snap, byRoleAndName('button', 'Reset'))
      expect(reset).toBeDefined()
      expect(reset?.state.disabled).toBe(true)
      // Still interactive: the agent SEES it but reads state.disabled.
      expect(reset?.interactive).toBe(true)
    })

    it('detects radio buttons with their values + checked state', () => {
      const dark = findEntry(snap, byRoleAndName('radio', 'Dark'))
      expect(dark).toBeDefined()
      expect(dark?.state.checked).toBe(true)
      const light = findEntry(snap, byRoleAndName('radio', 'Light'))
      expect(light?.state.checked).toBe(false)
    })

    it('emits landmarks with interactive=false and ref=null', () => {
      const main = findEntry(snap, (e) => e.role === 'main')
      expect(main).toBeDefined()
      expect(main?.interactive).toBe(false)
      expect(main?.ref).toBeNull()
    })

    it('emits headings (Settings, Profile) as non-interactive', () => {
      const h1 = findEntry(snap, byRoleAndName('heading', 'Settings'))
      const h2 = findEntry(snap, byRoleAndName('heading', 'Profile'))
      expect(h1).toBeDefined()
      expect(h2).toBeDefined()
      expect(h1?.interactive).toBe(false)
      expect(h2?.interactive).toBe(false)
    })

    it('email input carries aria-invalid=false', () => {
      const email = findEntry(snap, byRoleAndName('textbox', 'Email address'))
      expect(email?.state.invalid).toBe(false)
      expect(email?.state.required).toBe(true)
    })

    it('every interactive entry has a numeric ref starting at 1', () => {
      const interactives = snap.entries.filter((e) => e.interactive)
      expect(interactives.length).toBeGreaterThan(0)
      for (let i = 0; i < interactives.length; i++) {
        expect(interactives[i]?.ref).toBe(i + 1)
      }
    })
  })

  describe('Vue-shape fixture', () => {
    let snap: Snapshot
    beforeEach(() => {
      const dom = loadFixtureDom('snapshot-vue.html')
      snap = walkAccessibilityTree(dom.window.document)
    })

    it('detects role=tab tabs with selected state', () => {
      const all = findEntry(snap, byRoleAndName('tab', 'All'))
      const unread = findEntry(snap, byRoleAndName('tab', 'Unread'))
      expect(all?.state.selected).toBe(true)
      expect(unread?.state.selected).toBe(false)
    })

    it('detects contenteditable searchbox', () => {
      const search = findEntry(snap, byRoleAndName('searchbox', 'Search messages'))
      expect(search).toBeDefined()
      expect(search?.interactive).toBe(true)
    })

    it('detects toggle-button aria-pressed states', () => {
      const stars = snap.entries.filter((e) => e.role === 'button' && e.name === 'Star')
      expect(stars.length).toBe(2)
      // One pressed, one not — order is document order; first article is unpressed.
      const pressedStates = stars.map((s) => s.state.pressed)
      expect(pressedStates).toContain(true)
      expect(pressedStates).toContain(false)
    })

    it('detects role=menu and menuitemcheckbox with checked state', () => {
      const menu = findEntry(snap, (e) => e.role === 'menu')
      expect(menu).toBeDefined()
      const hasAttachment = findEntry(snap, byRoleAndName('menuitemcheckbox', 'Has attachment'))
      const unreadOnly = findEntry(snap, byRoleAndName('menuitemcheckbox', 'Unread only'))
      expect(hasAttachment?.state.checked).toBe(false)
      expect(unreadOnly?.state.checked).toBe(true)
    })

    it('detects the Filters button with aria-expanded=false', () => {
      const filters = findEntry(snap, byRoleAndName('button', 'Filters'))
      expect(filters?.state.expanded).toBe(false)
    })

    it('ignores data-v-* attributes — none of them shape the snapshot', () => {
      // Sanity: no entry name should contain `data-v` artifacts.
      for (const entry of snap.entries) {
        expect(entry.name).not.toContain('data-v')
      }
    })

    it('the hidden menu is not visible per state', () => {
      const menu = findEntry(snap, (e) => e.role === 'menu')
      expect(menu?.state.visible).toBe(false)
    })
  })

  describe('Lit-shape fixture (document walker)', () => {
    let snap: Snapshot
    beforeEach(() => {
      const dom = loadFixtureDom('snapshot-lit.html')
      snap = walkAccessibilityTree(dom.window.document)
    })

    it('detects buttons in light DOM (toolbar)', () => {
      expect(findEntry(snap, byRoleAndName('button', 'Bold'))).toBeDefined()
      expect(findEntry(snap, byRoleAndName('button', 'Italic'))).toBeDefined()
    })

    it('the editor heading and document-title text are emitted', () => {
      expect(findEntry(snap, byRoleAndName('heading', 'Editor'))).toBeDefined()
    })

    it('open shadow root contents ARE walked (recursion into element.shadowRoot)', () => {
      // The walker now recurses into open shadow roots. The picker's R/G/B
      // buttons live in an open shadow root and must appear in the snapshot.
      expect(findEntry(snap, byRoleAndName('button', 'Red'))).toBeDefined()
      expect(findEntry(snap, byRoleAndName('button', 'Green'))).toBeDefined()
      expect(findEntry(snap, byRoleAndName('button', 'Blue'))).toBeDefined()
    })

    it('open-shadow entries are not marked shadow_closed', () => {
      const red = findEntry(snap, byRoleAndName('button', 'Red'))
      expect(red?.state.shadow_closed).toBe(false)
    })
  })
})
