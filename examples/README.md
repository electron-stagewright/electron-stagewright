# Examples

Example Electron applications and scripted scenarios that demonstrate Electron Stagewright in action.

The four shapes are chosen to cover distinct stress profiles so the MCP design isn't accidentally biased to one vertical:

- **[`minimal-app/`](./minimal-app/)** — available now. A small Electron app and a scripted agent session that drives it over the real MCP protocol: `snapshot` → `find`/`click` by ref → `type` → `expect_*` → `screenshot`. The "hello world" of the project; see its [README](./minimal-app/README.md) to run it.
- **[`vscode-extension-shape/`](./vscode-extension-shape/)** — available now. An Electron app that mimics the VSCode-extension-as-Webview pattern (a distinct vertical surfaced during customer discovery): activity bar, sidebar, a webview-like content panel, and a command palette. Its scripted scenario drives the shell chrome and nested content by semantic `find` + ref, counts a list by role, and runs a command via the keyboard. See its [README](./vscode-extension-shape/README.md) to run it.
- **`code-editor-shape/`** — recreation of a real code-editor flow (license paste + runtime sandbox toggle) inspired by the [Lingua](https://github.com/johnny4young/lingua-style) project the maintainer uses. Stresses keyboard-heavy interaction, editor state, IPC for runtime sandboxes, and license verification.
- **`pos-app-shape/`** — recreation of a Point of Sale UI inspired by the maintainer's Puntovivo project. Stresses forms-heavy interaction, large tables, multi-tenant auth flow, embedded server lifecycle, and auto-updater feed mocking.

If you have an Electron app whose shape these don't cover, open an issue. The matrix of "what shapes have we tested against" is part of the project's defensive coverage against regression.
