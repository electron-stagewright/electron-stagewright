# Connect your MCP client

Wire the published server into your MCP client — Claude Code, Codex, Claude Desktop, Cursor, VS Code,
opencode, or any MCP-capable host — and confirm it connected, so an agent can drive your own
Electron app. This is the task-oriented counterpart to [Getting started](./getting-started.md): that
tutorial clones the repository to drive the bundled example; here you install the **published**
package and point your client at it.

The server speaks the Model Context Protocol over **stdio** — your client spawns it as a child
process and exchanges JSON-RPC frames over stdin/stdout. You give the client a `command` and `args`
that launch the server; everything else is the client's standard MCP configuration.

## Before you start

- **Node.js 24 or newer** (the server's floor — check with `node -v`).
- **On Linux, a display for the server process.** Electron opens real windows, so the server needs
  `DISPLAY` or `WAYLAND_DISPLAY`: run the host inside a desktop session, or start it under a virtual
  display such as `xvfb-run -a`. `doctor` reports this as the `display` check.
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
  pnpm add --save-dev --save-exact @electron-stagewright/core@0.7.0 playwright@1.63.0
  # Only when the project does not already pin a compatible Electron:
  pnpm add --save-dev --save-exact electron@42.11.10
  # Electron fetches its binary on first use; download it now, outside any MCP session:
  pnpm exec install-electron
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
      "--prefix",
      "~/",
      "--package",
      "@electron-stagewright/core@0.7.0",
      "--package",
      "playwright@1.63.0",
      "--package",
      "electron@42.11.10",
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
      "--prefix",
      "~/",
      "--package",
      "@electron-stagewright/core@0.7.0",
      "--package",
      "playwright@1.63.0",
      "--package",
      "electron@42.11.10",
      "electron-stagewright",
      "--tool-profile",
      "essential",
      "--app-root",
      "C:\\code\\your-electron-app"
    ]
  }
  ```

  Before adding that configuration to a host, prepare the exact same `--package` list once from a
  terminal:

  ```sh
  npx -y --prefix ~/ --package @electron-stagewright/core@0.7.0 \
    --package playwright@1.63.0 --package electron@42.11.10 install-electron
  npx -y --prefix ~/ --package @electron-stagewright/core@0.7.0 \
    --package playwright@1.63.0 --package electron@42.11.10 \
    electron-stagewright doctor --json \
    --app-root /absolute/path/to/your-electron-app
  ```

  Electron downloads its binary the first time something loads it, not when the package installs,
  and the download prints a progress line to stdout. That is harmless in a terminal, but stdout is
  MCP protocol data after the host starts the server, so `install-electron` fetches the binary up
  front. `npx` keeps a separate cache per package list: repeat both commands after clearing the
  `npx` cache, changing any pinned version, or adding a demo or plugin `--package`.

  `--prefix ~/` belongs in every one of these commands. `npx` installs only the listed packages
  that its prefix, by default the project around the current directory, does not already have at
  that version. An Electron app project usually has Playwright, Electron, or both, so they would be
  left out of the `npx` cache where the server looks for them, and `doctor` would fail with
  `Cannot find module 'playwright/package.json'`. MCP hosts usually start the server inside your
  project, so this is the common case. Pointing the prefix at your home directory makes `npx`
  install the whole list; the server still runs in the directory the host starts it in.

- **Global install (fast spawn, not project-pinned).** Install once, then call the bin directly.
  This is useful for a single operator, but a project-local dependency is easier for a team to
  reproduce and upgrade together.

  ```sh
  pnpm add --global --save-exact @electron-stagewright/core@0.7.0 \
    playwright@1.63.0 electron@42.11.10
  install-electron
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

Each client stores MCP servers in its own config file, and the command and arguments you picked
above are the same everywhere; only the wrapper changes. Claude Desktop and Cursor use the common
`mcpServers` JSON shape, Codex uses TOML, VS Code uses a `servers` key, and opencode takes the
command as one array. Each section below shows the exact shape. The Claude Desktop and Cursor
examples use the project-local `node` form, which needs that install first; with `npx`, put the
`npx` command and arguments in their place.

