# ADR-029: Renderer surface targeting on the CDP transport

- **Status**: Accepted
- **Date**: 2026-10-15
- **Deciders**: johnny4young

## Context

[ADR-022](./022-renderer-surface-targeting.md) defines the renderer-surface model: a flat,
parent-first list of opaque surface ids, explicit selection, and snapshot/ref state keyed by
`(sessionId, surfaceId)`. Only the Playwright launch path implemented it. Packaged-app launch and
`electron_attach` use the CDP transport, which could drive only its selected root page target, so an
agent driving a packaged app could not reach an iframe, a `<webview>` guest or a `WebContentsView`.

A probe against Electron 42.11.10 with the ADR-022 surface fixture, attached through
`--remote-debugging-port`, established these shapes:

- `/json/list` reports every `BrowserWindow` and `WebContentsView` as `type: "page"` with no
  ownership metadata, so CDP cannot tell the two apart.
- A `<webview>` guest is `type: "webview"` with `parentId` set to its host page target id. It has
  its own socket, frame tree and input widget.
- A cross-site iframe is an out-of-process frame (OOPIF): `type: "iframe"` with its own socket and
  `parentId` set to the id of the frame that contains it. A nested OOPIF names the outer OOPIF.
  `Target.getTargets` carries `parentFrameId` for iframes but no parent for webview guests.
- A same-site iframe is not a target. It appears only in its owner's `Page.getFrameTree`, and its
  main world is the `Runtime.executionContextCreated` context whose `auxData` has `isDefault: true`
  and its `frameId`. Electron's preload world is a separate, non-default context on the same frame.
- A target's id equals its root frame id, and frame ids are stable across navigation, so one frame
  id identifies a frame whether it is in-process or out-of-process.
- `Target.setAutoAttach` on a page attaches only its OOPIF children; webview guests appear only
  through browser-level auto-attach.
- `DOM.getFrameOwner` plus `DOM.getBoxModel` on the owner's target returns the frame's content box
  in that target's root viewport, already including in-process ancestors. Adding those boxes at each
  target boundary and dispatching `Input.dispatchMouseEvent` on the top page clicked a button two
  in-process frames deep and one inside an OOPIF nested in another OOPIF. A webview guest takes
  input on its own target. Key events on the top page reach an element focused inside a frame.

## Decision

### 1. Discover surfaces from `/json/list` and per-target frame trees

CDP keeps ADR-003's one-socket-per-target pool. A surface listing reads `/json/list` for `page`,
`webview` and `iframe` targets, opens or reuses each target's socket, and reads
`Page.getFrameTree` to add in-process child frames. Each node is keyed by its frame id and linked to
its parent through `/json/list` `parentId` (targets) or the frame tree (in-process frames). The list
is ordered parent-first from the page roots in discovery order; a node whose parent is missing or
part of a cycle is listed as a root instead of being given an invented parent.

Kinds are reported only as far as CDP can prove them: `page` targets are `other`, webview targets
are `webview`, and both OOPIF targets and in-process frames are `frame`. CDP never reports `window`
or `webcontents_view`. `originRelation` compares a frame's URL with its parent's, as on Playwright.

Flattened `Target.setAutoAttach` sessions were rejected: they need a session-multiplexing client in
place of the existing pool, page-level auto-attach does not expose webview guests, and `/json/list`
already carries the parent links for both target kinds.

### 2. Keep opaque ids and tombstones keyed by frame id

The transport maps each frame id to an opaque `<sessionId>-surface-<n>` id. The id survives
navigation and a frame moving between in-process and OOPIF hosting, because the frame id does. A
surface missing from a listing becomes a tombstone: selecting it reports `SURFACE_CLOSED`, an
unknown id reports `SURFACE_NOT_FOUND`, as ADR-022 requires. A frame id that reappears in a later
listing is the same frame and its record becomes live again.

### 3. Resolve the active surface to an eval socket, a context and an input root

Every renderer operation resolves the selected surface to:

