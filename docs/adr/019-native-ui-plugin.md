# ADR-019: Native UI plugin via a transport native-UI seam

Status: Accepted (application-menu read + invoke and notification capture on the Playwright transport; tray capture deferred)

## Context

An agent driving an Electron app can read and click the **web content**, but it is blind to the app's
**native chrome** — the application menu (the macOS menu bar: File / Edit / View / Window…), where a
large share of desktop-app behaviour lives. There is no way today to ask "is the _Save_ item enabled?",
"did _Dark Mode_ get checked under _View_?", or "does the _Edit_ menu have a _Paste_ item?" — that state
lives in the Electron **main process** (`Menu.getApplicationMenu()`), outside the DOM snapshot the agent
already reads.

The transport capability matrix has had no native-UI surface. This is the native-UI analog of the
network (ADR-016), clock (ADR-017), and storage (ADR-018) plugins: the same "a transport seam + a
capability gate + a plugin that drives it" shape. The application menu is the first surface because
Electron exposes it **globally** (`Menu.getApplicationMenu()` returns the live menu), unlike trays and
notifications, which have no registry and would need constructor-hook instrumentation.

## Decision

### 1. A dedicated native-UI read seam on the transport, gated by `canAccessNativeUI`

`TransportSession` gains a native-UI read seam — `getApplicationMenu(): Promise<NativeMenu | null>` —
plus the types `NativeMenu` and `NativeMenuItem`, gated by a new `TransportCapabilities.canAccessNativeUI`.

The **Playwright** transport (the default launch transport) implements it: `electronApp.evaluate(...)`
runs a **fixed, self-contained serializer** in the Electron main process over `Menu.getApplicationMenu()`,
walking the menu tree and returning only the data fields (`label`, `role`, `type`, `accelerator`,
`enabled`, `visible`, `checked`, nested `submenu`). It flips `canAccessNativeUI` `false → true`. `role`
is surfaced so role-based items (e.g. `quit`, `paste`, `reload`) that carry no explicit label until
rendered stay findable.

`@electron-stagewright/plugin-native-ui` drives that seam: `native_menu` (the full menu tree) and
`native_menu_item { path }` (resolve one item by a label/role path, e.g. `["View","Dark Mode"]`). The
plugin keeps the orchestration (the gate, the path walk, error envelopes) in TypeScript; the transport
owns the main-process read.

A seam — not eval — because the menu read runs a **fixed serializer the transport owns**, not
agent-supplied JavaScript; it is a bounded capability like the storage cookie read, so it should not
inherit the eval threat model or the `--allow-eval` opt-in.

### 2. Gated by `canAccessNativeUI`, NOT `--allow-eval` gated, a read-only non-secret surface

- **`canAccessNativeUI`** — the tools resolve the session and refuse a transport whose
  `canAccessNativeUI` is unset (`native.UNSUPPORTED`, naming the Playwright launch transport). Only the
  Playwright transport declares `true`.
- **NOT `--allow-eval` gated** — the read runs no agent JavaScript (a fixed main-process serializer), so
  it does not require the eval opt-in. Like the network, clock, and storage plugins, unlike the IPC
  plugin.
- **The original read slice is not a secret surface.** Reading the menu is observation of app chrome.
  Menu labels are no more sensitive than the DOM text the agent already reads via a snapshot, so there is
  no redaction concern. The status update below adds bounded menu invocation as a separate modify action.

## Rationale

- A native-UI seam, capability-flagged like the network/clock/storage seams, is the honest place this
  read lives, and it keeps the menu read out of the eval threat model (a bounded serializer, not
  arbitrary JS).
- The application menu is the highest-value, cleanest native surface to start with: globally readable,
  fully serialisable, and directly assertable ("is Save enabled?", "is Dark Mode checked?").
- Surfacing `role` (not only `label`) means role-based items — which on macOS often carry no explicit
  label — are not invisible to the agent.

## Alternatives considered

- **Reading the menu via `evaluate('main', …)` (the IPC-plugin pattern)** — rejected: that would put the
  menu read behind the `--allow-eval=main` opt-in and the eval threat model, for what is a bounded,
  fixed read. A capability-gated seam with a transport-owned serializer is the lighter, honest fit, and
  matches the other differentiation plugins.
- **Tray and notification capture in this slice** — deferred: trays and notifications have no global
  registry, so capturing them requires hooking the `Tray` / `Notification` constructors at launch
  (main-process instrumentation), a larger, eval-flavoured lift. The application-menu read stands alone
  and ships the headline value now; tray/notification capture is a clean follow-up.
- **Wiring the seam on CDP / injector** — not done: the application menu lives in the Electron
  main-process Node context. The CDP transport's `Runtime.evaluate` runs against the **browser target**,
  which has no Electron `Menu` module; the injector is a capability-honest stub. Advertising
  `canAccessNativeUI: true` on either would be the aspirational-capability trap ADR-003 warns against, so
  both stay honest-`false` and their seam method rejects `NOT_IMPLEMENTED`.

## Consequences

- New package `@electron-stagewright/plugin-native-ui` with the `native_menu` / `native_menu_item` tools
  and the namespaced `native.UNSUPPORTED` error code. Invalid args (an empty `path`) are core
  `BAD_ARGUMENT` (schema), not a plugin code.
- `TransportSession` gains one method every transport must satisfy: real on Playwright,
  `NOT_IMPLEMENTED` on CDP and injector (and the test fake returns a canned menu). `canAccessNativeUI`
  gains its first consumer (amends ADR-003): Playwright flips `false → true`; CDP and injector stay
  `false`. Like the clock seam, this is a Playwright-only capability for now.
