/**
 * Explain a semantic query that matched nothing: names close to the one asked for, matches that a
 * state filter hid, the same name under other roles, and the roles present when the requested one is
 * absent. Pure over an already-produced snapshot, and only run when the query found no entries.
 *
 * @module
 */

import { findEntries } from './find.js'
import type { FindQuery, Snapshot, SnapshotEntry } from './schema.js'

/** One element offered as a likely intended target. */
export interface FindHintEntry {
  readonly ref: number | null
  readonly role: string
  readonly name: string
}

/** Why a semantic query found nothing; every field is present only when it has something to say. */
export interface FindHints {
  /** Entries whose name is close to the requested one (same role when a role was given). */
  readonly similar_names?: readonly FindHintEntry[]
  /** How many entries match once the state filters (visible / enabled / interactive) are dropped. */
  readonly without_state_filters?: { readonly count: number; readonly filters: readonly string[] }
  /** Roles that do carry the requested name, when a role was given. */
  readonly other_roles?: readonly { readonly role: string; readonly count: number }[]
  /** The roles present on the surface, when no entry has the requested role at all. */
  readonly roles_present?: readonly { readonly role: string; readonly count: number }[]
  /** Innermost elements whose text content (not accessible name) contains the requested name. */
  readonly text_matches?: TextMatches
  /** Concrete calls to try next, most likely first. */
  readonly next_actions?: readonly string[]
}

/** Elements found by text content; `selector` is null inside a shadow root. */
export interface TextMatches {
  readonly count: number
  readonly samples: readonly {
    readonly tag: string
    readonly text: string
    readonly selector: string | null
    readonly visible: boolean
  }[]
}

const MAX_SIMILAR = 5
const MAX_ROLES = 8
const MAX_NAME_CHARS = 80
const STATE_FILTERS = ['visible', 'enabled', 'interactive'] as const

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j] ?? 0
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      previous = saved
    }
  }
  return row[b.length] ?? 0
}

/** 1 for an identical or contained name, down to 0; a shared word scores at least 0.5. */
function similarity(query: string, name: string): number {
  const q = query.toLowerCase().trim()
  const n = name.toLowerCase().trim()
  if (q === '' || n === '') return 0
  if (n.includes(q) || q.includes(n)) return 1
  const words = q.split(/\s+/).filter((word) => word.length > 2)
  const sharesWord = words.some((word) => n.includes(word))
  const distance = levenshtein(q, n) / Math.max(q.length, n.length)
  return Math.max(1 - distance, sharesWord ? 0.5 : 0)
}

function countByRole(entries: readonly SnapshotEntry[]): { role: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const entry of entries) counts.set(entry.role, (counts.get(entry.role) ?? 0) + 1)
  return [...counts]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count || a.role.localeCompare(b.role))
}

function withoutKeys(query: FindQuery, keys: readonly string[]): FindQuery {
  return Object.fromEntries(
    Object.entries(query).filter(([key]) => !keys.includes(key)),
  ) as FindQuery
}

/** Build {@link FindHints} for a query that matched no entry of `snapshot`. */
export function findHints(snapshot: Snapshot, query: FindQuery): FindHints {
  const name = query.name_exact ?? query.name_contains
  const hints: {
    similar_names?: FindHintEntry[]
    without_state_filters?: { count: number; filters: string[] }
    other_roles?: { role: string; count: number }[]
    roles_present?: { role: string; count: number }[]
  } = {}

  const filters = STATE_FILTERS.filter((key) => query[key] !== undefined)
  if (filters.length > 0) {
    const count = findEntries(snapshot, withoutKeys(query, filters)).length
    if (count > 0) hints.without_state_filters = { count, filters }
  }

  if (query.role !== undefined) {
    if (!snapshot.entries.some((entry) => entry.role === query.role)) {
      hints.roles_present = countByRole(snapshot.entries).slice(0, MAX_ROLES)
    }
    if (name !== undefined) {
      const sameName = findEntries(snapshot, withoutKeys(query, ['role']))
      if (sameName.length > 0) hints.other_roles = countByRole(sameName).slice(0, MAX_ROLES)
    }
  }

  if (name !== undefined) {
    const candidates = snapshot.entries.filter(
      (entry) => entry.name !== '' && (query.role === undefined || entry.role === query.role),
    )
    const ranked = candidates
      .map((entry) => ({ entry, score: similarity(name, entry.name) }))
      .filter(({ score }) => score >= 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SIMILAR)
    if (ranked.length > 0) {
      hints.similar_names = ranked.map(({ entry }) => ({
        ref: entry.ref,
        role: entry.role,
        name:
          entry.name.length > MAX_NAME_CHARS
            ? `${entry.name.slice(0, MAX_NAME_CHARS)}…`
            : entry.name,
      }))
    }
  }
  return hints
}

function call(tool: string, args: object): string {
  const fields = Object.entries(args).map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
  return `${tool}({ ${fields.join(', ')} })`
}

/** Turn {@link FindHints} into up to three concrete follow-up calls. */
export function hintNextActions(query: FindQuery, hints: FindHints): string[] {
  const actions: string[] = []
  const similar = hints.similar_names?.[0]
  if (similar !== undefined) {
    const truncated = similar.name.length > MAX_NAME_CHARS
    actions.push(
      call('electron_find', {
        role: similar.role,
        ...(truncated
          ? { name_contains: similar.name.slice(0, MAX_NAME_CHARS) }
          : { name_exact: similar.name }),
      }),
    )
  }
  if (hints.without_state_filters !== undefined) {
    actions.push(call('electron_find', withoutKeys(query, hints.without_state_filters.filters)))
  }
  const otherRole = hints.other_roles?.[0]
  if (otherRole !== undefined)
    actions.push(call('electron_find', { ...query, role: otherRole.role }))
  const text = hints.text_matches?.samples.find((sample) => sample.selector !== null)
  if (text?.selector != null) actions.push(call('electron_get_text', { selector: text.selector }))
  return actions.slice(0, 3)
}
