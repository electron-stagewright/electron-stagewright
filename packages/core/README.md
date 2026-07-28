# @electron-stagewright/core

The core MCP server for [Electron Stagewright](https://github.com/electron-stagewright/electron-stagewright).

Drive Electron desktop applications from AI agents via the Model Context Protocol.

> Pre-alpha. The core server is implemented enough to launch and drive a real
> Electron app. APIs may change quickly.

## Use the published package

The default launch transport uses Playwright and an Electron runtime. Start the CLI with all three
packages available. Before handing this command to an MCP host, run it once in a terminal with
`doctor --json`: Electron can print binary-download progress to stdout during its first install,
which would corrupt the host's stdio protocol. That terminal bootstrap primes the `npx` cache.

```bash
npx -y --package @electron-stagewright/core@0.4.1 --package playwright@1.61.1 \
  --package electron@42.3.0 electron-stagewright doctor --json
```

Then configure or run the normal server command:

```bash
npx -y --package @electron-stagewright/core@0.4.1 --package playwright@1.61.1 \
  --package electron@42.3.0 electron-stagewright
```

Or install all three once and run the bin directly:

```bash
npm install -g @electron-stagewright/core@0.4.1 playwright@1.61.1 electron@42.3.0
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
  loaded plugins compose independently.
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
- `production validate --app <path> --json` delegates packaged-app validation to a separately
  installed `@electron-stagewright/plugin-production` package. It exits without starting MCP stdio.

## Use with Claude Code

```bash
claude mcp add electron-stagewright -- \
  npx -y --package @electron-stagewright/core@0.4.1 --package playwright@1.61.1 \
  --package electron@42.3.0 electron-stagewright
```

For a local checkout, replace the command after `--` with
`node /abs/path/to/electron-stagewright/packages/core/dist/cli.js`.
Claude Code's default local scope limits this setup to the current project; use
`--scope project` only when you intend to commit a shared `.mcp.json` configuration.

## License

MIT. See [LICENSE](../../LICENSE) at the repository root.
