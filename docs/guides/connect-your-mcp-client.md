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
- **Playwright and Electron** for the default launch transport. The core package keeps both as
  optional peers so non-launch flows can import it without the extra install; the examples below
  install both alongside the server.
- An **MCP-capable client** (Claude Desktop, Cursor, or any host that can spawn a stdio MCP server).
- The Electron app you want to drive (the server launches or attaches to it; you do not embed
  anything in the app).

## Pick how the client launches the server

The client needs a `command` and `args` that start the stdio server. Prefer a pinned, project-local
install: it avoids registry work during normal client startup, travels with the project's lockfile,
and gives `--app-root` a stable security boundary.

- **Project-local install (recommended).** Add the tested stack to the Electron app you want to
  drive. `--save-exact` prevents an unrelated package-manager refresh from changing the automation
  runtime:

  ```sh
  cd /absolute/path/to/your-electron-app
  pnpm add --save-dev --save-exact @electron-stagewright/core@0.4.1 playwright@1.61.1
  # Only when the project does not already pin a compatible Electron:
  pnpm add --save-dev --save-exact electron@42.3.0
  pnpm exec electron-stagewright doctor --json --app-root "$PWD"
  ```

  If the app already pins a compatible Electron version, keep the app's version instead of changing
  it solely for Stagewright. Configure the host to execute the local bin from that project:

  ```json
  {
    "command": "node",
    "args": [
      "/absolute/path/to/your-electron-app/node_modules/@electron-stagewright/core/dist/cli.js",
      "--tool-profile",
      "essential",
      "--app-root",
      "/absolute/path/to/your-electron-app"
    ]
  }
  ```

  Replace both absolute paths with the same project directory. On Windows, use an absolute path
  such as `C:\\code\\your-electron-app\\node_modules\\@electron-stagewright\\core\\dist\\cli.js`.
  Calling the JavaScript entry with Node avoids package-manager `.cmd` shim differences across MCP
  hosts. `essential` is the focused launch/snapshot/interact/assert surface; use `full` only when an
  existing workflow needs the compatibility catalog.

- **`npx` (pinned fallback, no permanent install).** The client fetches and caches the server plus
  its Playwright and Electron peers. This is convenient for evaluation but slower and more sensitive
  to an empty package cache than the project-local form. The versions below are intentionally
  pinned: update them together after testing a new release rather than asking every spawn for
  whichever package is newest. This direct `npx` configuration is for macOS/Linux hosts:

  ```json
  {
    "command": "npx",
    "args": [
      "-y",
      "--package",
      "@electron-stagewright/core@0.4.1",
      "--package",
      "playwright@1.61.1",
      "--package",
      "electron@42.3.0",
      "electron-stagewright",
      "--tool-profile",
      "essential",
      "--app-root",
      "/absolute/path/to/your-electron-app"
    ]
  }
  ```

  On Windows, package bins are `.cmd` shims. Route the same arguments through the command processor
  unless your MCP host explicitly handles `.cmd` files:

  ```json
  {
    "command": "cmd.exe",
    "args": [
      "/d",
      "/c",
      "npx.cmd",
      "-y",
      "--package",
      "@electron-stagewright/core@0.4.1",
      "--package",
      "playwright@1.61.1",
      "--package",
      "electron@42.3.0",
      "electron-stagewright",
      "--tool-profile",
      "essential",
      "--app-root",
      "C:\\code\\your-electron-app"
    ]
  }
  ```

  Before adding that configuration to a host, prime the exact same `--package` list once from a
  terminal:

  ```sh
  npx -y --package @electron-stagewright/core@0.4.1 --package playwright@1.61.1 \
    --package electron@42.3.0 electron-stagewright doctor --json \
    --app-root /absolute/path/to/your-electron-app
  ```

  Electron can print a binary-download progress line to stdout during this first install. That is
  harmless in a terminal, but stdout is MCP protocol data after the host starts the server. The
  completed bootstrap leaves the cached command clean for the host. Repeat it after clearing the
  `npx` cache or changing any pinned package version. When you add a demo or plugin package, include
  that same extra `--package` in the bootstrap command before `electron-stagewright doctor --json`.

- **Global install (fast spawn, not project-pinned).** Install once, then call the bin directly.
  This is useful for a single operator, but a project-local dependency is easier for a team to
  reproduce and upgrade together.

  ```sh
  pnpm add --global --save-exact @electron-stagewright/core@0.4.1 \
    playwright@1.61.1 electron@42.3.0
  ```

  ```json
  {
    "command": "electron-stagewright",
    "args": ["--tool-profile", "essential", "--app-root", "/absolute/path/to/your-electron-app"]
  }
  ```

  On Windows, use `cmd.exe` with
  `["/d", "/c", "electron-stagewright.cmd", "--tool-profile", "essential", "--app-root", "C:\\code\\your-electron-app"]`.