- the **eval socket**: the target that hosts the frame (the frame's own target for page, webview
  and OOPIF surfaces, the owning target for an in-process frame);
- the **context**: none for a target's root frame; otherwise the frame's default main-world
  execution context, tracked from `Runtime` context events on that socket; and
- the **input root**: the nearest page or webview target above the surface, which receives every
  `Input.dispatch*` call.

Pointer coordinates are the element point inside the frame plus the owner content boxes summed from
the surface up to its input root. Dispatching through the input root keeps real hit-testing, so an
overlay that covers a frame still intercepts the click. Before a key press without a selector, a
non-root frame receives `window.focus()`, matching the Playwright transport.

Snapshot, find, renderer eval, reads, waits, expectations and selector/ref interactions use this
resolution. The snapshot store and the session ref lock are unchanged: refs are already keyed by
`(sessionId, surfaceId)` and every walk, reconcile, retag and ref-targeted action still runs under
the per-session lock, so switching surfaces cannot let a ref from one frame act in another.

### 4. Treat webview guests as window roots

`electron_windows_list` and `WindowRef` resolution include `webview` targets beside `page` targets,
matching the Playwright transport, which exposes guests through `ElectronApplication.windows()`.
Selecting a surface also selects its input root as the active window, so a window screenshot and an
element screenshot capture the guest that the element coordinates belong to. Console, dialog and
network capture attach to every window root, so they now include webview guest traffic. OOPIF
sockets are opened only to drive frames and do not join capture.

### 5. Declare support only with real evidence

`supportsSurfaceTargeting` becomes `true` for CDP. A real-Electron scenario launches the ADR-022
fixture through the CDP transport and proves discovery, parent-first order, origin relation, eval,
snapshot and click in in-process, OOPIF and webview surfaces, ref isolation between surfaces,
`SURFACE_CLOSED` after a frame detaches, and clean stop.

## Alternatives considered

| Alternative                                                     | Why rejected                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flattened `Target.setAutoAttach` sessions on the browser socket | Replaces the per-target pool with a multiplexed client for no added information; page-level auto-attach omits webview guests.                                                |
| `Page.createIsolatedWorld` per frame                            | Agent eval and the snapshot walker expect the page's main world; an isolated world cannot see application globals.                                                           |
| Dispatch input on each OOPIF's own target                       | It works with frame-relative points, but bypasses hit-testing in the embedding page, so a click could reach a frame an overlay covers. In-process frames still need offsets. |
| Guess `window` vs `webcontents_view` from bounds or titles      | CDP exposes no ownership metadata for page targets. ADR-022 requires `other` over a guess.                                                                                   |
| Use raw CDP target or frame ids as surface ids                  | ADR-022 requires transport-generated ids; keeping the mapping in the transport lets the frame id change hosting without the agent noticing.                                  |

## Consequences

- Packaged-app and attach sessions can list and select iframes, webview guests and
  `WebContentsView` roots with the same tools and errors as Playwright launch.
- CDP still cannot distinguish a `BrowserWindow` from a `WebContentsView`; both are `other` roots.
- Pointer coordinates assume untransformed iframes at page zoom 1. A CSS-transformed or zoomed
  frame can receive a misplaced click; element screenshots of a frame surface stay unsupported, as
  on Playwright.
- Each listing and each operation on a non-root surface costs one `Page.getFrameTree` per target it
  inspects, on sockets the session already pools.
- `electron_windows_list` on CDP may now return webview guests in addition to page targets.

## References

- [ADR-003](./003-transport-abstraction.md) — transport seam and the CDP connection pool.
- [ADR-005](./005-snapshot-schema-v1.md) — snapshot/ref invariants.
- [ADR-022](./022-renderer-surface-targeting.md) — the surface model this ADR implements on CDP.
- [Chrome DevTools Protocol: Target](https://chromedevtools.github.io/devtools-protocol/tot/Target/),
  [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/),
  [DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/) and
  [Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/).
