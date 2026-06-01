# minimal-app — the "hello world" example

A ~30-line Electron app (`main.js` + `index.html`) and a scripted agent session
(`scenario.ts`) that drives it with Electron Stagewright over the **real MCP
protocol** — the same way an agent host (Claude Desktop, Cursor, Codex) talks to
the server.

## What it shows

`scenario.ts` connects an MCP client to `node packages/core/dist/cli.js` over
stdio and walks a realistic flow:

1. `electron_launch` — start the app.
2. `electron_snapshot` — read the accessibility tree (numbered refs, no CSS guessing).
3. `electron_type` / `electron_check` / `electron_select_option` — fill the form.
4. `electron_find` (by role + name) → `electron_click` **by ref** — reference an
   element the way an agent reasons about it.
5. A token-economy contrast: verifying the result the primitive way
   (`get_text` → `wait_for_state` → `get_text`) is several round-trips; one
   `electron_expect_text` does the read + compare + retry server-side in a single call.
6. `electron_assert_pattern` + `electron_expect_state` — a one-shot regex check and
   a composite state assertion.
7. `electron_screenshot` + `electron_console_logs` — capture pixels and console output.
8. `electron_stop` — always, even on failure.

The transcript prints to stderr; the script exits non-zero if any step fails, so
it doubles as a runnable smoke.

## Agent-UX features exercised

- **Numbered snapshot refs** — interact by `ref`, not by guessed selectors.
- **`find` by role + name** — declarative element lookup with no CSS.
- **`expect_*` primitives** — read + compare + retry-on-mismatch in one call (the
  round-trip contrast is printed live).
- **Structured envelopes** — every step returns `{ ok, ... }`; failures carry a
  registered `code` the script turns into a clear error.

## Run it

From the repository root:

```sh
pnpm install
pnpm build        # builds packages/core/dist/cli.js, which the scenario spawns
pnpm --filter @electron-stagewright/example-minimal-app scenario
```

You need a desktop session (a display): the scenario launches a real Electron
window. Electron and Playwright come from the core package's install.

## Use it from your own agent host

Point your MCP host at the built server. Use an absolute path to `cli.js`.

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`):

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

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.electron-stagewright]
command = "node"
args = ["/absolute/path/to/electron-stagewright/packages/core/dist/cli.js"]
```

Then ask the agent to launch this app's `main.js` and drive it — the same tools
the scenario uses are available interactively.
