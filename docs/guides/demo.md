# Try the demo from a checkout

Use the demo when you want to prove that your MCP host can start Electron Stagewright and drive a
real Electron app before pointing it at your own project. It is a small local task board with a
modal form, mutable list, and second window; it makes no network requests and carries no
credentials.

`@electron-stagewright/demo` is release-tested with the repository, but it is **not yet published to
npm**. Until it is public, do not add it to `npx` or a global install. Build a checkout instead.
The `--demo` flag remains opt-in: a normal core installation neither loads nor depends on this
package.

## Build the checkout

```sh
git clone https://github.com/electron-stagewright/electron-stagewright.git
cd electron-stagewright
pnpm install
pnpm build
```

The MCP command is now:

```sh
node /absolute/path/to/electron-stagewright/packages/core/dist/cli.js --demo
```

## Configure a host

Use `node` as the command and give it the absolute built CLI path followed by `--demo`.

### Claude Desktop

Add this entry to `claude_desktop_config.json`, then fully restart Claude Desktop:

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

Configure the same `command` and `args` in the host's stdio-server format. The absolute path is
important: a relative path may resolve from the host's own working directory instead of the
checkout.

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

| Symptom                                                                  | Fix                                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `--demo requires @electron-stagewright/demo`                             | Build this checkout with `pnpm install && pnpm build`, then use the absolute `node …/dist/cli.js --demo` command above. |
| `electron_launch {}` reports a missing Electron or Playwright dependency | Run `pnpm install` from the checkout before building; the workspace supplies the launch peers.                          |
| The demo window is not visible on Linux                                  | Run inside a graphical session or under Xvfb, as with any Electron launch.                                              |
| `--demo` and `--app-root` are both configured                            | Remove one: an app root confines user-selected app paths, while the demo resolves its own checkout entry.               |

The demo verifies a host configuration only. Use [Launch, attach, or inject](./launch-or-attach.md)
when you are ready to drive your own app.
