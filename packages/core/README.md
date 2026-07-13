# @electron-stagewright/core

The core MCP server for [Electron Stagewright](https://github.com/electron-stagewright/electron-stagewright).

Drive Electron desktop applications from AI agents via the Model Context Protocol.

> Pre-alpha. The core server is implemented enough to launch and drive a real
> Electron app. APIs may change quickly.

## Use the published package

The default launch transport uses Playwright and an Electron runtime. Start the CLI with all three
packages available:

```bash
npx -y --package @electron-stagewright/core@0.2.0 --package playwright@1.61.1 \
  --package electron@42.3.0 electron-stagewright
```

Or install all three once and run the bin directly:

```bash
npm install -g @electron-stagewright/core@0.2.0 playwright@1.61.1 electron@42.3.0
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
- A built checkout also provides `doctor --json`, a machine-readable preflight
  for Node, Playwright, Electron, display setup, configured paths, and eval
  policy. The pinned public core 0.2.0 package does not include this command yet.

## Use with Claude Code

```bash
claude mcp add electron-stagewright -- \
  npx -y --package @electron-stagewright/core@0.2.0 --package playwright@1.61.1 \
  --package electron@42.3.0 electron-stagewright
```

For a local checkout, replace the command after `--` with
`node /abs/path/to/electron-stagewright/packages/core/dist/cli.js`.
Claude Code's default local scope limits this setup to the current project; use
`--scope project` only when you intend to commit a shared `.mcp.json` configuration.

## License

MIT. See [LICENSE](../../LICENSE) at the repository root.
