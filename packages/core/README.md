# @electron-stagewright/core

The core MCP server for [Electron Stagewright](https://github.com/electron-stagewright/electron-stagewright):
agentic UX testing for real Electron apps.

Launch or attach, inspect the accessibility tree, interact through stable refs, assert behavior with
retrying expectations, and capture bounded evidence through the Model Context Protocol.

> Early release. Published versions are exercised against real Electron on macOS, Windows, and
> Linux; APIs may still evolve before 1.0.

[Run the packaged demo](https://electron-stagewright.github.io/electron-stagewright/guides/demo.html)
or read the
[getting-started guide](https://electron-stagewright.github.io/electron-stagewright/guides/getting-started.html)
before pointing the server at your own app.

## Use the published package

Requires Node.js 24 or newer, and on Linux a display for the server (`DISPLAY`, `WAYLAND_DISPLAY`,
or `xvfb-run -a`). The default launch transport uses Playwright and an Electron runtime,
so start the CLI with all three packages available. Before handing the command to an MCP host,
prepare it once in a terminal: Electron downloads its binary the first time something loads it,
and that download prints progress to stdout, which would corrupt the host's stdio protocol. Fetch
the binary with Electron's `install-electron` bin using the same package list, then check that
`doctor` reports `"ok": true`. `--prefix ~/` keeps `npx` from skipping a listed package because the
current project already has that version, which would leave the server unable to load it:

```bash
npx -y --prefix ~/ --package @electron-stagewright/core@0.7.0 \
  --package playwright@1.63.0 --package electron@42.11.10 install-electron
npx -y --prefix ~/ --package @electron-stagewright/core@0.7.0 \
  --package playwright@1.63.0 --package electron@42.11.10 electron-stagewright doctor --json
```

Then configure or run the normal server command:

```bash
npx -y --prefix ~/ --package @electron-stagewright/core@0.7.0 \
  --package playwright@1.63.0 --package electron@42.11.10 electron-stagewright
```

Or install all three once and run the bin directly:

```bash
npm install -g @electron-stagewright/core@0.7.0 playwright@1.63.0 electron@42.11.10
install-electron
electron-stagewright
```

## Use from a checkout

```bash
pnpm install
pnpm build
node packages/core/dist/cli.js
```

Useful CLI flags:

- `--allow-eval` registers `electron_eval_main` and `electron_eval_renderer`.
- `--tool-profile <essential|testing|debug|full>` selects an explicit core tool surface. `full`
  is the default, so existing installations keep the complete core catalog; eval and explicitly
  loaded plugins compose independently. `testing` includes `electron_screenshot` for test-evidence
  capture without requiring the broader diagnostic profile.
- `--screenshot-dir <path>` changes where screenshots are written when a tool
  call does not pass an explicit path.
- `--app-root <path>` confines launch/file paths and enables
  `electron_launch({ main, runtime: "project" })` to use the Electron package
  installed inside that project. The server, not the agent, chooses this root.
- `doctor --json` runs a machine-readable preflight for Node, Playwright, Electron,
  display setup, configured paths, eval policy, target runtime alignment, and the exact serve
  configuration. Pass the same plugin/config/profile/timeout/demo flags you intend to serve with;
  doctor imports and briefly sets up those explicitly trusted plugins, validates the server object
  graph, then tears it down. Run it as `electron-stagewright doctor --json`, never as an MCP server
  argument.
- `production validate --app <path> --json` delegates macOS, Windows, or Linux release-artifact
  validation to a separately installed `@electron-stagewright/plugin-production` package. It exits
  without starting MCP stdio.

## Use with Claude Code

```bash
claude mcp add electron-stagewright -- \
  npx -y --prefix ~/ --package @electron-stagewright/core@0.7.0 \
  --package playwright@1.63.0 --package electron@42.11.10 \
  electron-stagewright --tool-profile essential
```

Run `claude mcp list` to confirm the server is connected; its tools appear as
`mcp__electron-stagewright__electron_launch` and so on.

For a local checkout, replace the command after `--` with
`node /abs/path/to/electron-stagewright/packages/core/dist/cli.js`.
Claude Code's default local scope limits this setup to the current project; use
`--scope project` only when you intend to commit a shared `.mcp.json` configuration.

## License

MIT. See [LICENSE](../../LICENSE) at the repository root.
