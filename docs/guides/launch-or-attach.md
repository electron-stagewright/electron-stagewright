# Launch, attach, or inject

Three ways to get a session against an Electron app, depending on who starts the process and what
it exposes:

| Your situation                                        | Tool              | Transport           |
| ----------------------------------------------------- | ----------------- | ------------------- |
| Start a development entry (`main`)                    | `electron_launch` | Playwright Electron |
| Start a packaged executable (no `main`)               | `electron_launch` | Raw CDP             |
| The app is already running **with** a CDP debug port  | `electron_attach` | Raw CDP             |
| The app is already running **without** any debug flag | `electron_inject` | Node inspector      |

All three return `{ ok, session_id, transport, windows, capabilities }`; the `session_id` threads
through every later call.

## Launch — Stagewright owns the process

```json
electron_launch { "main": "/abs/path/to/app/main.js" }
```

- `main` points at the app's main-process entry and uses the Playwright Electron transport.
- An `executablePath` **without** `main` is a packaged-app launch. Stagewright reserves a loopback
  port, starts the binary with a managed Chromium remote-debugging endpoint, waits for a page target,
  connects over CDP, and owns the process through stop/force-kill.
- Passing both `main` and `executablePath` selects that Electron runtime for the development entry
  and stays on Playwright. Both paths must be absolute.
- `args`, `env`, and `cwd` shape the spawn. Environment variables that would alter the runtime
  (e.g. `NODE_OPTIONS`) are rejected with `BAD_ARGUMENT`.
- The call resolves when the first window exists AND the renderer finished its initial render
  (bounded by `readyTimeoutMs`, default 5000 ms) — so a snapshot right after launch sees content.

**Dev-server-backed apps** (Vite/webpack dev mode): the window appears before the bundle loads, so
raise `readyTimeoutMs`, or treat `renderer_ready: false` as "not yet" and wait for a known element:

```json
electron_wait_for_selector { "selector": "#app", "state": "visible", "timeoutMs": 30000 }
```

Failure modes worth knowing: `SINGLE_INSTANCE_LOCK` (another copy of the app holds Electron's
single-instance lock — close it first), `ALREADY_RUNNING` (one live session per server by default;
pass `allowMultiple: true` to run several), `LAUNCH_TIMEOUT` (no window within `timeoutMs`;
retryable), and `LAUNCH_FAILED` (the packaged app could not start or exited before a driveable
renderer appeared).
`FUSES_BLOCK_LAUNCH` applies only to a `main`-based Playwright launch whose selected runtime disables
Electron's Node CLI inspect fuse. For a shipped build, omit `main` and launch the executable over
CDP instead. Unknown or unreadable fuse state does not block a Playwright launch. When the server was started with
`--app-root <dir>`, launch paths outside that root are refused — useful when the operator wants to
confine what an agent can start.

### Launch a packaged app

```json
electron_launch {
  "executablePath": "/Applications/Your App.app/Contents/MacOS/Your App"
}
```

