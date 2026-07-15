# Electron Stagewright

**Agent-native UX from line one. Drive Electron apps the way Playwright drives browsers — but designed for AI agents, not adapted for them.**

A Model Context Protocol (MCP) server that lets AI agents — Claude Code, Codex, Cursor, Cline, Aider, and any MCP-compatible host — operate real Electron desktop applications. The current core can launch Electron apps, inspect the renderer accessibility tree, click/type/select by stable refs or selectors, read state, wait on predicates, run opt-in eval, capture screenshots, read console logs, handle native dialogs, and assert expectations with retrying `expect_*` tools.

## Why this exists

Most MCP servers in the wild are Playwright APIs wrapped in an MCP transport. They work, but their UX is a human's API exposed to an agent — leaving the agent to do all the reasoning, comparisons, and recovery manually. Token budgets evaporate on round-trips that shouldn't need to exist.

Electron Stagewright is designed **agent-first from the primitive level up**:

- **Errors carry hints, suggested next actions, and similar-ref alternatives** — agents recover without an extra round-trip asking for context.
- **Every response reports its own token cost** — agents budget in real time, not after the fact.
- **`get_state` returns the full state envelope in one call** — visible, enabled, checked, focused, disabled, aria-expanded, aria-busy, aria-invalid. No 4-call chain to decide if a button is clickable.
- **`wait_for_state` accepts composite predicates** — `{ visible: true, enabled: true, focused: false }` evaluated atomically by the server. One call replaces three.
- **Snapshots flag `recently_changed` elements** — agents focus reasoning on what differs from the last view instead of reprocessing the whole tree.
- **Snapshot diffs are a parameter, not a separate tool** — `electron_snapshot({ since: 'last' })` returns only deltas. Fewer APIs to remember.
- **Compact text encoding on demand** — `electron_snapshot({ format: 'text' })` renders one line per element (`[3] textbox "Email" value="" focused`) with only non-default state, cutting snapshot tokens 5-10x versus the JSON shape when the agent just needs to look.
- **`expect_*` primitives replace read-compare-retry chains** — `electron_expect_text({ ref, equals: 'Welcome', timeoutMs: 5000 })` is one call, not five.
- **`electron_find` queries the accessibility tree semantically** — `{ role: 'button', name_contains: 'Submit', visible: true }` — no CSS selectors, no XPath, no guessing.
- **Hot-reload-aware** — snapshot and find responses report when the renderer reloaded since the previous baseline, so agents know refs may need refreshing.
- **Framework-agnostic snapshot** — built on accessibility roles and ARIA instead of framework-internal properties. Current fixtures cover vanilla, React, Vue, and Angular; the broader renderer matrix is still expanding.

## What competitors don't cover (yet)

The MCP ecosystem for browser automation is mature. The MCP ecosystem for **desktop Electron apps** is fragmented and still missing three structural capabilities this project treats as first-class:

1. **Attach to a running dev server without restarting it.** `electron_attach` connects to apps exposing a loopback CDP endpoint, and `electron_inject` can attach to a running main process via the Node Inspector handshake when no debug flag was arranged up front.
2. **Session traces with deterministic replay and per-tool token budgets.** Inspired by Playwright's `trace.zip` but designed for LLM agent sessions: a timeline of tool calls, arguments, results, timings, and token estimates — replayable against a fresh app instance, with budgets so agents can cap runaway loops.
3. **End-to-end validation of signed, notarized, packaged `.app` bundles** — `codesign`, Gatekeeper assessment, autoUpdater feed inspection, URL-scheme declaration checks, and crash reporter machinery. The full production surface, not just dev.

Microsoft's official Playwright MCP team [explicitly declined](https://github.com/microsoft/playwright-mcp/pull/1291) to support Electron ("you can release your own server for Electron" — Pavel Feldman, lead). This project takes the invitation seriously.

## Quick start

The default launch transport uses Playwright and an Electron runtime. For a private setup in the
current project, keep the server local to that project and pin the release-tested package set:

Before configuring an MCP host, run the same package set once in a terminal to prime a fresh `npx`
cache. Electron may print binary-download progress to stdout during this first install, which would
corrupt an MCP stdio session; the terminal bootstrap completes the install before the host starts it.

```bash
npx -y --package @electron-stagewright/core@0.4.1 --package playwright@1.61.1 \
  --package electron@42.3.0 electron-stagewright doctor --json
```

