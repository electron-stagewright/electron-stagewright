/**
 * Snapshot schema v1 — the shape of every `snapshot()` response.
 *
 * Design contract:
 *
 * - **Framework-agnostic detection**: entries are classified by accessibility role
 *   + ARIA attributes + standard HTML semantics. No framework-internal property
 *   inspection.
 * - **Full state envelope**: every entry carries `state` with every relevant flag,
 *   always present with a default value (`null` for flags that do not apply to
 *   the entry's role). Predictability beats token cost — agents can read
 *   `entry.state.disabled === true` without defensive `?.` access.
 * - **Stable identity across snapshots**: every entry carries a fingerprint
 *   that snapshot orchestration can use for ref reuse.
 * - **Bounding boxes always present**: `bbox: { x, y, w, h }`. When layout is not
 *   yet available (initial render, jsdom test environment) the values are zero;
 *   the shape is stable across runtimes.
 * - **Schema versioned**: `schemaVersion: 1`. Breaking changes bump the major.
 *
 * This module defines the v1 wire shape plus JSON Schema. Diff-aware fields are
 * present from v1 and remain at their defaults until snapshot orchestration
 * has a previous baseline to compare against.
 *
 * @module
 */

/**
 * Top-level snapshot returned by the `snapshot()` tool. Versioned so future
 * breaking changes bump the major and the dispatcher can refuse unknown
 * versions instead of silently misinterpreting them.
 */
export interface Snapshot {
  /** Semver major of the snapshot wire format. The current version is `1`. */
  readonly schemaVersion: 1
  /** Flat list of interactive entries plus structural landmarks (no nested tree in v1). */
  readonly entries: readonly SnapshotEntry[]
  /** Per-snapshot metadata. */
  readonly meta: SnapshotMeta
}

/**
 * Each entry in the snapshot. Refs are unique within a single snapshot;
 * fingerprints persist across snapshots so orchestration can keep ref numbers
 * stable across DOM mutations.
 */
export interface SnapshotEntry {
  /**
   * Stable numeric reference within this snapshot. Refs start at 1; `ref: 0` is
   * reserved for "the document itself" sentinel and is not emitted today.
   *
   * Landmarks (`<main>`, `<nav>`, etc.) that are NOT interactive on their own
   * get `ref: null` — they exist in the entries list to give the agent
   * structural context but cannot be passed to `click({ ref })`.
   */
  readonly ref: number | null
  /** HTML tag name in lowercase (`'button'`, `'input'`, `'div'`, etc.). */
  readonly tag: string
  /** Accessibility role — `'button'`, `'link'`, `'textbox'`, `'main'`, etc. */
  readonly role: SnapshotRole
  /** Computed accessible name (W3C accname-1.2). Empty string when no name is computable. */
  readonly name: string
  /**
   * Optional accessibility description from `aria-describedby` or `title`.
   * Empty string when none.
   */
  readonly description: string
  /**
   * Whether this entry is interactive (clickable / focusable / typeable). False
   * for landmarks. Disabled buttons remain interactive: true with state.disabled: true
   * so agents can SEE them and choose not to click rather than thinking they
   * are absent.
   */
  readonly interactive: boolean
  /** Full state envelope — every flag is always present with a default. */
  readonly state: SnapshotState
  /** Bounding box in CSS pixels. Zero values in jsdom test environment. */
  readonly bbox: SnapshotBbox
  /**
   * Fingerprint hash (`FNV-1a` of `role + name + last-3-ancestor-roles`) used
   * for ref-stability across snapshots. Always present even when unused.
   */
  readonly fingerprint: string
  /**
   * Set to true when this entry's state, text, or position changed since the
   * previous snapshot but fingerprint matched. Full snapshots leave this false.
   */
  readonly recently_changed: boolean
  /** Optional value for inputs / textareas — empty string when not applicable. */
  readonly value: string
  /** Optional placeholder text for empty inputs — empty string when not applicable. */
  readonly placeholder: string
}

/**
 * Accessibility roles emitted by the walker. Mix of standard ARIA roles and the
 * HTML implicit-role mapping. The list is intentionally broad enough to cover
 * common Electron-app UI patterns; future roles are additive (no removal
 * without a schema bump).
 */
export type SnapshotRole =
  // Interactive form controls
  | 'button'
  | 'link'
  | 'checkbox'
  | 'radio'
  | 'textbox'
  | 'searchbox'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'switch'
  | 'slider'
  | 'spinbutton'
  | 'menuitem'
  | 'menuitemcheckbox'
  | 'menuitemradio'
  | 'tab'
  | 'treeitem'
  // Container interactives
  | 'menu'
  | 'menubar'
  | 'tablist'
  | 'tree'
  | 'dialog'
  | 'alertdialog'
  // Structural / landmark
  | 'main'
  | 'navigation'
  | 'banner'
  | 'contentinfo'
  | 'complementary'
  | 'region'
  | 'search'
  | 'form'
  | 'heading'
  | 'article'
  // Content
  | 'text'
  | 'image'
  | 'separator'
  | 'progressbar'
  | 'status'
  | 'alert'
  // Unclassified — emitted for elements that have explicit role attributes the
  // walker does not recognise as a typed role. Agents see the role string but
  // should treat it as opaque.
  | 'unknown'

