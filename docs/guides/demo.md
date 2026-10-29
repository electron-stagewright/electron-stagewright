# Try the demo

Use the demo when you want to prove that your MCP host can start Electron Stagewright and drive a
real Electron app before pointing it at your own project. It is a small local task board with a
modal form, mutable list, and second window; it makes no network requests and carries no
credentials.

Install the pinned demo beside core, Playwright, and Electron. The `--demo` flag remains opt-in: a
normal core installation neither loads nor depends on this package.

## Start it from the published packages

Prepare a fresh `npx` cache in a terminal before adding this command to an MCP host. Electron
downloads its binary the first time something loads it and prints progress to stdout, so fetch it
with `install-electron` first, outside the stdio protocol, then confirm with `doctor`. Keep
`--prefix ~/` in every command so `npx` installs the whole list even inside a project that already
has Playwright or Electron:

```sh
npx -y --prefix ~/ \
  --package @electron-stagewright/core@0.8.1 \
  --package @electron-stagewright/demo@0.1.0 \
  --package playwright@1.63.0 \
  --package electron@42.11.10 \
  install-electron
npx -y --prefix ~/ \
  --package @electron-stagewright/core@0.8.1 \
  --package @electron-stagewright/demo@0.1.0 \
  --package playwright@1.63.0 \
  --package electron@42.11.10 \
  electron-stagewright doctor --json
```

`doctor` should report `"ok": true`. Then use the same package list with `electron-stagewright --demo`
in the host configuration. The package set is deliberately pinned: update all four versions together
after validating a new release. To run from a built checkout instead, use:

```sh
node /absolute/path/to/electron-stagewright/packages/core/dist/cli.js --demo
```

## Configure a host

Use `npx` as the command and include the demo package before the CLI and `--demo` flag.

### Claude Code

```sh
claude mcp add electron-stagewright-demo -- \
  npx -y --prefix ~/ --package @electron-stagewright/core@0.8.1 \
  --package @electron-stagewright/demo@0.1.0 --package playwright@1.63.0 \
  --package electron@42.11.10 electron-stagewright --demo
```

### Claude Desktop

Add this entry to `claude_desktop_config.json`, then fully restart Claude Desktop:

```json
{
  "mcpServers": {
    "electron-stagewright-demo": {
      "command": "npx",
      "args": [
        "-y",
        "--prefix",
        "~/",
        "--package",
        "@electron-stagewright/core@0.8.1",
        "--package",
        "@electron-stagewright/demo@0.1.0",
        "--package",
        "playwright@1.63.0",
        "--package",
        "electron@42.11.10",
        "electron-stagewright",
        "--demo"
      ]
    }
  }
}
```

### Cursor

Add the same entry to `.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json`, then reload
Cursor:

```json
{
  "mcpServers": {
    "electron-stagewright-demo": {
      "command": "node",
      "args": ["/absolute/path/to/electron-stagewright/packages/core/dist/cli.js", "--demo"]
    }
  }
}
```

### Any other MCP host

Configure the same `command` and `args` in the host's stdio-server format. With a built checkout,
replace the command and arguments with the absolute `node …/dist/cli.js --demo` form above.

## Drive the flow

After the host lists the server's tools, ask the agent to do the following exactly:

1. Call `electron_launch {}`. The flag supplies the demo entry; no local app path is needed.
2. Call `electron_snapshot`, find the `Add a task` ref, and click it by ref.
3. Type a task into `#task-title`, click `#save-task`, then assert `#task-summary`.
4. Click `#open-inspector`, call `electron_windows_list`, select `Stagewright demo inspector` with
   `electron_switch_window`, and assert `#inspector-status`.
5. Call `electron_stop` when finished.

That sequence exercises launch, snapshot/ref interaction, typing, assertion, and multi-window
surfaces against a visible Electron process. The repository's package smoke also runs this flow from
the packed tarballs before a release.

## Troubleshooting

| Symptom                                                                  | Fix                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `--demo requires @electron-stagewright/demo`                             | Add the pinned demo package beside core and Electron in the `npx` configuration, or install it globally with them.       |
| `electron_launch {}` reports a missing Electron or Playwright dependency | Add the pinned Electron and Playwright packages to the `npx` configuration, or install them globally with core and demo. |
| The demo window is not visible on Linux                                  | Run inside a graphical session or under Xvfb, as with any Electron launch.                                               |
| `--demo` and `--app-root` are both configured                            | Remove one: an app root confines user-selected app paths, while the demo resolves its own checkout entry.                |

The demo verifies a host configuration only. Use [Launch, attach, or inject](./launch-or-attach.md)
when you are ready to drive your own app.
