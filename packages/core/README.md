# @electron-stagewright/core

The core MCP server for [Electron Stagewright](https://github.com/electron-stagewright/electron-stagewright).

Drive Electron desktop applications from AI agents via the Model Context Protocol.

> Pre-alpha. The core server is implemented enough to launch and drive a real
> Electron app. APIs may change quickly.

## Use the published package

The default launch transport uses Playwright and an Electron runtime. Start the CLI with all three
packages available:

```bash
npx -y --package @electron-stagewright/core --package playwright --package electron electron-stagewright
```

Or install both once and run the bin directly:

```bash
npm install -g @electron-stagewright/core playwright electron
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
- `--screenshot-dir <path>` changes where screenshots are written when a tool
  call does not pass an explicit path.
- `doctor --json` runs a machine-readable preflight without opening the MCP
  stdio server. It checks Node, Playwright, Electron, display setup, configured
  paths, and eval policy.

## Use with Claude Code

```bash
claude mcp add electron-stagewright --scope user -- \
  npx -y --package @electron-stagewright/core --package playwright --package electron electron-stagewright
```

For a local checkout, replace the command after `--` with
`node /abs/path/to/electron-stagewright/packages/core/dist/cli.js`.

## License

MIT. See [LICENSE](../../LICENSE) at the repository root.
