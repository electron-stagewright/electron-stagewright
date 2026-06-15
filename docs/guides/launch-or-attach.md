# Launch, attach, or inject

Three ways to get a session against an Electron app, depending on who starts the process and what
it exposes:

| Your situation                                        | Tool              | Transport           |
| ----------------------------------------------------- | ----------------- | ------------------- |
| Stagewright should start the app itself               | `electron_launch` | Playwright Electron |
| The app is already running **with** a CDP debug port  | `electron_attach` | Raw CDP             |
| The app is already running **without** any debug flag | `electron_inject` | Node inspector      |

All three return `{ ok, session_id, transport, windows }`; the `session_id` threads through every
later call.

## Launch — Stagewright owns the process

```json
electron_launch { "main": "/abs/path/to/app/main.js" }
```

- `main` points at the app's main-process entry (run with the bundled Electron), or pass
  `executablePath` for a packaged binary. Both must be absolute.
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
retryable). When the server was started with `--app-root <dir>`, launch paths outside that root
are refused — useful when the operator wants to confine what an agent can start.

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
- The CDP transport supports evaluation, reads, observation (console/dialogs), screenshots, and
  the core interaction surface — pointer and keyboard input are synthesised through the protocol,
  so a handful of behaviours differ from the launch transport (no auto-waiting actionability
  retry; an element that is not yet visible fails retryably instead of being awaited).

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

| Call                  | What happens                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `electron_stop`       | Graceful close, bounded by `timeoutMs` (default 10 s); escalates to SIGKILL on timeout and reports `escalated: true`. |
| `electron_force_kill` | Straight to SIGKILL.                                                                                                  |
| `electron_detach`     | Releases an attached/injected session **without** touching the app — it keeps running.                                |

A stopped session's process is never orphaned: either the close landed, or the escalation reaped
it. For attached sessions, escalation needs the `pid` you optionally passed at attach time.

---

_Design background: the three-transport model and its capability matrix are ADR-003; launch
preflight, ready-wait, and stop escalation semantics follow the agent-native principles in
ADR-007. The model behind sessions, transports, and capabilities: [Concepts](./concepts.md)._
