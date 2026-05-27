# Electron Stagewright

**Agent-native UX from line one. Drive Electron apps the way Playwright drives browsers — but designed for AI agents, not adapted for them.**

A Model Context Protocol (MCP) server that lets AI agents — Claude Code, Codex, Cursor, Cline, Aider, and any MCP-compatible host — operate real Electron desktop applications. Click, type, evaluate JavaScript in main or renderer, capture screenshots, intercept IPC, replay sessions, validate signed `.app` bundles, and more.

> Status: pre-alpha. Architecture locked, implementation underway. Star the repo to follow releases.

## Why this exists

Most MCP servers in the wild are Playwright APIs wrapped in an MCP transport. They work, but their UX is a human's API exposed to an agent — leaving the agent to do all the reasoning, comparisons, and recovery manually. Token budgets evaporate on round-trips that shouldn't need to exist.

Electron Stagewright is designed **agent-first from the primitive level up**:

- **Errors carry hints, suggested next actions, and similar-ref alternatives** — agents recover without an extra round-trip asking for context.
- **Every response reports its own token cost** — agents budget in real time, not after the fact.
- **`get_state` returns the full state envelope in one call** — visible, enabled, checked, focused, disabled, aria-expanded, aria-busy, aria-invalid. No 4-call chain to decide if a button is clickable.
- **`wait_for_state` accepts composite predicates** — `{ visible: true, enabled: true, focused: false }` evaluated atomically by the server. One call replaces three.
- **Snapshots flag `recently_changed` elements** — agents focus reasoning on what differs from the last view instead of reprocessing the whole tree.
- **Snapshot diffs are a parameter, not a separate tool** — `snapshot({ since: 'last' })` returns only deltas. Fewer APIs to remember.
- **`expect_*` primitives replace read-compare-retry chains** — `expect_text({ ref, equals: 'Welcome', timeoutMs: 5000 })` is one call, not five.
- **`find` queries the accessibility tree semantically** — `find({ role: 'button', name_contains: 'Submit', visible: true })` — no CSS selectors, no XPath, no guessing.
- **Hot-reload-aware** — if the renderer reloaded during a session, the next response carries `_meta.renderer_reloaded_since_last_snapshot: true` so agents know their refs are stale before failing.
- **Framework-agnostic snapshot** — works on React, Vue, Svelte, Lit, Solid, Qwik, vanilla. Detection via accessibility roles and ARIA, never via framework-internal properties.

## What competitors don't cover (yet)

The MCP ecosystem for browser automation is mature. The MCP ecosystem for **desktop Electron apps** is fragmented and missing three structural capabilities that no existing server delivers:

1. **Attach to a running dev server without restarting it.** Every alternative requires `--remote-debugging-port` from launch. Electron Stagewright injects at runtime via Node Inspector handshake — your dev server keeps running, your state is preserved.
2. **Session traces with deterministic replay and per-tool token budgets.** Inspired by Playwright's `trace.zip` but designed for LLM agent sessions: timeline of DOM, console, network, IPC, and screenshots — replayable against a fresh app instance, with token estimates so agents can cap runaway loops.
3. **End-to-end validation of signed, notarized, packaged `.app` bundles** — `codesign`, Gatekeeper assessment, autoUpdater feed inspection, `protocol.registerFileProtocol` scheme verification, `crashReporter` capture. The full production surface, not just dev.

Microsoft's official Playwright MCP team [explicitly declined](https://github.com/microsoft/playwright-mcp/pull/1291) to support Electron ("you can release your own server for Electron" — Pavel Feldman, lead). This project takes the invitation seriously.

## Quick start

> The package is not published yet. Once the first release ships:

```bash
# Register with Claude Code
claude mcp add electron-stagewright --scope user -- npx -y @electron-stagewright/core

# Or in your project .mcp.json
{
  "mcpServers": {
    "electron-stagewright": {
      "command": "npx",
      "args": ["-y", "@electron-stagewright/core"]
    }
  }
}
```

Then from any MCP-compatible agent:

```jsonc
// Launch
mcp__electron-stagewright__launch({
  main: "/abs/path/to/.vite/build/main.js",
  env: { MY_ENV_VAR: "value" }
})

// Inspect with full state per ref
mcp__electron-stagewright__snapshot()
// → [1] button "Open File"     enabled=true visible=true
//   [2] button "Settings"      enabled=true visible=true
//   [3] textbox "Email"        value="" focused=false
//   [4] heading "Welcome"

// Interact by ref
mcp__electron-stagewright__click({ ref: 2 })

// Wait for a composite state in one call
mcp__electron-stagewright__wait_for_state({
  ref: 3, state: { focused: true, enabled: true }, timeoutMs: 2000
})

// Assert + retry in one call instead of read-compare-retry chain
mcp__electron-stagewright__expect_text({ ref: 4, equals: "Welcome back" })

// Stop
mcp__electron-stagewright__stop()
```

## What each response looks like (the agent-UX detail)

Success:

```jsonc
{
  "ok": true,
  "ref": 3,
  "settled": true,
  "_meta": {
    "estimated_tokens": 47,
    "elapsed_ms": 142,
    "renderer_reloaded_since_last_snapshot": false
  }
}
```

Error:

```jsonc
{
  "ok": false,
  "error": "ref 7 not found in current snapshot",
  "code": "REF_NOT_FOUND",
  "hint": "The DOM may have rerendered since the last snapshot.",
  "next_actions": ["snapshot()", "wait_for_state({ ref: 5, state: 'visible' })"],
  "similar_refs": [
    { "ref": 9, "role": "button", "name": "Submit" },
    { "ref": 12, "role": "button", "name": "Cancel" }
  ],
  "retryable": false,
  "http": 404,
  "_meta": { "estimated_tokens": 89, "elapsed_ms": 23 }
}
```

The agent has everything to decide its next move without asking for context.

## Architecture

Three transport implementations behind a single `ITransport` interface, so the project survives if Playwright's experimental `_electron` API changes or gets deprecated:

- **`PlaywrightElectronTransport`** — `_electron.launch()`, fast path (default).
- **`CDPTransport`** — Chrome DevTools Protocol direct, no Playwright dependency, stable.
- **`InjectorTransport`** — Node Inspector handshake into running process, no pre-flag required.

Plugin model: small core, domain plugins ship as `@electron-stagewright/plugin-*` packages (`production`, `trace`, `network`, `clock`, `storage`, `ipc`, `macos-native`).

Architectural decisions are documented as ADRs under [`docs/adr/`](docs/adr/) — start with [ADR-001](docs/adr/001-naming-and-license.md).

## Dogfooding targets

The MCP is built against two real Electron applications maintained by the author, covering distinct verticals so the design doesn't accidentally bias to one shape:

- **Code-editor shape** — a code editor with runtime sandboxes, licensing, and IPC-heavy state. Stresses keyboard-driven flows, editor state, and license verification.
- **POS shape** — a multi-tenant Point of Sale desktop app with embedded Fastify server and SQLite. Stresses forms, large tables, embedded backend, auto-updater feeds.

If your Electron app has a shape these don't cover, [open an issue](https://github.com/electron-stagewright/electron-stagewright/issues) — we'd love to add it as an example fixture.

## Contributing

This project is in its earliest days. Issues and discussions welcome. See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