- **JSON-serialisable payload.** The serializer reads only data fields — the menu items' `click`
  handlers and Electron-internal refs are never touched — so `NativeMenu` round-trips through
  `JSON.stringify` cleanly (the agent-payload invariant).
- **Honest capability.** `canAccessNativeUI: true` means the whole seam works on that transport; a
  transport that cannot reach the main process declares `false` rather than advertising a method that
  rejects at runtime.
- **Security model.** The security model gains a row for the native-UI read: capability-gated, not eval,
  a read of app chrome, not a secret surface.

## Related decisions

- ADR-003 (transport abstraction) — the `canAccessNativeUI` capability this consumes; amended with a
  Status Update for its first consumer.
- ADR-004 (plugin model) — the contract + in-process trust model this plugin is built on.
- ADR-006 (error code registry) — the namespaced `native.*` codes.
- ADR-016 (network plugin) / ADR-017 (clock plugin) / ADR-018 (storage plugin) — the sibling plugins
  whose transport-seam + capability-gate shape this mirrors.

## References

- `packages/core/src/transports/types.ts` — the seam method + `NativeMenu` / `NativeMenuItem`.
- `packages/core/src/transports/playwright-electron.ts` — the main-process menu serializer.
- `packages/plugin-native-ui/src/index.ts` — the tools, the capability gate, the path walk.
- `packages/plugin-native-ui/tests/` — simulated-seam integration + the gated real-Electron smoke.

## Status Update — 2026-06-19: menu invocation (read → read+act)

The native-UI seam, read-only at acceptance, gains a second method —
`TransportSession.invokeApplicationMenuItem(path)` — driven by a new `native_menu_invoke` tool, so an
agent can not only read the application menu but TRIGGER a menu action ("click File → Save") without
simulating a keyboard accelerator. The decision holds the seam's shape:

- **Same capability, same mechanism.** Invocation rides the same `canAccessNativeUI` (its doc broadens
  from "read" to "read and invoke") and the same `electronApp.evaluate` path. A self-contained
  main-process walker resolves the label/role path in the LIVE menu, refuses non-actionable items, and
  calls `MenuItem.click` with the focused window/webContents (falling back to the first app window when no
  window is focused) so Electron dispatches the app-provided handler with stable window context. CDP and
  injector reject it `NOT_IMPLEMENTED`, like the read.
- **NOT `--allow-eval` gated.** The agent supplies a path (data), not code; firing an app-defined menu
  handler is the native-UI analog of `electron_click` firing a DOM handler — a modify, but not eval. The
  security model gains a native-UI **modify** row alongside the read row.
- **Honest about its one limit.** Electron's built-in **role-based** items (`quit`, `reload`, …) are
  handled internally by Electron, so the plugin refuses them instead of pretending it invoked an
  app-owned handler. Rather than fake success, the result reports `{ invoked: false, reason }` with a
  precise reason — `not_found`, `disabled` (a greyed-out item is refused, never force-fired), `role`
  (press the accelerator instead), `submenu` (descend, don't invoke), `separator`, or `no_handler`. On
  success the resolved `label`/`role` are echoed so the agent confirms which item fired.

Menu invocation flips the native-UI surface from read-only to read+act. Tray capture and a broader
native-action surface remain deferred follow-ups.

## Status Update — 2026-06-19: notification capture (a native-event capture model)

The native-UI plugin gains a **capture** mechanism alongside the menu read/invoke seam:
`TransportSession` gains `startNotificationCapture(filter?)` / `capturedNotifications()` /
`stopNotificationCapture()` (plus the types `NativeNotification` / `NotificationCaptureFilter`), driven
by three `native_notifications_*` tools, so an agent can assert "the app showed a _Saved_ notification".
Unlike the menu's one-shot read, this is an arm → read → stop capture model (like the network and IPC
plugins): `native.ALREADY_CAPTURING` / `native.NOT_CAPTURING` gate the lifecycle.

- **The hook is a prototype patch, not a constructor swap.** The Playwright transport patches
  `Notification.prototype.show` in the main process via `electronApp.evaluate`. This is deliberate: every
  notification instance shares the prototype, so it catches every shown notification **regardless of how
  the app referenced the class** — it survives the common `const { Notification } = require('electron')`
  at import time, which a constructor swap (`electron.Notification = Wrapper`) would miss. It also records
  only **shown** notifications (`.show()`), which is the correct semantics for "did the app notify the
  user" — a constructed-but-unshown notification notified no one. The recorder reads only the instance's
  data fields (title/body/subtitle/silent/urgency), never handlers or refs, so `NativeNotification`
  round-trips through `JSON.stringify`. The buffer is bounded by a ring-buffer cap (the oldest entries
  are dropped past the cap), so a notification-spamming app cannot grow main-process memory without
  limit — mirroring the network capture.
- **NOT `--allow-eval` gated.** Although the hook is installed via `evaluate`, the agent supplies nothing
  executable — only arm (with an optional `titleContains` filter), read, and stop. The hook is fixed
  transport-owned code, and it **observes** user-facing notifications, a read surface lower-risk than the
  IPC plugin's arbitrary main-process interaction (which IS eval-gated). So capture rides the same
  `canAccessNativeUI` capability, not the eval opt-in, consistent with the menu read/invoke. The security
  model gains a native-event-capture row.
- **Limitation, documented.** Notifications shown before the capture is armed are not recorded (arm,
  then drive the app) — the same arm-then-observe contract as network capture.

Tray capture (the richer sibling — icon, tooltip, context menu, click events, same hook mechanism)
remains the deferred native-UI follow-up.
