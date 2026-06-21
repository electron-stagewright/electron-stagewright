# ADR-020: Launch-time native instrumentation

Status: Accepted (Playwright transport; opt-in; tray read + event invocation and startup-notification capture consumers, ADR-019)

## Context

Some native surfaces an agent wants to assert are set up **once at app startup** and have **no registry**
to read after the fact. The system `Tray` is the motivating case: Electron exposes no `Tray.getAll()`, a
tray's tooltip / title / context menu are configured in `app.whenReady()`, and the app holds the only
reference. The notification capture seam (ADR-019) works by patching `Notification.prototype.show` AFTER
launch — fine for events that fire over time, but a hook armed after launch would miss a tray that was
already created. To observe such t=0 native state, the instrumentation must be in place **before the
app's own main runs**.

There is no clean post-launch hook for this. The repo's security posture also refuses runtime-altering
env vars (`NODE_OPTIONS`), so a Node `--require` preload is not an option. The remaining path is to wrap
the app's main entry.

## Decision

### 1. An opt-in shim main, launched before the app's real main

`LaunchOptions` (and the `electron_launch` tool input) gains `instrumentNative?: boolean`, **default
off**. It requires `main`/`appPath`; an `executablePath`-only launch has no main entry for Stagewright to
wrap, so it is rejected. When set on the Playwright launch transport, the transport does not launch the
app's real main directly. Instead it writes a generated **shim main** (a `.cjs` in a per-launch temp dir)
and passes the shim as `args[0]`. The shim:

1. synchronously runs the fixed, transport-owned hooks against `require('electron')`: `TRAY_HOOK_BODY`
   (a constructor wrapper plus `setToolTip` / `setTitle` / `setImage` / `setContextMenu` prototype patches
   and `destroy` cleanup) into a registry on `globalThis.__stagewright_trayRegistry`, and
   `NOTIFICATION_HOOK_BODY` (a `Notification.prototype.show` patch recording every shown notification into a
   bounded ring buffer on `globalThis.__stagewright_notificationCapture`), then
2. `import()`s the app's real main — a **dynamic import** so a CommonJS _or_ an ESM main loads identically.

Because (1) runs before (2), the real main's `require('electron').Tray` resolves to the wrapped Tray class
even when the app destructures `const { Tray } = require('electron')` at import time (the prototype patches
also catch a pre-wrap reference), and every Notification instance shares the patched `.show()` prototype.
The notification hook lets the notification seam (ADR-019) catch startup (t=0) notifications an after-launch
arm would miss; it is idempotent so a later arm adopts it rather than double-patching. The shim temp dir is
removed when the session disposes (idempotent, best-effort).

### 2. Opt-in, runs no agent code, launch transport only

- **Opt-in per launch.** The operator passes `instrumentNative: true` deliberately; default off. Wrapping
  the app's main entry is invasive enough to warrant an explicit per-session choice rather than being
  implied by loading a plugin — and it confines the blast radius of the shim mechanism to sessions that
  asked for it.
- **No agent code.** The hook bodies (`TRAY_HOOK_BODY` and `NOTIFICATION_HOOK_BODY`) are fixed
  transport-owned source strings; the real-main path is the operator's own preflighted launch entry,
  JSON-escaped into a string literal and written to a file Electron runs — never `eval`/`new Function`.
  The agent supplies nothing executable. So this is NOT an `--allow-eval` surface; it is a launch-mechanism
  opt-in.
- **Launch transport only.** Only the Playwright launch path owns the app's entry. The CDP attach and
  injector transports cannot wrap a main that is already running, so consumers of the registry (`getTrays`
  and `invokeTrayEvent`) reject `NOT_IMPLEMENTED` there.

## Rationale

- A tray is only readable if the hook predates the app's `whenReady`; an opt-in shim main is the only path
  that does not require a refused `NODE_OPTIONS` preload or a packaged-app rebuild.
- A **prototype patch** for the setters (plus a best-effort constructor wrap) makes the hook robust to how
  the app references `Tray` — the same lesson the notification hook applied to `Notification.prototype.show`.
- Authoring the hook as a self-contained source STRING (no imports) means it has no dependencies to drop,
  so it does not need the renderer-walker's esbuild bundling — and the SAME string is unit-tested directly
  via `new Function` against a fake electron module, so the mechanism is covered without real Electron.

## Alternatives considered

- **A post-launch hook (the notification model)** — rejected for trays: a tray created at startup is
  already constructed before any arm, so a post-launch patch would never see it.
- **`NODE_OPTIONS=--require`** — rejected: the launch security posture refuses runtime-altering env vars,
  and it would apply process-wide rather than per-session.
- **Auto-instrument whenever the native-UI plugin is loaded** — rejected: it would wrap the main entry of
  every native-UI session (even ones that never read a tray), maximising the blast radius of the shim
  mechanism. The explicit per-launch flag is the more honest and safer opt-in.
- **An esbuild-bundled installer asset (like the renderer walker)** — not needed: the hook is small and
  self-contained, so a source string is simpler and avoids a CJS/ESM build asset + `createRequire`.

## Consequences

- `LaunchOptions.instrumentNative` + the `electron_launch` `instrumentNative` input; `TransportSession`
  gains `getTrays(): Promise<readonly NativeTray[] | null>` and
  `invokeTrayEvent(id, event): Promise<TrayInvokeResult | null>` — `null` distinctly signals a session
  launched WITHOUT instrumentation (the plugin maps it to `native.NOT_INSTRUMENTED`), `[]` means
  instrumented with no tray, and an invoke result reports whether the tray handler ran. `instrumentNative`
  requires a `main` entry; executablePath-only launches cannot be wrapped. CDP/injector reject
  `NOT_IMPLEMENTED`.
- New `packages/core/src/transports/native-instrumentation.ts` — `buildInstrumentationShim(realMain)` and
  the exported `TRAY_HOOK_BODY` / `TRAY_REGISTRY_GLOBAL` and `NOTIFICATION_HOOK_BODY` /
  `NOTIFICATION_REGISTRY_GLOBAL`. The shim writer + temp-dir cleanup live in the Playwright transport.
- **Caveat:** the real main loaded via the shim sees `process.argv[1]` pointing at the shim (its
  `__dirname` / `import.meta.url` resolve correctly because the dynamic import sets them). Apps that read
  `process.argv[1]` would observe the shim path; documented.
- **Security model** gains a row: the server wraps the app's main entry only on `instrumentNative` opt-in,
  runs a fixed hook (no agent code), and removes the shim on stop.
- This is the foundation tray read + event invocation AND startup-notification capture (ADR-019) build on;
  the same shim now installs both the tray and notification hooks at t=0.

## Related decisions

- ADR-003 (transport abstraction) — `LaunchOptions` gains `instrumentNative`.
- ADR-019 (native UI plugin) — the consumers (`getTrays` / `native_trays`, `invokeTrayEvent` /
  `native_tray_invoke`, and t=0 notification capture via the same shim), amended with Status Updates.
- ADR-014 (security posture) — the launch-surface threat model this opt-in extends.

## References

- `packages/core/src/transports/native-instrumentation.ts` — the shim builder + the tray and notification
  hook bodies.
- `packages/core/src/transports/playwright-electron.ts` — the shim writer, `getTrays`, `invokeTrayEvent`,
  the notification capture seam (adopt-or-install), temp cleanup.
- `packages/core/tests/native-instrumentation.test.ts` — the hook bodies run against a fake electron module.