### Claude Code

Register the server with `claude mcp add`; everything after `--` is the command and arguments you
picked above:

```sh
claude mcp add electron-stagewright -- \
  npx -y --prefix ~/ --package @electron-stagewright/core@0.7.0 \
  --package playwright@1.63.0 --package electron@42.11.10 \
  electron-stagewright --tool-profile essential
```

The default scope is the current project only; `--scope project` writes the same entry to a shared
`.mcp.json`. `claude mcp list` should show the server as connected, and `/mcp` inside a session
lists its tools as `mcp__electron-stagewright__electron_launch` and so on. Start a new session after
adding it so the agent sees the tools.

### Codex

Run the terminal bootstrap above first, then register the server with `codex mcp add`:

```sh
codex mcp add electron-stagewright -- \
  npx -y --prefix ~/ --package @electron-stagewright/core@0.7.0 \
  --package playwright@1.63.0 --package electron@42.11.10 \
  electron-stagewright --tool-profile essential
```

That writes an entry to `~/.codex/config.toml`. Edit it to add two settings Codex needs for this
server:

```toml
[mcp_servers.electron-stagewright]
command = "npx"
args = [
  "-y",
  "--prefix", "~/",
  "--package", "@electron-stagewright/core@0.7.0",
  "--package", "playwright@1.63.0",
  "--package", "electron@42.11.10",
  "electron-stagewright",
  "--tool-profile", "essential",
]
startup_timeout_sec = 30
env_vars = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"]
```

- `startup_timeout_sec`: Codex gives a server 10 seconds to start by default, which an `npx`
  resolution can exceed.
- `env_vars`: Codex starts servers with a minimal environment (`HOME`, `PATH`, `SHELL`, `USER`
  and a few others), so on Linux the display variables must be forwarded or Electron cannot open a
  window. They are harmless on macOS and Windows.

`codex mcp list` shows only the configuration. Run `/mcp` in the Codex TUI to see whether the server
connected; its tools appear under the `electron-stagewright` name.

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

### VS Code

VS Code reads `.vscode/mcp.json` in the workspace. Its top-level key is `servers`, not
`mcpServers`, so a config copied from another client will not load:

```json
{
  "servers": {
    "electron-stagewright": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "--prefix",
        "~/",
        "--package",
        "@electron-stagewright/core@0.7.0",
        "--package",
        "playwright@1.63.0",
        "--package",
        "electron@42.11.10",
        "electron-stagewright",
        "--tool-profile",
        "essential"
      ]
    }
  }
}
```

To add it to your user profile instead, pass the same command to
`code --add-mcp '{"name":"electron-stagewright","command":"npx","args":[...]}'`. Run **MCP: List
Servers** from the Command Palette to check that it started.

### opencode

