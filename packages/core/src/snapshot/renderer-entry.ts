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
import { WALK_GENERATION_GLOBAL, queryTarget } from './resolve-target.js'
import { resolveRole } from './roles.js'
import type { SnapshotBbox, SnapshotRole, SnapshotState } from './schema.js'
import { extractState } from './state.js'
import {
  MAX_SHADOW_DEPTH,
  type ScopedSnapshot,
  type WalkerOptions,
  walkAccessibilityTree,
} from './walker.js'

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
  /** Whether typed text would land here: a text input, textarea or contenteditable that accepts it. */
  readonly editable: boolean
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

/** Argument to `__stagewrightWalk`; `scope` is a selector resolved like a probe target. */
export interface WalkArg extends Pick<WalkerOptions, 'diffBaseline'> {
  readonly scope?: string
}

/** Returned instead of a walk when `scope` is malformed or matches nothing; no tags change. */
export interface WalkScopeMiss {
  readonly scope_miss: true
  readonly invalid_selector?: true
  readonly error?: string
}

/** The globals the injected bundle installs for the snapshot / read tools to call. */
export interface StagewrightWalkGlobal {
  __stagewrightWalk?: (options?: WalkArg) => ScopedSnapshot | WalkScopeMiss
  __stagewrightProbe?: (arg?: ProbeArg) => ProbeElementResult | ProbeListResult | ProbeMiss
}

const target = globalThis as typeof globalThis & StagewrightWalkGlobal
const generations = globalThis as unknown as Record<string, number | undefined>

/** Walk `document`, tagging refs; a `scope` selector is resolved first and reported on. */
export function walkForSnapshot(
  document: Document,
  arg: WalkArg = {},
): ScopedSnapshot | WalkScopeMiss {
  const { scope, ...options } = arg
  if (typeof scope !== 'string') {
    return walkAccessibilityTree(document, { ...options, refAttribute: REF_ATTRIBUTE })
  }
  // Resolve before walking: the walk clears and rewrites the ref tags a ref scope names.
  let scopeRoot: Element | null
  try {
    scopeRoot = queryTarget(document, scope, MAX_SHADOW_DEPTH)
  } catch (err) {
    return {
      scope_miss: true,
      invalid_selector: true,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  if (scopeRoot === null) return { scope_miss: true }
  return walkAccessibilityTree(document, { ...options, refAttribute: REF_ATTRIBUTE, scopeRoot })
}

target.__stagewrightWalk = (arg?: WalkArg): ScopedSnapshot | WalkScopeMiss => {
  generations[WALK_GENERATION_GLOBAL] = (generations[WALK_GENERATION_GLOBAL] ?? 0) + 1
  return walkForSnapshot(document, arg)
}

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

/** Input types that do not take typed text. */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/** Whether typed text would land in `element`. */
function probeEditable(element: Element): boolean {
  const control = element as Element & { disabled?: unknown; readOnly?: unknown }
  const tag = element.tagName.toLowerCase()
  if (tag === 'textarea' || tag === 'input') {
    // `:disabled` also covers a control inside a disabled <fieldset>.
    if (control.disabled === true || control.readOnly === true || element.matches(':disabled')) {
      return false
    }
    if (tag === 'textarea') return true
    return !NON_TEXT_INPUT_TYPES.has((element.getAttribute('type') ?? 'text').toLowerCase())
  }
  const host = element.closest('[contenteditable]')
  return host !== null && host.getAttribute('contenteditable') !== 'false'
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
    editable: probeEditable(element),
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
    const outer = document.activeElement
    if (outer === null || outer === document.body) return { found: false }
    // Focus inside an open shadow root leaves the document pointing at the host.
    let active: Element = outer
    for (let depth = 0; depth < MAX_SHADOW_DEPTH; depth++) {
      const inner: Element | null = active.shadowRoot?.activeElement ?? null
      if (inner === null) break
      active = inner
    }
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
    element = queryTarget(document, String(arg.selector), MAX_SHADOW_DEPTH)
  } catch (err) {
    return invalidSelectorMiss(err)
  }
  if (element === null) return { found: false }
  return probeElement(element)
}
