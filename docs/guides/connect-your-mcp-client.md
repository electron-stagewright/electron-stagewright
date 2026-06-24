# Connect your MCP client

Wire the published server into your MCP client — Claude Desktop, Cursor, or any MCP-capable host —
and confirm it connected, so an agent can drive your own Electron app. This is the task-oriented
counterpart to [Getting started](./getting-started.md): that tutorial clones the repository to drive
the bundled example; here you install the **published** package and point your client at it.

The server speaks the Model Context Protocol over **stdio** — your client spawns it as a child
process and exchanges JSON-RPC frames over stdin/stdout. You give the client a `command` and `args`
that launch the server; everything else is the client's standard MCP configuration.

## Before you start

- **Node.js 24 or newer** (the server's floor — check with `node -v`).
- **Playwright** for the default launch transport. The core package keeps Playwright as an optional
  peer so non-launch flows can import it without the extra install; the `npx` and global examples
  below install Playwright alongside the server.
- An **MCP-capable client** (Claude Desktop, Cursor, or any host that can spawn a stdio MCP server).
- The Electron app you want to drive (the server launches or attaches to it; you do not embed
  anything in the app).

## Pick how the client launches the server

The client needs a `command` and `args` that start the stdio server. Three forms, fastest to set up
first:

- **`npx` (no permanent install).** The client fetches and caches the server plus its Playwright
  peer on first run.

  ```json
  {
    "command": "npx",
    "args": [
      "-y",
      "--package",
      "@electron-stagewright/core",
      "--package",
      "playwright",
      "electron-stagewright"
    ]
  }
  ```

  The first spawn downloads the package, so it is slower; if your client times out waiting for the
  server to start, use the global install below instead.

- **Global install (explicit, fastest spawn).** Install once, then call the bin directly.

  ```sh
  npm install -g @electron-stagewright/core playwright
  ```

  ```json
  { "command": "electron-stagewright", "args": [] }
  ```

- **Local checkout (contributing, or to drive the bundled example).** Build the repo, then run the
  CLI with Node. This is the form [Getting started](./getting-started.md) uses.

  ```json
  {
    "command": "node",
    "args": ["/absolute/path/to/electron-stagewright/packages/core/dist/cli.js"]
  }
  ```

## Configure your client

Each client stores MCP servers in its own config file. Claude Desktop and Cursor use the common
`mcpServers` JSON shape shown below — a named entry with the `command`/`args` you picked above. Other
hosts may wrap the same command and arguments in a different schema, so confirm yours against the
client's own MCP docs.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`; Windows:
`%APPDATA%\Claude\`), then fully restart the app:

```json
{
  "mcpServers": {
    "electron-stagewright": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "@electron-stagewright/core",
        "--package",
        "playwright",
        "electron-stagewright"
      ]
    }
  }
}
```

### Cursor

Add an MCP server in `.cursor/mcp.json` (project-scoped) or the global `~/.cursor/mcp.json`, then
reload:

```json
{
  "mcpServers": {
    "electron-stagewright": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "@electron-stagewright/core",
        "--package",
        "playwright",
        "electron-stagewright"
      ]
    }
  }
}
```

### Any other MCP host

Use the same `command` and `args` in whatever stdio-server schema your host expects. Any host that
spawns a stdio MCP server can run this one; the transport contract is the child process's stdin and
stdout.

### Server flags

Append flags to `args` (after the package/CLI). The common ones:

- `--allow-eval` registers the JavaScript-evaluation tools (`electron_eval_main` /
  `electron_eval_renderer`), which are **off by default**. Grant the narrowest target with
  `--allow-eval=renderer` or `--allow-eval=main`. Read the [security model](./security-model.md)
  before enabling it.
- `--screenshot-dir <dir>` sets a stable location for captured screenshots.
- `--plugin <name>` loads an installed plugin (trace, network, storage, clock, and others). With
  `npx`, add that plugin package as another `--package` before the `electron-stagewright` bin; with
  a global install, install the plugin package globally too.

With `npx`, server flags follow the `electron-stagewright` bin name:

```json
{
  "args": [
    "-y",
    "--package",
    "@electron-stagewright/core",
    "--package",
    "playwright",
    "electron-stagewright",
    "--allow-eval=renderer"
  ]
}
```

## Verify it connected

After saving the config and restarting the client:

1. **The client lists the server's tools.** You should see the `electron_*` catalog —
   `electron_launch`, `electron_snapshot`, `electron_find`, and the rest. If `electron_eval_main` and
   `electron_eval_renderer` are absent, that is expected: they only appear when you pass
   `--allow-eval`.
2. **Drive one round-trip.** Ask the agent to `electron_launch` your app, then `electron_snapshot`. A
   populated snapshot — the accessibility tree with numbered refs — means the wiring works. End with
   `electron_stop` so no app process outlives the session.

No host handy? The [Getting started](./getting-started.md) scripted scenario connects a real MCP
client over stdio without any host, which is a quick way to confirm the server itself runs.

## Troubleshooting

The failure modes are almost all about the stdio channel or the spawn command.

| Symptom                                                    | Likely cause                                                                                                                 | Fix                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Server shows "failed" / disconnects immediately            | Something wrote to **stdout** — for a stdio server, stdout _is_ the protocol channel, so any stray print corrupts the stream | The server sends all diagnostics to stderr by design. If you wrapped it in a shell script, make sure the wrapper prints nothing to stdout.  |
| Client reports "server not found" / no tools               | Wrong `command`/`args`                                                                                                       | With `npx`, confirm the exact package name. With the local-checkout form, the path must be **absolute** and you must have run `pnpm build`. |
| Server won't start; a version/engine error                 | Node below the version floor                                                                                                 | The server requires Node 24+. Check `node -v`; with `npx`, the client must resolve a new-enough Node.                                       |
| `electron_launch` reports that Playwright is not installed | The core package was started without its optional Playwright peer                                                            | Use the `npx --package @electron-stagewright/core --package playwright electron-stagewright` form, or install both packages globally.       |
| `electron_eval_main` / `electron_eval_renderer` missing    | Eval tools are gated off by default                                                                                          | Add `--allow-eval` (or `--allow-eval=renderer` / `=main`) to `args`. Read the [security model](./security-model.md) first.                  |
| The app won't launch from `electron_launch`                | `main` is not an absolute path, or the app needs attach/inject                                                               | Pass an absolute `main`; see [Launch, attach, or inject](./launch-or-attach.md) for apps that are already running.                          |

## Where next

- [Getting started](./getting-started.md) — drive the bundled example end to end, one call at a time.
- [Launch, attach, or inject](./launch-or-attach.md) — get a session against **your** app.
- [Security model](./security-model.md) — read before enabling `--allow-eval` or exposing the server.
- [Concepts](./concepts.md) — the agent-native model behind the tool surface.
- [`TOOL-REFERENCE.md`](../../TOOL-REFERENCE.md) — every tool's parameters, return shape, and error codes.
