# Examples

Example Electron applications and scripted scenarios that demonstrate Electron Stagewright in action.

The four shapes are chosen to cover distinct stress profiles so the MCP design isn't accidentally biased to one vertical:

- **[`minimal-app/`](./minimal-app/)** — available now. A small Electron app and a scripted agent session that drives it over the real MCP protocol: `snapshot` → `find`/`click` by ref → `type` → `expect_*` → `screenshot`. The "hello world" of the project; see its [README](./minimal-app/README.md) to run it.
- **[`vscode-extension-shape/`](./vscode-extension-shape/)** — available now. An Electron app that mimics the VSCode-extension-as-Webview pattern (a distinct vertical surfaced during customer discovery): activity bar, sidebar, a webview-like content panel, and a command palette. Its scripted scenario drives the shell chrome and nested content by semantic `find` + ref, counts a list by role, and runs a command via the keyboard. See its [README](./vscode-extension-shape/README.md) to run it.
- **[`code-editor-shape/`](./code-editor-shape/)** — available now. Recreation of a real code-editor flow (license activation + runtime sandbox toggle) inspired by the [Lingua](https://github.com/johnny4young/lingua-style) project the maintainer uses. Its scripted scenario stresses keyboard-heavy editing read back by value, a license **failure** assertion before the success path, and `expect_*` polling until an asynchronous runtime status settles. See its [README](./code-editor-shape/README.md) to run it.
- **[`pos-app-shape/`](./pos-app-shape/)** — available now. Recreation of a Point of Sale UI inspired by the maintainer's Puntovivo project. Its scripted scenario stresses an authentication gate (failure then success), multi-tenant context carried from login into the dashboard, a dense line-item form submitted repeatedly, and table scanning by selector count with a derived-total assertion. See its [README](./pos-app-shape/README.md) to run it.

If you have an Electron app whose shape these don't cover, open an issue. The matrix of "what shapes have we tested against" is part of the project's defensive coverage against regression.

## Cross-framework robustness matrix

- **[`framework-matrix/`](./framework-matrix/)** — available now. A separate axis from the app shapes above: minimal fixtures that all implement **one** UI contract, each in a different renderer framework (vanilla, React, …), driven by **one** shared real-MCP harness. It proves the snapshot walker and tools are framework-agnostic — a React-rendered button is found and clicked by the same scenario as a vanilla one. One command (`pnpm matrix`) runs every fixture and fails if any does. See its [README](./framework-matrix/README.md).

## Writing a plugin

- **[`plugin-sample/`](./plugin-sample/)** — available now. A minimal plugin (one tool, one error code, a config schema, lifecycle hooks) you can copy from, plus a scripted session that loads it over the real MCP protocol via the CLI `--plugin` flag. Shows tool/error-code namespacing, `makePluginError`, plugin config, and the `electron_plugins` introspection tool. See its [README](./plugin-sample/README.md).
