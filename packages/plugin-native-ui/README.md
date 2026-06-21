# @electron-stagewright/plugin-native-ui

Read, assert, **invoke**, **capture**, and **inspect** an Electron app's **native chrome** — the
application menu (the macOS menu bar / app menu), the notifications it shows, and system-tray state —
under agent-driven testing (ADR-019, built on the ADR-004 plugin contract). Ask "is the _Save_ item
enabled?", "did _Dark Mode_ get checked under _View_?", then **trigger** the action ("click File → Save"),
**assert the app notified the user** ("a _Saved_ notification appeared"), and **read the tray tooltip /
menu** — state, actions, and events that live in the Electron **main process**, outside the DOM the agent
already reads — all **without running agent-supplied JavaScript**.

Like the network, clock, and storage plugins, the tools ride a dedicated **transport seam** (a fixed
main-process serializer/walker over `Menu.getApplicationMenu()`, a fixed `Notification.prototype.show`
hook, and the opt-in launch-time `Tray` hook from ADR-020), not eval — so they do **not** require
`--allow-eval`. They run on the default **Playwright** launch transport (the only transport with real
Electron main-process access); the CDP attach and injector transports return `native.UNSUPPORTED`.

The application menu is cross-platform (Electron's `Menu` API); the **macOS menu bar** is its most
prominent surface. Tray event capture is the deferred follow-up.

## Load it

```sh
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-native-ui
```

Programmatically:

```js
import { createServer } from '@electron-stagewright/core'
import nativeUiPlugin from '@electron-stagewright/plugin-native-ui'

const server = await createServer({ plugins: [nativeUiPlugin] })
```

No configuration.

## Tools

The loader namespaces each tool under the plugin name `native`:

- **`native_menu`** `{ sessionId? }` — return the application menu as a tree: each item's `label`, `role`,
  `type`, `accelerator`, and `enabled` / `visible` / `checked` state, with nested `submenu`s. The no-eval
  way to **assert** native-menu state. Returns `{ menu }` (`menu` is `null` when the app has none set).
- **`native_menu_item`** `{ path, sessionId? }` — resolve one item by its `path` — an array of labels or
  roles from the top of the menu, e.g. `["View","Appearance","Dark Mode"]` or `["Help","quit"]`. The
  direct way to ask "is Dark Mode checked?" without walking the tree. Returns `{ found, item? }` (`found`
  is `false` when the path doesn't resolve or the app has no menu). An empty `path` is `BAD_ARGUMENT`.
- **`native_menu_invoke`** `{ path, sessionId? }` — trigger an item by its `path`, firing the app's own
  menu handler — the deterministic way to run a menu action ("click File → Save") without simulating a
  keyboard accelerator. Returns `{ invoked, label?, role?, reason? }`: on success `invoked` is `true` and
  the resolved `label`/`role` are echoed; otherwise `invoked` is `false` and `reason` is `not_found`,
  `disabled` (a greyed-out item is refused), `role` (a built-in role item — press its accelerator
  instead), `submenu` (descend into it), `separator`, or `no_handler`. Read the item first with
  `native_menu_item` to confirm it is enabled and not a role/submenu item. An empty `path` is
  `BAD_ARGUMENT`.

Each path segment matches an item by its **label OR its role**, so role-based items (e.g. `quit`,
`paste`, `reload`) that carry no explicit label until rendered are still findable.

### Notification capture

- **`native_notifications_start`** `{ titleContains?, sessionId? }` — arm capture of the notifications
  the app shows (`new Notification(...).show()`), optionally narrowed to titles containing `titleContains`.
  Notifications shown **before** arming are not captured — arm, then drive the app. Returns `{ capturing }`.
- **`native_notifications`** `{ sessionId? }` — return the notifications shown since arming, oldest first
  — each with `title`, `body`/`subtitle`/`silent`/`urgency` (when set), and `at` (epoch ms). The no-eval
  way to **assert the app notified the user**. Returns `{ count, notifications }`.
- **`native_notifications_stop`** `{ sessionId? }` — disarm (restore the original `Notification.show`) and
  return what was captured. Returns `{ count, notifications }`.

### Tray read

- **`native_trays`** `{ sessionId? }` — return the app's system-tray icons — each with its `id`, `toolTip`,
  `title`, `hasImage` (whether an icon is set; the pixels are not returned), and `menu` (the context menu,
  serialised like the application menu). Trays have no registry and are created at startup, so the session
  **must** have been launched with `electron_launch { main, instrumentNative: true }` (which installs the
  tray hook before the app runs; executablePath-only launches cannot be instrumented). Returns
  `{ count, trays }`; `native.NOT_INSTRUMENTED` if the session was not instrumented (relaunch with the
  flag).

Error codes: `native.UNSUPPORTED` (the transport cannot access the native UI), `native.ALREADY_CAPTURING`
(a capture is already armed), `native.NOT_CAPTURING` (read/stop before arming), `native.NOT_INSTRUMENTED`
(`native_trays` without `instrumentNative`). Invalid arguments (an empty menu `path` or empty
`titleContains`) are core `BAD_ARGUMENT`.

## Security

Reading the application menu is **observation** of app chrome — not a secret surface: menu labels are no
more sensitive than the DOM text the agent already reads via a snapshot. The read runs a **fixed
serializer** in the main process (not agent-supplied JavaScript); the serializer touches only the data
fields, so the menu items' `click` handlers and Electron-internal refs are never read and the payload is
plain JSON.

Invoking a menu item (`native_menu_invoke`) **modifies** app behaviour — it fires the app's own menu
handler, the native-UI analog of `electron_click` firing a DOM handler. The agent supplies a path (data),
not code, so it is still **not** `--allow-eval` gated; it is bounded by the `canAccessNativeUI` capability
and the operator's choice to load the plugin. A disabled item is refused, and a built-in role item cannot
be invoked (press its accelerator).

Notification capture **observes** the notifications the app shows by patching `Notification.prototype.show`
in the main process and recording only the data fields (title/body/subtitle/silent/urgency — never
handlers or refs). Although the fixed hook is installed via `evaluate`, the agent supplies only
arm/read/stop (no executable input), so it is **not** `--allow-eval` gated — an observe surface bounded by
the capability and the operator-loaded plugin, no more sensitive than the notification text the user sees.

Tray read **observes** system-tray state by using launch-time native instrumentation (`electron_launch
{ main, instrumentNative: true }`) to install a fixed `Tray` hook before the app main runs. The agent
supplies only the opt-in flag, not code; the read returns tooltip/title, `hasImage`, and serialised context
menu state, never icon pixels.

## Scope and limitations

- **Application menu (read + invoke), notification capture, and tray read.** This plugin reads/invokes the
  application menu, captures shown notifications, and reads system-tray state. The tray read needs
  `electron_launch { instrumentNative: true }` (a launch-time hook — trays are created at startup with no
  registry). Tray _event_ capture (clicks) is the remaining deferred surface.
- **Notification capture is arm-then-observe.** Notifications shown before `native_notifications_start`
  are not recorded, and only **shown** notifications (`.show()`) are captured — a constructed-but-unshown
  notification notified no one. The hook patches the shared `Notification.prototype`, so it catches every
  shown notification regardless of how the app referenced the class.
- **Playwright launch transport only.** The application menu lives in the Electron main-process Node
  context; only the Playwright transport reaches it (`electronApp.evaluate`). A CDP attach session
  evaluates against the browser target, which has no Electron `Menu` module, so it returns
  `native.UNSUPPORTED`; the injector stub does too. Requires a transport whose `canAccessNativeUI`
  capability is set.
- **Cross-platform, macOS-leaning.** `Menu.getApplicationMenu()` works on every platform, but the menu
  bar is the macOS-native surface this plugin is named for; Windows/Linux apps that set an application
  menu read back the same way.
