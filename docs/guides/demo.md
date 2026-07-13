# Try the packaged demo

Use the packaged demo when you want to prove your MCP host can start Electron Stagewright and drive
a real Electron app before pointing it at your own project. The demo is a small local task board:
it has a modal form, mutable list, and second window. It makes no network requests and carries no
credentials.

The `--demo` flag is opt-in. It resolves `@electron-stagewright/demo` only for that server process,
then lets the agent start it with `electron_launch {}`. A normal core installation neither loads nor
depends on the demo package.

## Configure a host

The default launch transport needs Playwright and Electron. Keep all four packages together in the
same package installation, then append `--demo` after the server command.

### Claude Desktop

Add this entry to `claude_desktop_config.json`, then fully restart Claude Desktop:

```json
{
  "mcpServers": {
    "electron-stagewright-demo": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "@electron-stagewright/core",
        "--package",
        "@electron-stagewright/demo",
        "--package",
        "playwright",
        "--package",
        "electron",
        "electron-stagewright",
        "--demo"
      ]
    }
  }
}
```

### Cursor

Use the same command in `.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json`, then reload
Cursor:

```json
{
  "mcpServers": {
    "electron-stagewright-demo": {
      "command": "npx",
      "args": [
        "-y",
        "--package",
        "@electron-stagewright/core",
        "--package",
        "@electron-stagewright/demo",
        "--package",
        "playwright",
        "--package",
        "electron",
        "electron-stagewright",
        "--demo"
      ]
    }
  }
}
```

### Any other MCP host

Configure the same `command` and `args` in the host's stdio-server format. The complete shell
command is:

```sh
npx -y --package @electron-stagewright/core --package @electron-stagewright/demo \
  --package playwright --package electron electron-stagewright --demo
```

### Global install

For a faster repeat startup, install the four packages once:

```sh
npm install -g @electron-stagewright/core @electron-stagewright/demo playwright electron
```

Then configure `{ "command": "electron-stagewright", "args": ["--demo"] }`.

### Local checkout

From a repository checkout, build all workspace packages and use the built CLI:

```sh
pnpm install
pnpm build
node /absolute/path/to/electron-stagewright/packages/core/dist/cli.js --demo
```

For an MCP configuration, use `node` as the command and put the absolute CLI path followed by
`--demo` in `args`.

## Drive the flow

After the host lists the server's tools, ask the agent to do the following exactly:

1. Call `electron_launch {}`. The flag supplies the demo entry; no local path is needed.
2. Call `electron_snapshot`, find the `Add a task` ref, and click it by ref.
3. Type a task into `#task-title`, click `#save-task`, then assert `#task-summary`.
4. Click `#open-inspector`, call `electron_windows_list`, select `Stagewright demo inspector` with
   `electron_switch_window`, and assert `#inspector-status`.
5. Call `electron_stop` when finished.

That sequence exercises the core launch, snapshot/ref interaction, typing, assertion, and
multi-window surfaces against a visible Electron process. It is also covered from the packed npm
tarballs in the repository's release smoke.

## Troubleshooting

| Symptom                                                                  | Fix                                                                                                                       |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Startup says `--demo requires @electron-stagewright/demo`                | Add `@electron-stagewright/demo` to the same npx/global/local installation as the core package.                           |
| `electron_launch {}` reports a missing Electron or Playwright dependency | Install or include both `playwright` and `electron` as shown above.                                                       |
| The demo window is not visible on Linux                                  | Run inside a graphical session or under Xvfb, as with any Electron launch.                                                |
| `--demo` and `--app-root` are both configured                            | Remove one: an app root intentionally confines launch paths, while the separately installed demo lives outside that root. |

The demo is for connection verification only. Use [Launch, attach, or inject](./launch-or-attach.md)
when you are ready to drive your own app.
