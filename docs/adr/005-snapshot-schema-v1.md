# ADR-005: Snapshot schema v1 + renderer-injected tool layer

- **Status**: Accepted
- **Date**: 2026-05-28
- **Deciders**: johnny4young
- **Note**: Public ADR. Committed artifacts may cite `ADR-005`; this file is the canonical design record.

## Context

Agents need a structured, low-token view of the renderer to decide what to do —
roles, names, state, bounding boxes, and stable handles (`ref`s) they can act on.
The pure snapshot module (walker, accname, fingerprint, diff, reconcile, find)
shipped earlier as framework-agnostic functions over a `Document`. What was
deferred was the **tool layer**: running that walker inside the Electron renderer
and threading per-session state so an agent can call `snapshot({ since: 'last' })`.

## Decision

1. **Schema (v1)** — `Snapshot` is `{ schemaVersion, entries[], meta }`. Each
   `SnapshotEntry` carries `ref` (number | null), role, name, state envelope,
   bbox, fingerprint, `interactive`, `recently_changed`. Refs are matched across
   snapshots by fingerprint (`reconcileRefs`) for stability. Everything is plain
   JSON (no `Map`/`Set`/`Date`) so it round-trips to the agent.

2. **Renderer injection by bundle, not hand-serialisation** — the walker plus its
   helpers are bundled (esbuild, IIFE) into `dist/snapshot/injected-walker.js`.
   The `electron_snapshot` / `electron_find` tools read that artifact and inject
   it via `session.evaluate('renderer', …)`, which installs
   `globalThis.__stagewrightWalk`. Serialising the walker with
   `Function.prototype.toString` was rejected: it drops the function's imported
   dependencies. The bundle keeps the walker the single source of truth.

3. **Ref resolution by `data-sw-ref` tagging** — during the renderer walk, each
   interactive element that receives a `ref` is tagged `data-sw-ref="<ref>"`
   (via the walker's `refAttribute` option). A later interaction tool resolves
   `ref: N` to the `[data-sw-ref="N"]` selector for real input. The tag is a
   renderer-only DOM mutation; it is re-applied each walk and gone after a reload.

4. **Stateful `since:'last'`** — a per-session `SnapshotStore` holds the last
   FULL (unfiltered) snapshot. `since:'last'` returns the delta (`diffSnapshots`
   - `recently_changed`); a detected reload (`detectRendererReload`) forces a full
     snapshot and sets `renderer_reloaded`. `interactiveOnly` / `maxEntries` filter
     only the RETURNED snapshot, never the stored baseline (so diffs stay accurate).

## Alternatives considered

| Alternative                                                 | Why rejected                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Hand-serialise the walker via `Function.prototype.toString` | Drops imported helpers; fragile and duplicative.                           |
| Ship `ref`s with no DOM resolution                          | Decorative — interaction could not act on a `ref`.                         |
| A separate `snapshot_diff` tool                             | ADR-007 P7: diff is a parameter (`since:'last'`), not a second tool.       |
| Store the filtered snapshot as the diff baseline            | Produces spurious added/removed entries when filters differ between calls. |

## Consequences

- The interaction and read tool families consume `ref`s via the
  `data-sw-ref` selector and the snapshot store.
- The build gains an esbuild renderer-bundle step; `esbuild` is a devDependency.
- The injected bundle runs in the page main world; eval-CSP considerations for
  renderer code are deferred to the eval-tools slice.

## Status Update — 2026-06-10

`snapshot({ since: 'last' })` now defaults to a COMPACT diff encoding at the
tool layer; the wire `Snapshot` shape and `schemaVersion: 1` are unchanged.

- The full encoding carried complete `prev`/`curr` entries per change, which
  blew MCP-client token caps on busy dialogs. The compact encoding keeps
  `added` entries complete (new UI), shrinks `removed` to identity
  (`fingerprint`/`ref`/`role`/`name`), and shrinks `changed` to identity plus
  ONLY the changed fields' previous/current values. `diffFormat: 'full'`
  restores the original shape.
- A `budgetTokens` argument adds server-side truncation that drops
  lowest-value entries first (non-interactive removed → changed → added,
  then interactive in the same order); the real delta counts in `_meta` are
  preserved and `truncated_entries` reports the omission.
- The closed-shadow-root opt-in gained a timing-independent registration
  array: apps push roots onto `window.__stagewright_closedShadowRoots` at
  `attachShadow` time (merged and deduplicated with the original
  `__stagewright_inspectShadow` callback; detached hosts are skipped).
