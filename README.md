# Electron Stagewright

**Agent-native UX from line one. Drive Electron apps the way Playwright drives browsers — but designed for AI agents, not adapted for them.**

A Model Context Protocol (MCP) server that lets AI agents — Claude Code, Codex, Cursor, Cline, Aider, and any MCP-compatible host — operate real Electron desktop applications. The current core can launch Electron apps, inspect the renderer accessibility tree, click/type/select by stable refs or selectors, read state, wait on predicates, run opt-in eval, capture screenshots, read console logs, handle native dialogs, and assert expectations with retrying `expect_*` tools.

> Status: pre-alpha. Core server implementation is active; plugin packages and the first npm release are still ahead. Star the repo to follow releases.

## Why this exists

Most MCP servers in the wild are Playwright APIs wrapped in an MCP transport. They work, but their UX is a human's API exposed to an agent — leaving the agent to do all the reasoning, comparisons, and recovery manually. Token budgets evaporate on round-trips that shouldn't need to exist.

Electron Stagewright is designed **agent-first from the primitive level up**:

- **Errors carry hints, suggested next actions, and similar-ref alternatives** — agents recover without an extra round-trip asking for context.
- **Every response reports its own token cost** — agents budget in real time, not after the fact.
- **`get_state` returns the full state envelope in one call** — visible, enabled, checked, focused, disabled, aria-expanded, aria-busy, aria-invalid. No 4-call chain to decide if a button is clickable.
- **`wait_for_state` accepts composite predicates** — `{ visible: true, enabled: true, focused: false }` evaluated atomically by the server. One call replaces three.
- **Snapshots flag `recently_changed` elements** — agents focus reasoning on what differs from the last view instead of reprocessing the whole tree.
- **Snapshot diffs are a parameter, not a separate tool** — `electron_snapshot({ since: 'last' })` returns only deltas. Fewer APIs to remember.
- **`expect_*` primitives replace read-compare-retry chains** — `electron_expect_text({ ref, equals: 'Welcome', timeoutMs: 5000 })` is one call, not five.
- **`electron_find` queries the accessibility tree semantically** — `{ role: 'button', name_contains: 'Submit', visible: true }` — no CSS selectors, no XPath, no guessing.
- **Hot-reload-aware** — snapshot and find responses report when the renderer reloaded since the previous baseline, so agents know refs may need refreshing.
- **Framework-agnostic snapshot** — built on accessibility roles and ARIA instead of framework-internal properties. Current fixtures cover vanilla, React, Vue, and Lit; the broader renderer matrix is still expanding.

## What competitors don't cover (yet)

The MCP ecosystem for browser automation is mature. The MCP ecosystem for **desktop Electron apps** is fragmented and still missing three structural capabilities this project is designed to deliver:

1. **Attach to a running dev server without restarting it.** Every alternative requires `--remote-debugging-port` from launch. The planned injector transport targets runtime attach via the Node Inspector handshake so a dev server can keep its state.
2. **Session traces with deterministic replay and per-tool token budgets.** Inspired by Playwright's `trace.zip` but designed for LLM agent sessions: timeline of DOM, console, network, IPC, and screenshots — replayable against a fresh app instance, with token estimates so agents can cap runaway loops.
3. **End-to-end validation of signed, notarized, packaged `.app` bundles** — `codesign`, Gatekeeper assessment, autoUpdater feed inspection, `protocol.registerFileProtocol` scheme verification, `crashReporter` capture. The full production surface, not just dev.

Microsoft's official Playwright MCP team [explicitly declined](https://github.com/microsoft/playwright-mcp/pull/1291) to support Electron ("you can release your own server for Electron" — Pavel Feldman, lead). This project takes the invitation seriously.

## Quick start

> The package is not published yet. For now, use a local checkout:

```bash
# From a checkout, build the server and point your MCP host at the built CLI.
pnpm install
pnpm build

claude mcp add electron-stagewright --scope user -- node /abs/path/to/electron-stagewright/packages/core/dist/cli.js

# Once the package is published, the command will become:
claude mcp add electron-stagewright --scope user -- npx -y @electron-stagewright/core
```

Project `.mcp.json` shape:

```json
{
  "mcpServers": {
    "electron-stagewright": {
      "command": "node",
      "args": ["/abs/path/to/electron-stagewright/packages/core/dist/cli.js"]
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
- **`CDPTransport`** — Chrome DevTools Protocol direct, no Playwright dependency, currently a capability-honest stub.
- **`InjectorTransport`** — Node Inspector handshake into running process, currently a capability-honest stub.

Plugin model: small core first; planned domain plugins ship later as `@electron-stagewright/plugin-*` packages (`production`, `trace`, `network`, `clock`, `storage`, `ipc`, `macos-native`).

## Dogfooding targets

The MCP is built against two real Electron applications maintained by the author, covering distinct verticals so the design doesn't accidentally bias to one shape:

- **Code-editor shape** — a code editor with runtime sandboxes, licensing, and IPC-heavy state. Stresses keyboard-driven flows, editor state, and license verification.
- **POS shape** — a multi-tenant Point of Sale desktop app with embedded Fastify server and SQLite. Stresses forms, large tables, embedded backend, auto-updater feeds.

If your Electron app has a shape these don't cover, [open an issue](https://github.com/electron-stagewright/electron-stagewright/issues) — we'd love to add it as an example fixture.

## Contributing

This project is in its earliest days. Issues and discussions welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