Add the server to `opencode.json` in the project. opencode takes the command and its arguments as
one array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "electron-stagewright": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "--prefix",
        "~/",
        "--package",
        "@electron-stagewright/core@0.7.0",
        "--package",
        "playwright@1.63.0",
        "--package",
        "electron@42.11.10",
        "electron-stagewright",
        "--tool-profile",
        "essential"
      ],
      "enabled": true
    }
  }
}
```

`opencode mcp list` should report `electron-stagewright` as connected.

### Desktop apps that do not see your shell `PATH`

Some desktop hosts, Claude Desktop among them, do not load your shell profile when you open them
from the Dock or Finder. A Node.js installed through nvm, fnm, volta, or asdf is then missing from
their `PATH`, and the server fails to start with `npx` or `node` not found in the host's log. An
absolute path to `npx` is not enough on its own: `npx` is a Node.js script, so it fails with
`env: node: No such file or directory`. Give the host the absolute `npx` and a `PATH` that contains
Node.js:

```json
{
  "command": "/Users/you/.local/share/fnm/aliases/default/bin/npx",
  "args": ["-y", "--prefix", "~/", "--package", "@electron-stagewright/core@0.7.0", "..."],
  "env": { "PATH": "/Users/you/.local/share/fnm/aliases/default/bin:/usr/bin:/bin" }
}
```

Use a directory that stays stable across shells. `command -v node` prints a per-session path under
fnm, so point at the default alias instead (`~/.local/share/fnm/aliases/default/bin`); with nvm,
use `~/.nvm/versions/node/<version>/bin`. The project-local form avoids `npx` but still needs the
absolute path to `node` as its `command`.

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
  `testing` adds broader test-driving tools and screenshot evidence capture, `debug` adds attach and
  diagnostics, and `full` remains the compatibility default. This flag does not enable eval or load
  plugins.
- `--screenshot-dir <dir>` sets a stable location for captured screenshots.
- `--app-root <dir>` confines launch/file paths to a project you control. It also makes a
  `main` launch use the Electron installed in that root, so the target app runs on its own
  native-addon-compatible runtime; `runtime: "server"` opts out. The root is server configuration,
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

| Profile     | Intended surface                              | `electron_screenshot` |
| ----------- | --------------------------------------------- | --------------------- |
| `essential` | Focused launch, inspect, interact, and assert | No                    |
| `testing`   | Broader test driving with screenshot evidence | Yes                   |
| `debug`     | Attach, inspect, and diagnostics              | Yes                   |
| `full`      | Complete compatibility surface                | Yes                   |

`--screenshot-dir` supplies the default output directory when the selected profile exposes
`electron_screenshot`; use `testing`, `debug`, or `full` when stable screenshot artifacts are part
of the workflow.

With `npx`, server flags follow the `electron-stagewright` bin name:

```json
{
  "args": [
    "-y",
    "--prefix",
    "~/",
    "--package",
    "@electron-stagewright/core@0.7.0",
    "--package",
    "playwright@1.63.0",
    "--package",
    "electron@42.11.10",
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

Before restarting the client, run `doctor` from a terminal with the same package list and flags. A
working setup prints one JSON document with `"ok": true` and exits 0; each entry in `checks` reports
`pass`, or `skip` when it does not apply (for example, the display check outside Linux):

```json
{
  "ok": true,
  "checks": [
    { "id": "node", "status": "pass", "message": "Node v24.19.0 satisfies the >=24 floor." },
    {
      "id": "playwright",
      "status": "pass",
      "message": "playwright is resolvable by the server process."
    },
    {
      "id": "electron",
      "status": "pass",
      "message": "electron is resolvable by the server process."
    }
  ]
}
```

The real report lists more checks; the shape is the same. After saving the config and restarting
the client:

1. **The client lists the server's tools.** You should see the `electron_*` catalog —
   `electron_launch`, `electron_snapshot`, `electron_find`, and the rest. If `electron_eval_main` and
   `electron_eval_renderer` are absent, that is expected: they only appear when you pass
   `--allow-eval`.
2. **Drive one round-trip.** Ask the agent to `electron_launch` your app, then `electron_snapshot`. A
   populated snapshot — the accessibility tree with numbered refs — means the wiring works. End with
   `electron_stop` so no app process outlives the session.

No host handy? The [Getting started](./getting-started.md) scripted scenario connects a real MCP
client over stdio without any host, which is a quick way to confirm the server itself runs.

## Update to a new release

Every install form above pins exact versions, so nothing updates on its own. Move to a new release
deliberately, in this order:

1. **Find the release and its package set.** `npm view @electron-stagewright/core version` prints
   the latest core version. Each
   [release's notes](https://github.com/electron-stagewright/electron-stagewright/releases) list
   what changed, what to act on, and the plugin versions that go with that core; the README quick
   start shows the tested Playwright and Electron versions. Every `@electron-stagewright/plugin-*`
   package depends on one exact core version, so plan to move each plugin you load together with
   core; an old plugin pin installs a second copy of core.
   `npm view @electron-stagewright/plugin-trace dependencies` shows which core a plugin version
   needs. The demo package does not depend on core.
2. **Prepare the new package list** before any host uses it. With `npx`, run `install-electron`
   and `doctor --json` with the new `--package` list and your server flags, exactly as for a first
   install; the project-local and global forms install and fetch Electron in step 3. `npx` treats a changed list as a separate install, so its Electron binary has to be
   fetched even when only core changed; Electron reuses its download cache, so this is quick when
   the Electron version did not change.
3. **Point the host at the new versions.** Keep every flag you already pass (`--allow-eval`,
   `--app-root`, `--plugin`, `--tool-profile`, and so on); only the versions change.
   - **Claude Code:** `claude mcp add` refuses a name that already exists, and `claude mcp remove`
     forgets your flags. Print the current entry first, then remove it and add it back in the same
     scope with the same flags and the new versions:

     ```sh
     claude mcp get electron-stagewright   # note the Scope and the Args
     claude mcp remove electron-stagewright -s local
     claude mcp add electron-stagewright -s local -- \
       npx -y --prefix ~/ --package @electron-stagewright/core@<new> \
       --package playwright@<new> --package electron@<new> \
       electron-stagewright <the same flags as before>
     ```

     Use `-s user` or `-s project` instead of `-s local` when `claude mcp get` shows that scope; a
     project-scope entry lives in `.mcp.json`, so you can also edit the versions there.

   - **Codex:** edit the versions in `args` under `[mcp_servers.electron-stagewright]` in
     `~/.codex/config.toml`.
   - **Claude Desktop, Cursor, VS Code, opencode:** edit the versions in that host's config file.
   - **Project-local:** update the dependencies (add `electron@<new>` to the same command if you
     added Electron only for Stagewright), then fetch the Electron binary:

     ```sh
     pnpm add --save-dev --save-exact @electron-stagewright/core@<new> playwright@<new>
     pnpm exec install-electron
     ```

   - **Global:** rerun the global install with the new versions, then `install-electron`.

4. **Restart the host**, or start a new session, so it spawns the updated server.
5. **Confirm the version.** `electron-stagewright --version`, run through the same
   `npx -y --prefix ~/ --package ...` command, prints the core version, and `doctor --json` reports
   the running versions under `runtime.server` (`core`, `playwright`, `electron`). With the `debug`
   or `full` profile, the `electron_doctor` tool returns the same report from inside a session.

## Remove the server

1. **Remove it from the host.**
   - Claude Code: `claude mcp remove electron-stagewright` (add `--scope project` to remove a shared
     entry from `.mcp.json`).
   - Codex: `codex mcp remove electron-stagewright`.
   - Claude Desktop, Cursor, VS Code, opencode: delete the `electron-stagewright` entry from the
     config file, then restart or reload the host.
2. **Uninstall the packages** if you installed them. Project-local:
   `pnpm remove @electron-stagewright/core playwright`, plus Electron if you added it only for
   Stagewright and any plugin packages. Global: `pnpm remove --global` with the same names. The
   `npx` form installs nothing permanently.
3. **Optionally reclaim disk space.** `npx` keeps each package list under `_npx` in npm's cache
   (`npm config get cache` prints its location, usually `~/.npm`). Deleting `_npx` is safe; the next
   `npx` run of any tool downloads again. Electron keeps downloaded archives in its own cache:
   `~/Library/Caches/electron` on macOS, `~/.cache/electron` on Linux, and
   `%LOCALAPPDATA%\electron\Cache` on Windows. Screenshots go to the OS temporary directory
   unless you set `--screenshot-dir`.

## Troubleshooting

The failure modes are almost all about the stdio channel or the spawn command.

| Symptom                                                                         | Likely cause                                                                                                                                               | Fix                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server shows "failed" / disconnects immediately                                 | Something wrote to **stdout** — for a stdio server, stdout _is_ the protocol channel, so any stray print corrupts the stream                               | The server sends all diagnostics to stderr by design. If you wrapped it in a shell script, make sure the wrapper prints nothing to stdout.                              |
| Client reports "server not found" / no tools                                    | Wrong `command`/`args`                                                                                                                                     | With `npx`, confirm the exact package name. With the local-checkout form, the path must be **absolute** and you must have run `pnpm build`.                             |
| Codex reports the server timed out during startup                               | Codex allows 10 seconds by default, and an `npx` resolution can take longer                                                                                | Set `startup_timeout_sec = 30` on the server in `~/.codex/config.toml`, and run the terminal bootstrap first.                                                           |
| A desktop host logs `npx` or `node` not found                                   | The host started from the Dock or Finder without your shell `PATH`                                                                                         | Use the absolute `npx` path and an `env.PATH` that contains Node.js; see the desktop-apps section above.                                                                |
| `doctor` fails the `display` check, or no app window opens on Linux             | The server process has neither `DISPLAY` nor `WAYLAND_DISPLAY` (a headless machine, an SSH session, or a host that filters the environment, such as Codex) | Run the host in a desktop session, start it under `xvfb-run -a`, or forward `DISPLAY`, `WAYLAND_DISPLAY` and `XAUTHORITY` (in Codex, through `env_vars`).               |
| Server won't start; a version/engine error                                      | Node below the version floor                                                                                                                               | The server requires Node 24+. Check `node -v`; with `npx`, the client must resolve a new-enough Node.                                                                   |
| `doctor` reports `electron` as failed right after a fresh install               | Electron has not downloaded its binary yet; it does that on first use                                                                                      | Run `install-electron` with the same `--package` list (or `pnpm exec install-electron` in the project), then run `doctor` again.                                        |
| `electron_launch` reports that Playwright or Electron is not installed          | The core package was started without an optional launch peer                                                                                               | Use the pinned `npx` form shown above, install all three packages globally, or pass `executablePath` to `electron_launch`.                                              |
| `doctor` fails `playwright` or `electron` with `Cannot find module` under `npx` | `npx` ran inside a project that already has that package at the pinned version, so it left the package out of its cache                                    | Add `--prefix ~/` after `-y` in every `npx` command for the server, rerun `install-electron` and `doctor`, then restart the host.                                       |
| `project_runtime` warns about ABI or a native addon                             | The server's default Electron differs from the app's runtime, or inventory is incomplete                                                                   | Start the server with `--app-root <project>`, run `electron-stagewright doctor --json`, then launch with `main`; the project runtime is the default under `--app-root`. |
| `electron_eval_main` / `electron_eval_renderer` missing                         | Eval tools are gated off by default                                                                                                                        | Add `--allow-eval` (or `--allow-eval=renderer` / `=main`) to `args`. Read the [security model](./security-model.md) first.                                              |
| A known core tool is missing                                                    | The selected core profile does not include it                                                                                                              | Restart with the profile named in the tool's recovery hint, or use `--tool-profile full`.                                                                               |
| `electron_launch` returns `FUSES_BLOCK_LAUNCH`                                  | A `main`-based Playwright launch selected a runtime that disables the Node CLI inspect fuse                                                                | For a packaged app, launch with `executablePath` and no `main`; otherwise use a compatible development runtime.                                                         |
| `electron_launch` returns `ELECTRON_RUNTIME_MISSING`                            | Electron downloads its binary on first use, and the server refuses to do that mid-session                                                                  | Run `install-electron` with the server's `--package` list (or `pnpm exec install-electron` in the project), or pass `executablePath`.                                   |
| The app won't launch from `electron_launch`                                     | `main` is not an absolute path, or the app needs attach/inject                                                                                             | Pass an absolute `main`; see [Launch, attach, or inject](./launch-or-attach.md) for apps that are already running.                                                      |

## Where next

- [Getting started](./getting-started.md) — drive the bundled example end to end, one call at a time.
- [Launch, attach, or inject](./launch-or-attach.md) — get a session against **your** app.
- [Security model](./security-model.md) — read before enabling `--allow-eval` or exposing the server.
- [Load, configure, and diagnose plugins](./plugins.md) — load an extension and inspect its gates.
- [Concepts](./concepts.md) — the agent-native model behind the tool surface.
- [`TOOL-REFERENCE.md`](../../TOOL-REFERENCE.md) — every tool's parameters, return shape, and error codes.
