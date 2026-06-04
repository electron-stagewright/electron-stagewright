# plugin-sample — how to write and load a plugin

A minimal Electron Stagewright plugin (ADR-004) you can copy from: one tool, one error
code, a config schema, and lifecycle hooks. Authored as plain ESM (`plugin.js`) so it loads
with `--plugin <path>` and needs no build step.

## The contract

A plugin is a plain object (a `StagewrightPlugin`) exported as the module's `default` (or a
named `plugin`) export:

- **`name`** — the namespace (lowercase, no underscores; `electron` is reserved for core).
  The loader prefixes every tool with it: `greet` registers as `sample_greet`.
- **`version`** — informational; surfaced by the `electron_plugins` tool.
- **`coreVersionRange`** — `*` for any core, or an exact version to pin (v1).
- **`errorCodes`** — bare `SCREAMING_SNAKE_CASE` keys. The loader namespaces each to
  `sample.NAME_REFUSED`; handlers emit them by **returning** `makePluginError('sample.NAME_REFUSED', …)`
  (return, never throw — `StagewrightError` is core-only).
- **`configSchema`** — a Zod schema for deployment config. The loader validates the supplied
  config against it and passes the parsed value to `setup`. Put defaults in the schema.
- **`tools`** — authored with SHORT names and the normal `defineTool` contract; every tool
  still follows the agent-native UX principles (its description documents its error codes).
- **`setup(config)` / `teardown()`** — optional async lifecycle. `setup` receives the
  validated config; `teardown` runs on server close (the loader also unregisters the
  plugin's codes for you).

## Load it

From the repository root, after `pnpm install` + `pnpm build`:

```sh
# By file path (this example):
node packages/core/dist/cli.js --plugin ./examples/plugin-sample/plugin.js \
  --plugin-config sample='{"greeting":"Hola"}'

# By package name (once published/installed): --plugin @your-scope/plugin-foo
# Repeatable, and a single --plugin value may be comma-separated.
```

`--plugin` is loaded explicitly — the server never auto-scans `node_modules`. An
unresolvable plugin aborts startup (fail-closed).

Programmatically, the same plugin loads via `createServer`:

```js
import { createServer } from '@electron-stagewright/core'
import plugin from './examples/plugin-sample/plugin.js'

const server = await createServer({
  plugins: [plugin],
  pluginConfigs: { sample: { greeting: 'Hej' } },
})
```

## Run the scenario

```sh
pnpm --filter @electron-stagewright/example-plugin-sample scenario
```

It spawns the server with this plugin over the real MCP protocol, confirms `sample_greet`
and `electron_plugins` are in `tools/list`, applies the configured greeting, and exercises
the namespaced error path — no Electron window required.
