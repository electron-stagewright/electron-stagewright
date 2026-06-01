# @electron-stagewright/core

The core MCP server for [Electron Stagewright](https://github.com/electron-stagewright/electron-stagewright).

Drive Electron desktop applications from AI agents via the Model Context Protocol.

> Pre-alpha. The core server is implemented enough to launch and drive a real
> Electron app, but the package has not been published yet.

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

## Use with Claude Code

```bash
claude mcp add electron-stagewright --scope user -- node /abs/path/to/electron-stagewright/packages/core/dist/cli.js
```

After the first npm publish, this will switch to `npx -y @electron-stagewright/core`.

## License

MIT. See [LICENSE](../../LICENSE) at the repository root.