Stagewright owns `--remote-debugging-address` and `--remote-debugging-port` for this path; do not
pass either through `args`. The endpoint is loopback-only, each discovery probe is bounded, and a
failed handshake reaps the process before returning. Electron documents
[`--remote-debugging-port`](https://www.electronjs.org/docs/latest/api/command-line-switches#--remote-debugging-portport)
as the HTTP CDP endpoint switch.

Packaged launches default to `"credentialStore": "testing"`:

- macOS receives `--use-mock-keychain`, avoiding a Keychain prompt that can block startup;
- Linux receives `--password-store=basic` unless `args` already selects another password store;
- Windows receives no credential-store switch.

This default is for reliable automation, not security verification. A mock macOS keychain or
Linux basic store does **not** prove genuine OS-backed `safeStorage` sealing. Use
`"credentialStore": "system"` when that behavior is part of the assertion; the launch can then
surface an OS credential prompt and may require an already-unlocked test account. Chromium's own
[test launcher](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/test/base/test_launcher_utils.cc)
uses the same macOS/Linux defaults to prevent test UI and timeouts; Electron's
[`safeStorage` documentation](https://www.electronjs.org/docs/latest/api/safe-storage#platform-specific-key-providers)
describes the platform security difference and the Linux `basic_text` backend.

### Use the target project's Electron runtime

An app that loads native addons can require the Electron ABI it was built against. Start the server
with an operator-chosen app root, then ask the launch tool to use that project's Electron package:

```sh
electron-stagewright --app-root /absolute/path/to/your-app --tool-profile essential
```

```json
electron_launch {
  "main": "/absolute/path/to/your-app/dist/main.js",
  "runtime": "project"
}
```

`runtime: "project"` requires `main` and resolves Electron only below `--app-root`; it never accepts
a root from a tool call. The resolver reads Electron package metadata rather than evaluating the
target app or Electron package entry point, and rejects a package or binary that resolves outside the
configured root. An explicit `executablePath` is still authoritative, so do not set both unless you
deliberately want that explicit binary.

Run a non-mutating comparison before launch when native modules are involved:

```sh
electron-stagewright doctor --json --app-root /absolute/path/to/your-app
```

The `runtime.server` and `runtime.project` fields report the core, Playwright, Electron, Node, V8,
and `NODE_MODULE_VERSION` facts used for the comparison, plus a bounded inventory of potential native
addons. A project-runtime warning is diagnostic: it does not prevent launch, but it tells you to use
the app-local runtime or repair the project installation.

## Attach — the app is running with a debug endpoint

Start your app with a CDP port (during development, usually a script flag):

```sh
your-electron-app --remote-debugging-port=9222
```

Find it, then attach:

```json
electron_discover_running {}
electron_attach { "port": 9222 }
```

`electron_discover_running` scans the conventional loopback ports (9222–9225 by default) and
returns `{ targets: [{ targetId, port, appName, pid }], scanned }` — an empty result is
unambiguous because `scanned` reports exactly what was probed. Attach accepts `port` (+ optional
loopback `host`) or a full loopback `cdpUrl`. Two notes:

- A `pid` alone is **not** attachable over CDP — but passing it alongside `port` lets a later
  `electron_stop` escalate to SIGKILL if the app ignores the graceful close.
- The CDP transport supports snapshot/find against its selected root page, renderer evaluation,
  reads, observation (console/dialogs), screenshots, and the core interaction surface. Explicit
  iframe/webview/WebContentsView hierarchy discovery remains unavailable, so
  `electron_surfaces_list` reports `TRANSPORT_UNSUPPORTED` on CDP. Pointer and keyboard input are
  synthesised through the protocol, so there is no Playwright-style actionability auto-wait.

## Inject — the app is running with no debug flag

```json
electron_inject { "pid": 12345 }
```

Injection triggers the Node inspector inside the running main process and attaches to it — no
restart, no pre-arranged flag. The session it produces drives the **main process only**: main
evaluation (behind `--allow-eval=main` or bare `--allow-eval`), window listing, and main-process
console capture. Renderer reads and interaction need a CDP endpoint — when you control how the app
starts, prefer `--remote-debugging-port` + `electron_attach`.

The injected target is verified to belong to the pid you named (attaching to a different process
that happens to own the default inspector port is refused with `INJECT_FAILED`). On Windows the
inject trigger is unreliable on some Electron versions; the same discovery path still attaches if
the app was started with `--inspect`, and the error message says exactly that when the trigger
fails.

## Ending a session

| Call                  | What happens                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `electron_stop`       | Graceful close, bounded by `timeoutMs` (default 10 s); escalates to SIGKILL on timeout and reports `escalated: true`.                |
| `electron_force_kill` | Straight to SIGKILL.                                                                                                                 |
| `electron_detach`     | Releases an attached/injected session **without** touching the app. Launch-owned Playwright and packaged-CDP sessions reject detach. |

A stopped session's process is never orphaned: either the close landed, or the escalation reaped
it. For attached sessions, escalation needs the `pid` you optionally passed at attach time.

---

_Design background: the three-transport model and its capability matrix are ADR-003; target-runtime
selection is ADR-024; launch preflight, ready-wait, and stop escalation semantics follow the
agent-native principles in ADR-007. The model behind sessions, transports, and capabilities:
[Concepts](./concepts.md)._
