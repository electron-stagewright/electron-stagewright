# vscode-extension-shape — a structured, multi-region shell

A small Electron app shaped like a VSCode-style editor — an activity bar, a
sidebar, a webview-like content panel, a command palette, and a status bar — plus a
scripted agent session (`scenario.ts`) that drives it with Electron Stagewright over
the **real MCP protocol**, the same way an agent host (Claude Desktop, Cursor, Codex)
talks to the server.

Where the minimal example drives a flat form, this one proves the agent-native tools
reach a **structured** UI: the shell chrome and nested content, navigated by semantic
lookup and keyboard, not by guessed selectors.

## What it shows

`scenario.ts` connects an MCP client to `node packages/core/dist/cli.js` over stdio
and walks a realistic flow:

1. `electron_launch` → `electron_snapshot` — read every region of the shell in one
   numbered-ref tree (no CSS guessing).
2. `electron_expect_count` (role mode) — assert the explorer lists exactly 3 markdown
   files, counted by accessibility **role + name**, not a brittle selector.
3. `electron_find` (by role + name) → `electron_click` **by ref** on the **activity
   bar**, then `electron_expect_text` confirms the sidebar navigated — driving the
   shell chrome.
4. `electron_find` → `electron_click` **by ref** on a button **inside the webview-like
   panel**, proving semantic lookup reaches nested content.
5. `electron_press_sequence` (Ctrl+Shift+P) → `electron_keyboard_type` →
   `electron_key` (Enter) — open and run a **command palette** command with real
   keystrokes, then `electron_expect_text` reads the status bar back.
6. `electron_assert_pattern` — a one-shot regex check on the status bar.
7. `electron_screenshot` + `electron_console_logs` — capture pixels and console output.
8. `electron_stop` — always, even on failure.

The transcript prints to stderr; the script exits non-zero if any step fails, so it
doubles as a runnable smoke.

## Faithful vs. simplified

The "webview" panel is a **same-document** region (`role="region"`), not a real
Electron `<webview>` or `<iframe>`. That keeps the fixture small and, more
importantly, driveable today: snapshot/find currently walk a single renderer
document, so content inside a real cross-document frame would not yet be reachable.
The shape — a bordered content surface an extension owns, with its own controls — is
faithful to what driving a webview feels like, without depending on frame traversal.

## Run it

From the repository root:

```sh
pnpm install
pnpm build        # builds packages/core/dist/cli.js, which the scenario spawns
pnpm --filter @electron-stagewright/example-vscode-extension-shape scenario
```

You need a desktop session (a display): the scenario launches a real Electron window.
Electron and Playwright come from the core package's install. This example is run
locally on demand; it is not wired into CI (real-Electron smokes stay local).

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

Then ask the agent to launch this app's `main.js` and drive it — the same tools the
scenario uses are available interactively.
