# @electron-stagewright/demo

A small, local-only Electron task board for verifying an Electron Stagewright MCP connection. It
contains a modal form, mutable list, and second window. It makes no network requests and contains no
credentials or secrets.

Install it beside the core server, Playwright, and Electron, then start the server with `--demo`.
The flag resolves this package only for that run and lets an agent call `electron_launch {}` without
knowing a local app path. See the [demo guide](https://electron-stagewright.github.io/electron-stagewright/guides/demo.html)
for exact MCP host configurations and the short interaction flow.

The package intentionally contains only its built Electron entry and static renderer files. It does
not import the repository or make the core server depend on the demo during normal operation.