/**
 * Every state flag the walker tracks. All flags are always present in the
 * entry's state object. Flags that do not apply to the entry's role are `null`
 * (e.g. `checked` on a button is null; `expanded` on a non-disclosable element
 * is null).
 *
 * Tri-state semantics: `null` = not applicable, `true` = flag set, `false` =
 * flag explicitly unset. Agents read `state.disabled === true` and
 * `state.checked === false` confidently.
 */
export interface SnapshotState {
  /** `true` if visible (`display !== 'none'` and `visibility !== 'hidden'` and not inside `aria-hidden`). */
  readonly visible: boolean
  /** `true` if the element is `:disabled` or has `aria-disabled="true"` or is inside a disabled fieldset. */
  readonly disabled: boolean
  /** Checked state for checkboxes / radios. `null` if role does not have a checked state. */
  readonly checked: boolean | null
  /** Selected state for options / tabs / treeitems. `null` if role does not have a selected state. */
  readonly selected: boolean | null
  /** Expanded state for collapsibles / comboboxes / menus. `null` if role does not have an expanded state. */
  readonly expanded: boolean | null
  /** Pressed state for toggle buttons. `null` if role does not have a pressed state. */
  readonly pressed: boolean | null
  /** Whether the element currently has focus. */
  readonly focused: boolean
  /** Read-only state. `null` if role does not have a readonly state. */
  readonly readonly: boolean | null
  /** Required-field state. `null` if role does not have a required state. */
  readonly required: boolean | null
  /** Validity state (e.g. `aria-invalid`). `null` if role does not have a validity state. */
  readonly invalid: boolean | null
  /** Busy state (e.g. `aria-busy`). */
  readonly busy: boolean
  /** Whether the entry sits inside a closed shadow root (opaque to the walker). */
  readonly shadow_closed: boolean
}

/** Bounding box in CSS pixels. Zero values in jsdom (no layout); real values in Chromium. */
export interface SnapshotBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** Per-snapshot metadata. */
export interface SnapshotMeta {
  /** Viewport size in CSS pixels. */
  readonly viewport: { readonly width: number; readonly height: number }
  /**
   * URL of the renderer at snapshot time. Useful for hot-reload detection in
   * diff-aware orchestration; the pure walker only captures it.
   */
  readonly url: string
  /**
   * Page title at snapshot time. Same use case as `url`.
   */
  readonly title: string
  /**
   * Whether the snapshot is a delta (since the previous snapshot) or a full
   * walk. The pure walker emits `'full'` unless the caller supplies `'diff'`.
   */
  readonly diff_baseline: 'full' | 'diff'
  /**
   * Set to true when the renderer reloaded between this snapshot and the
   * previous one, so the agent knows refMap from before is stale. The pure
   * walker emits `false`.
   */
  readonly renderer_reloaded_since_last_snapshot: boolean
}

/**
 * JSON Schema (Draft-07) representation of the Snapshot type, exported so
 * downstream tools (validation, doc generators, schema diff tooling) can
 * consume it without importing TypeScript. Kept in sync with the TS types by
 * the `snapshot.test.ts` table-driven cross-check.
 */
export const SnapshotJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://electron-stagewright.dev/schemas/snapshot-v1.json',
  title: 'Snapshot',
  type: 'object',
  required: ['schemaVersion', 'entries', 'meta'],
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    entries: {
      type: 'array',
      items: { $ref: '#/$defs/SnapshotEntry' },
    },
    meta: { $ref: '#/$defs/SnapshotMeta' },
  },
  $defs: {
    SnapshotEntry: {
      type: 'object',
      required: [
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
      ],
      additionalProperties: false,
      properties: {
        ref: { type: ['integer', 'null'], minimum: 1 },
        tag: { type: 'string' },
        role: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        interactive: { type: 'boolean' },
        state: { $ref: '#/$defs/SnapshotState' },
        bbox: { $ref: '#/$defs/SnapshotBbox' },
        fingerprint: { type: 'string' },
        recently_changed: { type: 'boolean' },
        value: { type: 'string' },
        placeholder: { type: 'string' },
      },
    },
    SnapshotState: {
      type: 'object',
      required: [
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
      ],
      additionalProperties: false,
      properties: {
        visible: { type: 'boolean' },
        disabled: { type: 'boolean' },
        checked: { type: ['boolean', 'null'] },
        selected: { type: ['boolean', 'null'] },
        expanded: { type: ['boolean', 'null'] },
        pressed: { type: ['boolean', 'null'] },
        focused: { type: 'boolean' },
        readonly: { type: ['boolean', 'null'] },
        required: { type: ['boolean', 'null'] },
        invalid: { type: ['boolean', 'null'] },
        busy: { type: 'boolean' },
        shadow_closed: { type: 'boolean' },
      },
    },
    SnapshotBbox: {
      type: 'object',
      required: ['x', 'y', 'w', 'h'],
      additionalProperties: false,
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
    },
    SnapshotMeta: {
      type: 'object',
      required: [
        'viewport',
        'url',
        'title',
        'diff_baseline',
        'renderer_reloaded_since_last_snapshot',
      ],
      additionalProperties: false,
      properties: {
        viewport: {
          type: 'object',
          required: ['width', 'height'],
          additionalProperties: false,
          properties: {
            width: { type: 'number' },
            height: { type: 'number' },
          },
        },
        url: { type: 'string' },
        title: { type: 'string' },
        diff_baseline: { enum: ['full', 'diff'] },
        renderer_reloaded_since_last_snapshot: { type: 'boolean' },
      },
    },
  },
} as const

export type SnapshotJsonSchemaShape = typeof SnapshotJsonSchema