```bash
claude mcp add electron-stagewright -- \
  npx -y --package @electron-stagewright/core@0.4.1 --package playwright@1.61.1 \
  --package electron@42.3.0 electron-stagewright
```

The default Claude Code scope is local: it is available only in the current project and stays out
of unrelated workspaces. To share a reviewed configuration with a team, use `--scope project`,
which writes the same `mcpServers` shape to `.mcp.json`. See the
[Claude Code MCP scopes](https://code.claude.com/docs/en/mcp) for the host-specific behavior.

To verify a host before pointing it at your app, add the pinned
`@electron-stagewright/demo@0.1.0` package and use the [demo guide](docs/guides/demo.md). The demo
is opt-in, so a normal core installation neither loads nor depends on it.

For local development, build the checkout and point your MCP host at the built CLI:

```bash
pnpm install
pnpm build

claude mcp add electron-stagewright -- \
  node /abs/path/to/electron-stagewright/packages/core/dist/cli.js
```

Shared project `.mcp.json` shape:

```json
{
  "mcpServers": {
    "electron-stagewright": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "@electron-stagewright/core@0.4.1",
        "--package",
        "playwright@1.61.1",
        "--package",
        "electron@42.3.0",
        "electron-stagewright"
      ]
    }
  }
}
```

Then from any MCP-compatible agent:

```jsonc
// Launch
mcp__electron-stagewright__electron_launch({
  main: "/abs/path/to/.vite/build/main.js",
  env: { MY_ENV_VAR: "value" }
})

// Inspect with full state per ref
mcp__electron-stagewright__electron_snapshot()
// → [1] button "Open File"     enabled=true visible=true
//   [2] button "Settings"      enabled=true visible=true
//   [3] textbox "Email"        value="" focused=false
//   [4] heading "Welcome"

// Interact by ref
mcp__electron-stagewright__electron_click({ ref: 2 })

// Wait for a composite state in one call
mcp__electron-stagewright__electron_wait_for_state({
  ref: 3, state: { focused: true, enabled: true }, timeoutMs: 2000
})

// Assert + retry in one call instead of read-compare-retry chain
mcp__electron-stagewright__electron_expect_text({ ref: 4, equals: "Welcome back" })

// Stop
mcp__electron-stagewright__electron_stop()
```

The full tool list — every tool, its parameters, and operation type — is in
[TOOL-REFERENCE.md](TOOL-REFERENCE.md), generated from the live dispatcher manifest
(`pnpm docs:tools`).

## Documentation

- [Getting started](docs/guides/getting-started.md) — from a clean checkout to a complete driven
  session against the bundled example app.
- [Try the packaged demo](docs/guides/demo.md) — verify a published MCP host setup against a local,
  multi-window Electron task board without supplying your own app path.
- [Connect your MCP client](docs/guides/connect-your-mcp-client.md) — wire the published package
  into Claude Desktop, Cursor, or any MCP host, and confirm it connected.
- [Launch, attach, or inject](docs/guides/launch-or-attach.md) — getting a session against YOUR
  app, including apps that are already running.
- [Assert UI state](docs/guides/assert-ui-state.md) — refs vs selectors, the `expect_*` family,
  waits, and snapshot diffs.
- [Type into code editors](docs/guides/type-into-code-editors.md) — the reliable Monaco / EditContext
  typing path, `replace`, the auto-pairing caveat, and how to verify the text landed.
- [Capture diagnostics](docs/guides/capture-diagnostics.md) — screenshots, console, dialogs, and
  session traces.
- [Load, configure, and diagnose plugins](docs/guides/plugins.md) — explicitly load plugins, grant
  their narrowest gates, and inspect enabled tools and safe config with `electron_plugins`.
- [Migrate from electron-driver](docs/guides/migrate-from-electron-driver.md) — tool-by-tool
  mapping and the conceptual shifts.
- [Choose an Electron MCP server](docs/guides/choosing-an-electron-mcp-server.md) — compare
  Electron automation workflows by capability, trust boundary, recovery evidence, and your own app.
- [Concepts](docs/guides/concepts.md) — the agent-native model and why the server is shaped the way
  it is: the response envelope, refs, snapshots, retrying assertions, sessions, and the eval/plugin
  trust model, each linked to the decision that set it.
- [Security model](docs/guides/security-model.md) — the trust model, the controls behind
  `--allow-eval`, and a deployment checklist.
- [Guides index](docs/guides/README.md) · [TOOL-REFERENCE.md](TOOL-REFERENCE.md) ·
  [Architecture Decision Records](docs/adr/README.md).

## Server flags

Pass these after the CLI path in your MCP host config (the `args` array). All default to the safe
option; diagnostics go to stderr (stdout is reserved for the JSON-RPC protocol channel).

| Flag                            | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--allow-eval[=main\|renderer]` | Register the `electron_eval_main` / `electron_eval_renderer` tools, which run arbitrary JavaScript in the main / renderer process. Default off — the eval tools are hidden and uncallable. Bare `--allow-eval` enables both; `--allow-eval=renderer` (or `=main`) grants only that target for least privilege. Also gates plugin tools that call eval seams directly, such as IPC main-process tools (`main`) and storage per-key Web Storage / IndexedDB tools (`renderer`).                                                                           |
| `--app-root <dir>`              | Confine host paths to within `<dir>`: `electron_launch`'s `main`, `executablePath`, and `cwd`, plus the files read by `electron_set_files` / `electron_drop_file`. Default unset (no confinement). Set it to your app/project root so a tool call cannot launch a binary from elsewhere on the host, nor read a file outside the project into the app under test. It also enables `electron_launch({ main, runtime: "project" })`, which resolves Electron only from that operator-configured root; an explicit `executablePath` remains authoritative. |
| `--screenshot-dir <dir>`        | Default directory `electron_screenshot` writes into when the call gives no explicit path. Default: the OS temp dir.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--operation-timeout-ms <n>`    | Per-dispatch backstop timeout (ms); a handler that never settles resolves as a retryable `OPERATION_TIMEOUT` instead of hanging the agent on a frozen app. Default 120000; `0` disables it.                                                                                                                                                                                                                                                                                                                                                             |
| `--tool-profile <profile>`      | Select the core tool surface: `essential` (the focused launch/snapshot/interact/assert path), `testing` (broader test-driving tools), `debug` (attach/inspect/diagnostics), or `full`. Default: `full`, preserving the complete core catalog. Eval authorization and explicitly loaded plugins compose independently.                                                                                                                                                                                                                                   |
| `--demo`                        | Resolve an installed `@electron-stagewright/demo` package and use its Electron entry when `electron_launch` omits `main` and `executablePath`. It is opt-in and never becomes a normal core dependency. Install the pinned demo beside core when configuring a published `npx` or global setup. Cannot be combined with `--app-root`.                                                                                                                                                                                                                   |
| `doctor [--json]`               | Run preflight checks without starting the MCP server: Node, Playwright, Electron, Linux display, configured paths, eval policy, and (with `--app-root`) project runtime alignment. JSON mode includes server and target Electron/Node/V8/NODE_MODULE_VERSION facts plus a bounded potential-native-addon inventory; it exits non-zero only when a required check fails. Run it as `electron-stagewright doctor --json`, never as an MCP server argument.                                                                                                |
| `--plugin <name\|path>`         | Load a plugin by package name or file path. Repeatable; a single value may be comma-separated. e.g. `--plugin @electron-stagewright/plugin-trace`. After loading one, call `electron_plugins` to inspect enabled or disabled tools and their gate requirements.                                                                                                                                                                                                                                                                                         |
| `--plugin-config <name>=<json>` | Supply a plugin's config as inline JSON, validated against its schema. Keyed by plugin name; invalid input reports its Zod field path and correction input. `electron_plugins` returns only fields the plugin explicitly marks safe.                                                                                                                                                                                                                                                                                                                    |

Security defaults worth knowing when wiring this into another project: arbitrary JS (the
`--allow-eval` policy) and host-path launches (`--app-root`) are opt-in; `electron_launch` refuses
runtime-altering env vars (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`); and
user-supplied regex / text / key arguments are length- and complexity-bounded so a hostile tool call
cannot wedge the server.

Use `--tool-profile essential` when an agent needs the common launch, snapshot, interaction, wait,
and assertion workflow with a smaller initial manifest. Choose `testing` for the broader interaction
and read surface, or `debug` for attach, discovery, window, console, screenshot, and dialog work.
`full` stays the default until the profile benchmark demonstrates equivalent task success with a
material context saving. See [ADR-021](docs/adr/021-tool-profiles-and-manifest-budgets.md) for the
measured budget policy.

## What each response looks like (the agent-UX detail)

Success, for example from `electron_expect_text`:

```jsonc
{
  "ok": true,
  "session_id": "pw-...",
  "matched": true,
  "actual": "Welcome back",
  "_meta": {
    "estimated_tokens": 24,
    "elapsed_ms": 142,
    "session_id": "pw-...",
  },
}
```

Error:

```jsonc
{
  "ok": false,
  "error": "ref 7 not found in current snapshot",
  "code": "REF_NOT_FOUND",
  "hint": "The DOM may have rerendered since the last snapshot.",
  "next_actions": ["electron_snapshot()", "electron_find({ role: \"button\" })"],
  "similar_refs": [
    { "ref": 9, "role": "button", "name": "Submit" },
    { "ref": 12, "role": "button", "name": "Cancel" },
  ],
  "retryable": false,
  "http": 404,
  "_meta": { "estimated_tokens": 89, "elapsed_ms": 23 },
}
```

The agent has everything to decide its next move without asking for context.

## Architecture

Three transport implementations behind a single `ITransport` interface, so the project survives if Playwright's experimental `_electron` API changes or gets deprecated:

- **`PlaywrightElectronTransport`** — `_electron.launch()`, fast path (default).
- **`CDPTransport`** — Chrome DevTools Protocol direct, no Playwright dependency; attaches to apps exposing a loopback debug endpoint and supports eval, read, observe, and interaction surfaces.
- **`InjectorTransport`** — Node Inspector handshake into a running process; supports main-process eval, window discovery, and console capture when an app was not started with a CDP endpoint.

Plugin model: a small core, with domain capabilities shipped as separate `@electron-stagewright/plugin-*` packages loaded explicitly via `--plugin` (the core never auto-scans). Shipped today: **`plugin-a11y`** (surface-scoped axe-core audits with bounded violations and incomplete checks; a fixed engine, not agent JavaScript, so no `--allow-eval` grant), **`plugin-visual`** (BrowserWindow visual baselines with explicit update confirmation, environment metadata, confined artifact roots, and actual/diff evidence), **`plugin-trace`** (session trace + deterministic replay + per-tool token budget), **`plugin-ipc`** (capture / invoke / stub Electron IPC, gated behind main eval: `--allow-eval=main`, or bare `--allow-eval`), **`plugin-production`** (validate a packaged `.app`: bundle structure, Info.plist identity fields, URL schemes, updater feed, crash reporter machinery, code signing, notarization, Gatekeeper), **`plugin-network`** (renderer request/response capture, bodies, and stubbing via the transport seam), **`plugin-clock`** (deterministic renderer virtual time via the Playwright clock seam), **`plugin-storage`** (read, seed, and assert cookies plus storage snapshots through the no-eval transport seam, and per-key `localStorage` / `sessionStorage` plus IndexedDB records through a renderer-eval gate; cookie values are redacted by default, IndexedDB values can be redacted with config), and **`plugin-native-ui`** (read, assert, and invoke the application menu — the macOS menu bar — capture the notifications the app shows including startup ones, and read system-tray state plus fire tray events via launch-time instrumentation, all via the transport native-UI seam, no eval).

## Dogfooding targets

The MCP is built against two real Electron applications maintained by the author, covering distinct verticals so the design doesn't accidentally bias to one shape:

- **Code-editor shape** — a code editor with runtime sandboxes, licensing, and IPC-heavy state. Stresses keyboard-driven flows, editor state, and license verification.
- **POS shape** — a multi-tenant Point of Sale desktop app with embedded Fastify server and SQLite. Stresses forms, large tables, embedded backend, auto-updater feeds.

If your Electron app has a shape these don't cover, [open an issue](https://github.com/electron-stagewright/electron-stagewright/issues) — we'd love to add it as an example fixture.

## Security

The server is a **privileged local tool, not a sandbox**: it drives a real app and, under an eval opt-in (`--allow-eval` or a target-specific variant), runs arbitrary JavaScript inside it, so only a trusted agent host should invoke it. The [security model](docs/guides/security-model.md) covers the trust boundaries, the controls (eval opt-in + blocklist, channel allowlists, launch confinement, structured redaction), and a deployment checklist; the posture is recorded in [ADR-014](docs/adr/014-security-posture-and-threat-model.md). To report a vulnerability, see [SECURITY.md](.github/SECURITY.md).

## Contributing

This project is in its earliest days. Issues and discussions welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the workflow, and [GOVERNANCE.md](.github/GOVERNANCE.md) for how the project is run and the path to becoming a co-maintainer.

## License

MIT — see [LICENSE](LICENSE).
