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
 * flag explicitly unset. Agents read `state.enabled === true`,
 * `state.disabled === true`, and `state.checked === false` confidently.
 */
export interface SnapshotState {
  /** `true` if visible (`display !== 'none'` and `visibility !== 'hidden'` and not inside `aria-hidden`). */
  readonly visible: boolean
  /** Convenience inverse of `disabled`, exposed so agents can ask for enabled controls directly. */
  readonly enabled: boolean
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
   * Renderer document start time in milliseconds. A different value across two
   * same-URL snapshots means the renderer reloaded without navigating.
   */
  readonly navigation_started_at_ms: number
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

/** The fields of an entry that a diff compares for change detection. */
export type ChangedField = 'state' | 'value' | 'bbox' | 'name'

/**
 * One entry that survived between two snapshots (matched by fingerprint) but
 * whose observable properties changed. The agent uses `changed_fields` to know
 * what kind of change happened without diffing the two entries itself.
 */
export interface SnapshotEntryChange {
  readonly fingerprint: string
  readonly prev: SnapshotEntry
  readonly curr: SnapshotEntry
  readonly changed_fields: readonly ChangedField[]
}

/**
 * Token-economy metadata attached to every diff encoding so the agent can
 * decide whether applying the diff is cheaper than re-reading the full
 * snapshot (ADR-007 Principle 2). The `entries_*` counts always describe the
 * REAL delta; `truncated_entries`, when present, says how many of those were
 * omitted from the payload by a server-side token budget.
 */
export interface SnapshotDiffMeta {
  readonly entries_added: number
  readonly entries_removed: number
  readonly entries_changed: number
  readonly estimated_tokens: number
  /** Entries dropped from the payload to honour a caller-supplied token budget. */
  readonly truncated_entries?: number
}

/**
 * The delta between two snapshots. `added` and `removed` are entries that
 * appeared / disappeared (by fingerprint); `changed` are entries present in
 * both whose state / value / bbox / name differ. `ref_map` maps a current
 * fingerprint to the ref it held in the previous snapshot, so orchestration can
 * reuse ref numbers. It is a plain object rather than a `Map` because snapshot
 * diffs are returned over JSON-based transports.
 */
export interface SnapshotDiff {
  readonly added: readonly SnapshotEntry[]
  readonly removed: readonly SnapshotEntry[]
  readonly changed: readonly SnapshotEntryChange[]
  readonly ref_map: Readonly<Record<string, number>>
  readonly _meta: SnapshotDiffMeta
}

/**
 * The subset of entry fields a diff can report as changed, keyed by
 * {@link ChangedField}. Used by the compact encoding to carry ONLY the values
 * that actually differ instead of two full entries.
 */
export type SnapshotEntryChangedValues = Partial<
  Pick<SnapshotEntry, 'state' | 'value' | 'bbox' | 'name'>
>

/**
 * Compact projection of one changed entry: identity (fingerprint + current ref
 * + role/name so the agent can recognise it) plus the changed fields' previous
 * and current VALUES only — not the two full entries the full encoding
 * carries. This is what keeps a busy-dialog diff inside an MCP client's token
 * cap (the dogfooded failure: full prev/curr per change blew a ~65k-char
 * response out of budget).
 */
export interface SnapshotEntryChangeCompact {
  readonly fingerprint: string
  /** The CURRENT ref (null for landmarks) so follow-up interaction can target it. */
  readonly ref: number | null
  readonly role: SnapshotRole
  readonly name: string
  readonly changed_fields: readonly ChangedField[]
  /** Previous values of exactly the changed fields. */
  readonly prev: SnapshotEntryChangedValues
  /** Current values of exactly the changed fields. */
  readonly curr: SnapshotEntryChangedValues
}

/**
 * Compact projection of a removed entry — identity only. The entry is gone, so
 * its full state/bbox payload has no actionable value to an agent.
 */
export interface SnapshotEntryRemovedCompact {
  readonly fingerprint: string
  /** The ref the entry held in the previous snapshot (null for landmarks). */
  readonly ref: number | null
  readonly role: SnapshotRole
  readonly name: string
}

/**
 * Compact diff encoding — the default for `snapshot({ since: 'last' })`.
 * `added` entries stay complete (they are new UI the agent has never seen);
 * `removed` and `changed` carry identity plus changed values only. The full
 * encoding remains available via the snapshot tool's `diffFormat: 'full'`.
 */
export interface SnapshotDiffCompact {
  readonly added: readonly SnapshotEntry[]
  readonly removed: readonly SnapshotEntryRemovedCompact[]
  readonly changed: readonly SnapshotEntryChangeCompact[]
  readonly ref_map: Readonly<Record<string, number>>
  readonly _meta: SnapshotDiffMeta
}

/**
 * Query accepted by `findEntries`. All provided fields must match (logical AND).
 * `name_contains` is a case-insensitive substring; `name_exact` is a
 * case-insensitive equality — supply one or the other, not both.
 */
export interface FindQuery {
  readonly role?: SnapshotRole
  readonly name_contains?: string
  readonly name_exact?: string
  readonly visible?: boolean
  readonly enabled?: boolean
  readonly interactive?: boolean
}

/**
 * Result of reconciling ref numbers between two snapshots. `snapshot` is the
 * current snapshot with interactive refs reassigned to reuse the previous
 * snapshot's numbers where fingerprints match. The counts let orchestration and
 * tests assert ref-stability behaviour without diffing by hand.
 */
export interface RefReconciliation {
  readonly snapshot: Snapshot
  readonly reused: number
  readonly fresh: number
  readonly dropped: number
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
        'enabled',
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
        enabled: { type: 'boolean' },
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
        'navigation_started_at_ms',
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
        navigation_started_at_ms: { type: 'number' },
        diff_baseline: { enum: ['full', 'diff'] },
        renderer_reloaded_since_last_snapshot: { type: 'boolean' },
      },
    },
  },
} as const

/** Static type of the JSON schema object used by docs/tests that inspect it. */
export type SnapshotJsonSchemaShape = typeof SnapshotJsonSchema
