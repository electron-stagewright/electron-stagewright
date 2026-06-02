# pos-app-shape — auth, dense forms, and a table

A small Electron app shaped like a point-of-sale terminal — a tenant login gate, a
dense line-item form, and a sales table with a running total — plus a scripted agent
session (`scenario.ts`) that drives it with Electron Stagewright over the **real MCP
protocol**, the same way an agent host (Claude Desktop, Cursor, Codex) talks to the
server.

It is modeled on a real POS workflow (Puntovivo) and stresses the surfaces the other
examples don't: an authentication gate, multi-tenant context, repeated submission of a
dense form, and a table the agent scans and counts.

## What it shows

`scenario.ts` connects an MCP client to `node packages/core/dist/cli.js` over stdio
and walks a realistic flow:

1. `electron_launch` → `electron_snapshot` — start and read the UI.
2. Auth gate, **failure first**: wrong credentials → `electron_expect_text` asserts the
   rejection. Then the correct password → `electron_expect_visible` waits for the
   dashboard to be revealed.
3. **Multi-tenant context**: the store chosen at login is asserted on the dashboard
   banner with `electron_expect_text` — proving the context carried through.
4. Dense form: `electron_type` / `electron_select_option` fill the line-item fields and
   `electron_click` (Add, by ref) appends a row — done twice.
5. **Table scanning**: `electron_expect_count` (selector mode, `#sales-body tr`) asserts
   the row count, and `electron_expect_text` reads a specific cell back.
6. Derived total: `electron_expect_text` asserts the concrete value and
   `electron_assert_pattern` asserts the money format.
7. `electron_screenshot` + `electron_console_logs` — capture pixels and console output.
8. `electron_stop` — always, even on failure.

The transcript prints to stderr; the script exits non-zero if any step fails, so it
doubles as a runnable smoke.

## Faithful vs. simplified

The app keeps a real POS shape but stubs the backend:

- **Auth** is a single hardcoded credential (`cashier` / `pos1234`), not a real
  identity provider. The point is exercising a pass/fail gate.
- **Tenants and sales** are in-memory only — there is no server, database, or
  auto-updater. The multi-tenant context is real (it flows from the login select to
  the dashboard); the persistence behind it is not.

The shape is faithful to the POS workflow; the internals are kept minimal so the
example stays about driving, not about building a POS system.

## Run it

From the repository root:

```sh
pnpm install
pnpm build        # builds packages/core/dist/cli.js, which the scenario spawns
pnpm --filter @electron-stagewright/example-pos-app-shape scenario
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
