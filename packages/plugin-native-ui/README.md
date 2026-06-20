# @electron-stagewright/plugin-native-ui

Read, assert, and **invoke** an Electron app's **native chrome** — the application menu (the macOS menu
bar / app menu) — under agent-driven testing (ADR-019, built on the ADR-004 plugin contract). Ask "is the
_Save_ item enabled?", "did _Dark Mode_ get checked under _View_?", or "does the _Edit_ menu have a
_Paste_ item?", then **trigger** the action ("click File → Save") — state and actions that live in the
Electron **main process**, outside the DOM the agent already reads — all **without running
agent-supplied JavaScript**.

Like the network, clock, and storage plugins, the tools ride a dedicated **transport seam** (a fixed
main-process serializer/walker over `Menu.getApplicationMenu()`), not eval — so they do **not** require
`--allow-eval`. They run on the default **Playwright** launch transport (the only transport with real
Electron main-process access); the CDP attach and injector transports return `native.UNSUPPORTED`.

The application menu is cross-platform (Electron's `Menu` API); the **macOS menu bar** is its most
prominent surface. Tray and notification capture are deferred follow-ups (they need constructor-hook
instrumentation, not this bounded menu seam).

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

Error codes: `native.UNSUPPORTED` (the transport cannot access the native UI). Invalid arguments (an
empty `path`) are core `BAD_ARGUMENT`.

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

## Scope and limitations

- **Application menu only (read + invoke).** This plugin reads and invokes the application menu. There is
  no tray or notification surface yet — those need main-process instrumentation (hooking the `Tray` /
  `Notification` constructors), a separate lift, and are deferred.
- **Playwright launch transport only.** The application menu lives in the Electron main-process Node
  context; only the Playwright transport reaches it (`electronApp.evaluate`). A CDP attach session
  evaluates against the browser target, which has no Electron `Menu` module, so it returns
  `native.UNSUPPORTED`; the injector stub does too. Requires a transport whose `canAccessNativeUI`
  capability is set.
- **Cross-platform, macOS-leaning.** `Menu.getApplicationMenu()` works on every platform, but the menu
  bar is the macOS-native surface this plugin is named for; Windows/Linux apps that set an application
  menu read back the same way.
