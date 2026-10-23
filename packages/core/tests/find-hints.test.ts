/**
 * Unit tests for `findHints` / `hintNextActions`: why a semantic query matched nothing, computed
 * from a real walker snapshot.
 */

import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'

import { findHints, hintNextActions } from '../src/snapshot/find-hints.js'
import { type FindQuery, walkAccessibilityTree } from '../src/snapshot/index.js'

const walk = (html: string) => walkAccessibilityTree(new JSDOM(html).window.document, {})

describe('findHints', () => {
  it('offers close names of the same role, closest first', () => {
    const snapshot = walk(
      '<button>Save changes</button><button>Sav</button><button>Delete</button><a href="#">Save link</a>',
    )
    const hints = findHints(snapshot, { role: 'button', name_exact: 'Save' })
    expect(hints.similar_names?.map((entry) => entry.name)).toEqual(['Save changes', 'Sav'])
    expect(hints.similar_names?.every((entry) => entry.role === 'button')).toBe(true)
  })

  it('ranks names across roles when no role was given', () => {
    const hints = findHints(walk('<button>Settings</button><a href="#">Setings</a>'), {
      name_exact: 'Settngs',
    })
    expect(hints.similar_names?.map((entry) => entry.role).sort()).toEqual(['button', 'link'])
  })

  it('counts matches hidden by the state filters', () => {
    const snapshot = walk(
      '<button style="display:none">Save</button><button disabled>Save</button>',
    )
    expect(findHints(snapshot, { name_exact: 'Save', visible: true, enabled: true })).toMatchObject(
      { without_state_filters: { count: 2, filters: ['visible', 'enabled'] } },
    )
  })

  it('names the roles that carry the name and the roles present', () => {
    const snapshot = walk('<a href="#">Save</a><a href="#">Home</a><button>Go</button>')
    const hints = findHints(snapshot, { role: 'checkbox', name_exact: 'Save' })
    expect(hints.other_roles).toEqual([{ role: 'link', count: 1 }])
    expect(hints.roles_present).toEqual([
      { role: 'link', count: 2 },
      { role: 'button', count: 1 },
    ])
  })

  it('says nothing when there is nothing close', () => {
    expect(
      findHints(walk('<button>Delete</button>'), { role: 'button', name_exact: 'Zoom' }),
    ).toEqual({})
  })

  it('truncates long names and suggests name_contains for them', () => {
    const long = 'Save '.repeat(30).trim()
    const query: FindQuery = { role: 'button', name_exact: 'Save' }
    const hints = findHints(walk(`<button>${long} x</button>`), { ...query, name_exact: 'Save z' })
    expect(hints.similar_names?.[0]?.name).toHaveLength(81)
    expect(hintNextActions(query, hints)[0]).toContain('name_contains: "Save Save')
  })
})

describe('hintNextActions', () => {
  it('suggests each call once', () => {
    const query: FindQuery = { role: 'button', name_exact: 'Save', visible: true }
    const hints = findHints(walk('<button style="display:none">Save</button>'), query)
    expect(hintNextActions(query, hints)).toEqual([
      'electron_find({ role: "button", name_exact: "Save" })',
    ])
  })

  it('writes a call with no filters as an empty object', () => {
    const query: FindQuery = { interactive: true }
    const hints = findHints(walk('<main>Body</main>'), query)
    expect(hintNextActions(query, hints)).toEqual(['electron_find({})'])
  })

  it('builds concrete calls from the hints, at most three', () => {
    const query: FindQuery = { role: 'button', name_exact: 'Save', visible: true }
    const actions = hintNextActions(query, {
      similar_names: [{ ref: 1, role: 'button', name: 'Save changes' }],
      without_state_filters: { count: 1, filters: ['visible'] },
      other_roles: [{ role: 'link', count: 1 }],
      text_matches: {
        count: 1,
        samples: [{ tag: 'div', text: 'Save', selector: '#save', visible: true }],
      },
    })
    expect(actions).toEqual([
      'electron_find({ role: "button", name_exact: "Save changes" })',
      'electron_find({ role: "button", name_exact: "Save" })',
      'electron_find({ role: "link", name_exact: "Save", visible: true })',
    ])
  })

  it('points at electron_get_text for a text match with a selector', () => {
    expect(
      hintNextActions(
        { name_exact: 'Total' },
        {
          text_matches: {
            count: 2,
            samples: [
              { tag: 'span', text: 'Total', selector: null, visible: true },
              { tag: 'td', text: 'Total', selector: 'td:nth-of-type(2)', visible: true },
            ],
          },
        },
      ),
    ).toEqual(['electron_get_text({ selector: "td:nth-of-type(2)" })'])
  })
})
