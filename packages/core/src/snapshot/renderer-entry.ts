/**
 * Renderer-injected entry point for the snapshot walker and the single-element
 * read probe.
 *
 * This module is NOT imported by the server at runtime. It is bundled into a
 * single self-contained IIFE (`dist/snapshot/injected-walker.js`, built by
 * `scripts/build-renderer-bundle.mjs` with esbuild) and that bundle string is
 * injected into the Electron renderer by the snapshot / read tools via
 * `session.evaluate('renderer', …)`. The renderer cannot resolve ESM imports, so
 * the walker plus its helpers must be bundled — hand-serialising the functions
 * with `Function.prototype.toString` would drop their dependencies.
 *
 * On injection it exposes two globals:
 *
 * - `globalThis.__stagewrightWalk(options)` — runs the shared accessibility
 *   walker against the live `document` and tags each interactive element with
 *   `data-sw-ref="<ref>"`.
 * - `globalThis.__stagewrightProbe(arg)` — reads ONE element (or the focused
 *   element, or a selector's matches) reusing the same role / accname / state
 *   machinery as the walker, so `electron_get_state` and friends report state
 *   identically to a snapshot without re-walking the whole tree.
 *
 * @module
 */

import { computeAccessibleName } from './accname.js'
import { resolveRole } from './roles.js'
import type { Snapshot, SnapshotBbox, SnapshotRole, SnapshotState } from './schema.js'
import { extractState } from './state.js'
import { type WalkerOptions, walkAccessibilityTree } from './walker.js'

/** Attribute each interactive element is tagged with, keyed to its ref number. */
export const REF_ATTRIBUTE = 'data-sw-ref'

/** The full single-element read returned by `__stagewrightProbe` in `element`/`focused` mode. */
export interface ProbeElementResult {
  readonly found: true
  /** The element's `data-sw-ref` number, or `null` when it was never tagged. */
  readonly ref: number | null
  readonly role: SnapshotRole
  readonly name: string
  /** Trimmed `textContent`. */
  readonly text: string
  /** `.value` for form controls; `null` otherwise. */
  readonly value: string | null
  readonly bbox: SnapshotBbox
  readonly state: SnapshotState
}

/** One entry in `__stagewrightProbe` `list` mode. */
export interface ProbeListEntry {
  readonly ref: number | null
  readonly role: SnapshotRole
  readonly name: string
  readonly bbox: SnapshotBbox
}

/** The `list`-mode result: matches (capped at `limit`) plus the true total and drop count. */
export interface ProbeListResult {
  readonly found: true
  readonly matches: readonly ProbeListEntry[]
  readonly count: number
  readonly truncated: number
}

/** Returned when the selector / focus target resolved to no element. */
export interface ProbeMiss {
  readonly found: false
  /** True when the renderer rejected a malformed CSS selector. */
  readonly invalid_selector?: boolean
  /** Renderer-provided selector error, kept short by the caller-facing envelope. */
  readonly error?: string
}

/** Discriminated argument to `__stagewrightProbe`. */
export interface ProbeArg {
  /** `element` (default): one element by `selector`. `focused`: the active element. `list`: all matches. */
  readonly mode?: 'element' | 'focused' | 'list'
  readonly selector?: string
  /** Max matches in `list` mode. Defaults to 50. */
  readonly limit?: number
}

/** The globals the injected bundle installs for the snapshot / read tools to call. */
export interface StagewrightWalkGlobal {
  __stagewrightWalk?: (options?: WalkerOptions) => Snapshot
  __stagewrightProbe?: (arg?: ProbeArg) => ProbeElementResult | ProbeListResult | ProbeMiss
}

const target = globalThis as typeof globalThis & StagewrightWalkGlobal

target.__stagewrightWalk = (options: WalkerOptions = {}): Snapshot =>
  walkAccessibilityTree(document, { ...options, refAttribute: REF_ATTRIBUTE })

/** Bounding box matching the walker's `computeBbox` (zeros in a layout-less runtime). */
function probeBbox(element: Element): SnapshotBbox {
  if (typeof element.getBoundingClientRect !== 'function') return { x: 0, y: 0, w: 0, h: 0 }
  try {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
  } catch {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
}

/** Read `.value` of a form control; `null` when the element has no value semantics. */
function probeValue(element: Element): string | null {
  const tag = element.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const value = (element as unknown as { value?: unknown }).value
    if (typeof value === 'string') return value
  }
  return null
}

/** Parse the `data-sw-ref` tag into a number, or `null` when untagged / malformed. */
function probeRef(element: Element): number | null {
  const attr = element.getAttribute(REF_ATTRIBUTE)
  if (attr === null || !/^\d+$/.test(attr)) return null
  return Number(attr)
}

/** Enrich one element with the same role / name / state the walker would compute. */
function probeElement(element: Element): ProbeElementResult {
  const role = resolveRole(element)
  return {
    found: true,
    ref: probeRef(element),
    role,
    name: computeAccessibleName(element),
    text: (element.textContent ?? '').trim(),
    value: probeValue(element),
    bbox: probeBbox(element),
    state: extractState(element, role),
  }
}

/** Mark a selector syntax failure distinctly from a valid selector that matched nothing. */
function invalidSelectorMiss(err: unknown): ProbeMiss {
  return {
    found: false,
    invalid_selector: true,
    error: err instanceof Error ? err.message : String(err),
  }
}

target.__stagewrightProbe = (
  arg: ProbeArg = {},
): ProbeElementResult | ProbeListResult | ProbeMiss => {
  const mode = arg.mode ?? 'element'

  if (mode === 'focused') {
    const active = document.activeElement
    if (active === null || active === document.body) return { found: false }
    return probeElement(active)
  }

  if (mode === 'list') {
    if (typeof arg.selector !== 'string') return { found: false }
    const limit = typeof arg.limit === 'number' && arg.limit >= 0 ? arg.limit : 50
    let all: Element[]
    try {
      all = Array.from(document.querySelectorAll(arg.selector))
    } catch (err) {
      return invalidSelectorMiss(err)
    }
    const matches = all.slice(0, limit).map((element): ProbeListEntry => {
      const { ref, role, name, bbox } = probeElement(element)
      return { ref, role, name, bbox }
    })
    return {
      found: true,
      matches,
      count: all.length,
      truncated: Math.max(0, all.length - matches.length),
    }
  }

  let element: Element | null
  try {
    element = document.querySelector(String(arg.selector))
  } catch (err) {
    return invalidSelectorMiss(err)
  }
  if (element === null) return { found: false }
  return probeElement(element)
}