- **Local checkout (contributing, or to drive the bundled example).** Build the repo, then run the
  CLI with Node. This is the form [Getting started](./getting-started.md) uses.

  ```json
  {
    "command": "node",
    "args": [
      "/absolute/path/to/electron-stagewright/packages/core/dist/cli.js",
      "--tool-profile",
      "essential",
      "--app-root",
      "/absolute/path/to/your-electron-app"
    ]
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
      "command": "node",
      "args": [
        "/absolute/path/to/your-electron-app/node_modules/@electron-stagewright/core/dist/cli.js",
        "--tool-profile",
        "essential",
        "--app-root",
        "/absolute/path/to/your-electron-app"
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
      "command": "node",
      "args": [
        "/absolute/path/to/your-electron-app/node_modules/@electron-stagewright/core/dist/cli.js",
        "--tool-profile",
        "essential",
        "--app-root",
        "/absolute/path/to/your-electron-app"
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
- `--tool-profile essential` starts with the focused launch/snapshot/interact/assert core surface.
  `testing` adds the broader test-driving tools, `debug` adds attach and diagnostics, and `full`
  remains the compatibility default. This flag does not enable eval or load plugins.
- `--screenshot-dir <dir>` sets a stable location for captured screenshots.
- `--app-root <dir>` confines launch/file paths to a project you control. It also enables
  `electron_launch({ main, runtime: "project" })`, which resolves Electron only from that root so
  the target app can use its own native-addon-compatible runtime. The root is server configuration,
  never an agent argument; an explicit `executablePath` still takes precedence.
- `--demo` supplies an installed demo Electron entry when an agent calls `electron_launch {}`. Add
  `@electron-stagewright/demo@0.1.0` beside core, Playwright, and Electron in an `npx` setup, or
  install it globally with them. It cannot be combined with `--app-root`. See
  [Try the demo](./demo.md) for the exact host configuration.
- `electron-stagewright doctor --json` runs a standalone preflight for Node, Playwright, Electron,
  display setup, configured paths, eval policy, target runtime facts, and the exact server
  configuration. Pass the same `--plugin`, `--plugin-config`, profile, timeout, demo, eval, and path
  flags you plan to use in the MCP client; doctor constructs and tears down an unconnected server
  without opening stdio. Do not append the `doctor --json` command itself to MCP server arguments.
- `--plugin <name>` loads an installed plugin (trace, network, storage, clock, and others). Shipped
  first-party suffixes are aliases (`--plugin trace` resolves to
  `@electron-stagewright/plugin-trace`). With `npx`, add that plugin package as another `--package`
  before the `electron-stagewright` bin; with a global install, install the plugin package globally
  too. Then call `electron_plugins` to see exactly which namespaced tools are enabled and which gate
  (if any) keeps a tool hidden. See [Load, configure, and diagnose plugins](./plugins.md).

With `npx`, server flags follow the `electron-stagewright` bin name:

```json
{
  "args": [
    "-y",
    "--package",
    "@electron-stagewright/core@0.4.1",
    "--package",
    "playwright@1.61.1",
    "--package",
    "electron@42.3.0",
    "electron-stagewright",
    "--tool-profile",
    "essential",
    "--app-root",
    "/absolute/path/to/your-electron-app",
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

| Symptom                                                                | Likely cause                                                                                                                 | Fix                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Server shows "failed" / disconnects immediately                        | Something wrote to **stdout** — for a stdio server, stdout _is_ the protocol channel, so any stray print corrupts the stream | The server sends all diagnostics to stderr by design. If you wrapped it in a shell script, make sure the wrapper prints nothing to stdout.      |
| Client reports "server not found" / no tools                           | Wrong `command`/`args`                                                                                                       | With `npx`, confirm the exact package name. With the local-checkout form, the path must be **absolute** and you must have run `pnpm build`.     |
| Server won't start; a version/engine error                             | Node below the version floor                                                                                                 | The server requires Node 24+. Check `node -v`; with `npx`, the client must resolve a new-enough Node.                                           |
| `electron_launch` reports that Playwright or Electron is not installed | The core package was started without an optional launch peer                                                                 | Use the pinned `npx` form shown above, install all three packages globally, or pass `executablePath` to `electron_launch`.                      |
| `project_runtime` warns about ABI or a native addon                    | The server's default Electron differs from the app's runtime, or inventory is incomplete                                     | Start the server with `--app-root <project>`, run `electron-stagewright doctor --json`, then launch with `runtime: "project"` when appropriate. |
| `electron_eval_main` / `electron_eval_renderer` missing                | Eval tools are gated off by default                                                                                          | Add `--allow-eval` (or `--allow-eval=renderer` / `=main`) to `args`. Read the [security model](./security-model.md) first.                      |
| A known core tool is missing                                           | The selected core profile does not include it                                                                                | Restart with the profile named in the tool's recovery hint, or use `--tool-profile full`.                                                       |
| `electron_launch` returns `FUSES_BLOCK_LAUNCH`                         | A `main`-based Playwright launch selected a runtime that disables the Node CLI inspect fuse                                  | For a packaged app, launch with `executablePath` and no `main`; otherwise use a compatible development runtime.                                 |
| The app won't launch from `electron_launch`                            | `main` is not an absolute path, or the app needs attach/inject                                                               | Pass an absolute `main`; see [Launch, attach, or inject](./launch-or-attach.md) for apps that are already running.                              |

## Where next

- [Getting started](./getting-started.md) — drive the bundled example end to end, one call at a time.
- [Launch, attach, or inject](./launch-or-attach.md) — get a session against **your** app.
- [Security model](./security-model.md) — read before enabling `--allow-eval` or exposing the server.
- [Load, configure, and diagnose plugins](./plugins.md) — load an extension and inspect its gates.
- [Concepts](./concepts.md) — the agent-native model behind the tool surface.
- [`TOOL-REFERENCE.md`](../../TOOL-REFERENCE.md) — every tool's parameters, return shape, and error codes.
