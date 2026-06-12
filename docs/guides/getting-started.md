# Getting started

From a clean checkout to a complete agent-driven session against a real Electron app — launch,
read the UI, interact, assert, capture, stop. The walkthrough drives the bundled
[`examples/minimal-app`](../../examples/minimal-app/README.md), a ~30-line form app; every call
shown below is the same flow its scripted scenario automates, and a gated repository test
executes this exact sequence against real Electron so the tutorial stays runnable.

## Prerequisites

- Node.js 24 or newer (see `engines` in `package.json`; the server has no native dependencies).
- pnpm via Corepack: `corepack enable`.

## Install and build

```sh
git clone https://github.com/electron-stagewright/electron-stagewright.git
cd electron-stagewright
pnpm install
pnpm build
```

The MCP server entry is now at `packages/core/dist/cli.js`. It speaks the Model Context Protocol
over **stdio**: an MCP host spawns it and exchanges JSON-RPC frames over the child's stdin/stdout.

## Connect a client

**Option A — an MCP host** (Claude Desktop, Cursor, or any MCP-capable agent host). Register the
server with the host's MCP configuration; the shape is the same everywhere:

```json
{
  "mcpServers": {
    "electron-stagewright": {
      "command": "node",
      "args": ["/absolute/path/to/electron-stagewright/packages/core/dist/cli.js"]
    }
  }
}
```

Useful server flags (append to `args`): `--screenshot-dir <dir>` for a stable screenshot location,
`--allow-eval` to register the JavaScript-evaluation tools (off by default), `--plugin <name>` to
load a plugin. The full list is in the [tool reference](../../TOOL-REFERENCE.md).

**Option B — the scripted scenario**, no host required. It connects a real MCP client over stdio
and prints a transcript of every call:

```sh
pnpm --filter @electron-stagewright/example-minimal-app scenario
```

The rest of this guide walks the same steps one call at a time, as an agent would make them.

## 1. Launch the app

```json
electron_launch { "main": "/absolute/path/to/examples/minimal-app/main.js" }
```

```json
{ "ok": true, "session_id": "…", "transport": "playwright-electron", "windows": [...], "renderer_ready": true }
```

`main` must be absolute. The call waits (up to `readyTimeoutMs`, default 5000 ms) for the renderer
to finish its initial render, so the very next read sees a populated app; `renderer_ready: false`
means the wait expired — the session is still usable, retry the read or wait for a known element.
Keep the `session_id`: every later call takes it (and may omit it while this is the only session).

## 2. Read the UI — snapshot

```json
electron_snapshot {}
```

The snapshot is the agent's eyes: the renderer's accessibility tree as a flat list of entries —
`role`, accessible `name`, `state`, `bbox`, and a **stable numbered `ref`** for every interactive
element. For the minimal app that includes the `Your name` textbox, the `Subscribe to updates`
checkbox, the `Plan` select, and the `Greet` button. Refs are tagged onto the DOM
(`data-sw-ref="N"`), survive re-renders of the same element, and are what interaction tools accept
— no CSS guessing. On later reads, pass `since: "last"` to get only what changed instead of the
whole tree.

## 3. Find an element the agent-native way

CSS selectors work everywhere a `ref` does, but the declarative path needs no DOM knowledge:

```json
electron_find { "role": "button", "name_contains": "Greet" }
```

```json
{ "ok": true, "matches": [{ "ref": 4, "role": "button", "name": "Greet", "bbox": {...} }], "count": 1, "renderer_reloaded": false }
```

## 4. Interact

Fill the form (selector-addressed writes), then click the found button **by ref**:

```json
electron_type { "selector": "#name", "text": "Ada Lovelace" }
electron_check { "selector": "#subscribe" }
electron_select_option { "selector": "#plan", "values": ["pro"] }
electron_click { "ref": 4 }
```

Every interaction returns `{ ok, ... }` or a structured error — e.g. clicking a ref that a
re-render invalidated returns `REF_NOT_FOUND` with `similar_refs` (candidates that look like the
element you meant) so the agent recovers in one step instead of re-scanning blind.

## 5. Assert the outcome — one call, not a read-compare-retry loop

```json
electron_expect_text { "selector": "#status", "contains": "Hello, Ada Lovelace" }
```

```json
{ "ok": true, "matched": true, "actual": "Hello, Ada Lovelace! Plan: pro." }
```

`expect_text` polls server-side until the predicate holds or `timeoutMs` expires — the read, the
comparison, and the retry loop collapse into a single MCP round-trip. On failure it returns
`EXPECTATION_FAILED` carrying both `expected` and `actual`, so the agent sees what really happened
without a follow-up read. The whole `expect_*` family works this way —
[Assert UI state](./assert-ui-state.md) covers it.

## 6. Capture evidence

```json
electron_screenshot { "dir": "/absolute/path/for/artifacts" }
electron_console_logs { "match": "greeted" }
```

The screenshot is written on the server host and the call returns its `path` (pass `dir`, or start
the server with `--screenshot-dir`, to keep artifacts out of the OS temp dir). Console output is
captured continuously from launch; `match` / `type` / `since` filter it at read time.
[Capture diagnostics](./capture-diagnostics.md) goes deeper, including session traces.

## 7. Stop

```json
electron_stop {}
```

Always stop — even on failure paths — so no app process outlives the session. If the app ignores
the graceful close, the stop escalates to SIGKILL after a bounded budget and reports
`escalated: true`; the process is never orphaned.

## Where next

- [Launch, attach, or inject](./launch-or-attach.md) — driving YOUR app, including apps that are
  already running.
- [Assert UI state](./assert-ui-state.md) — the assertion and wait toolbox.
- [Capture diagnostics](./capture-diagnostics.md) — screenshots, console, dialogs, traces.
- [`TOOL-REFERENCE.md`](../../TOOL-REFERENCE.md) — the full tool contracts.

---

_Design background: numbered refs and the snapshot schema are ADR-005; the response envelope and
error-code registry are ADR-006; the agent-native principles behind find and the expect family
are ADR-007._
