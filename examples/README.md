# Examples

Example Electron applications and scripted scenarios that demonstrate Electron Stagewright in action.

The four shapes are chosen to cover distinct stress profiles so the MCP design isn't accidentally biased to one vertical:

- **[`minimal-app/`](./minimal-app/)** — available now. A small Electron app and a scripted agent session that drives it over the real MCP protocol: `snapshot` → `find`/`click` by ref → `type` → `expect_*` → `screenshot`. The "hello world" of the project; see its [README](./minimal-app/README.md) to run it.
- **[`vscode-extension-shape/`](./vscode-extension-shape/)** — available now. An Electron app that mimics the VSCode-extension-as-Webview pattern (a distinct vertical surfaced during customer discovery): activity bar, sidebar, a webview-like content panel, and a command palette. Its scripted scenario drives the shell chrome and nested content by semantic `find` + ref, counts a list by role, and runs a command via the keyboard. See its [README](./vscode-extension-shape/README.md) to run it.
- **[`code-editor-shape/`](./code-editor-shape/)** — available now. Recreation of a real code-editor flow (license activation + runtime sandbox toggle) inspired by the [Lingua](https://github.com/johnny4young/lingua-style) project the maintainer uses. Its scripted scenario stresses keyboard-heavy editing read back by value, a license **failure** assertion before the success path, and `expect_*` polling until an asynchronous runtime status settles. See its [README](./code-editor-shape/README.md) to run it.
- **`pos-app-shape/`** — recreation of a Point of Sale UI inspired by the maintainer's Puntovivo project. Stresses forms-heavy interaction, large tables, multi-tenant auth flow, embedded server lifecycle, and auto-updater feed mocking.

If you have an Electron app whose shape these don't cover, open an issue. The matrix of "what shapes have we tested against" is part of the project's defensive coverage against regression.
