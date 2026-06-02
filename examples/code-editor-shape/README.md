# code-editor-shape — keyboard, async, and a failure path

A small Electron app shaped like a code editor — a code buffer, a license activation
panel, and a runtime sandbox toggle — plus a scripted agent session (`scenario.ts`)
that drives it with Electron Stagewright over the **real MCP protocol**, the same way
an agent host (Claude Desktop, Cursor, Codex) talks to the server.

It is modeled on a real editor workflow (Lingua) and stresses the parts the minimal
and VSCode-shaped examples don't: per-keystroke editing read back by value, an
assertion on a deliberate **failure**, and an **asynchronous** status that a read-once
would race.

## What it shows

`scenario.ts` connects an MCP client to `node packages/core/dist/cli.js` over stdio
and walks a realistic flow:

1. `electron_launch` → `electron_snapshot` — start and read the UI.
2. `electron_keyboard_type` into the editor (real per-character keystrokes, newlines
   included) → `electron_expect_value` — confirm the **buffer's `.value`**, the editor's
   state, not its rendered text.
3. License **failure path first**: `electron_type` a malformed key →
   `electron_find` + `electron_click` by ref on Activate → `electron_expect_text`
   asserts the **rejection**. Asserting the error path matters as much as the happy one.
4. License success: re-type a well-formed key (the fill overwrites the bad attempt) →
   activate → `electron_expect_text` asserts activation.
5. Runtime sandbox: `electron_click` Start, then `electron_expect_text` for "running".
   The status only settles after an async delay (an IPC-like round-trip), so
   `expect_text` **polls until it settles** — a single read would see "starting...".
6. `electron_assert_pattern` — a one-shot regex check on the settled status.
7. `electron_screenshot` + `electron_console_logs` — capture pixels and console output.
8. `electron_stop` — always, even on failure.

The transcript prints to stderr; the script exits non-zero if any step fails, so it
doubles as a runnable smoke.

## Faithful vs. simplified

Two things are stubs, on purpose:

- **License validation** is a regex check (`LINGUA-XXXX`), not a real signature or
  server call. The point is exercising a pass/fail assertion, not real cryptography.
- **The runtime sandbox** is a simulated async (`setTimeout`) in the renderer, not a
  real child process or IPC channel. It reproduces the thing that matters for driving —
  a status that settles later — without the weight of a real sandbox.

The shape is faithful to the editor workflow; the internals are kept minimal so the
example stays about driving, not about building an editor.

## Run it

From the repository root:

```sh
pnpm install
pnpm build        # builds packages/core/dist/cli.js, which the scenario spawns
pnpm --filter @electron-stagewright/example-code-editor-shape scenario
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
