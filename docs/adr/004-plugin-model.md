# ADR-004: Plugin model

- **Status**: Accepted
- **Date**: 2026-06-02
- **Deciders**: johnny4young

## Context

The core ships a lean, universal driving surface — lifecycle, snapshot/find, interaction,
read, wait, eval (opt-in), observe, dialog, expect. Every differentiation capability on the
roadmap (trace/replay, IPC capture, production-package validation, network, clock, storage,
macOS-native surfaces) is heavier, more specialised, or more security-sensitive, and not
every consumer needs it. Bundling all of it into the core would:

- bloat the install (signing/notarization toolchains, a trace artifact format + viewer,
  interception machinery) for users who just want to drive an app;
- push the always-on tool count well past the point where LLM tool-selection accuracy
  degrades (the m13v / laststance data behind ADR-007: ergonomics drive accuracy, and a
  bloated `tools/list` dilutes selection);
- widen the default security surface (a server that can always intercept network or
  validate signed packages is a bigger target than one that opts in).

The answer is a plugin model: the core stays lean; optional capabilities ship as separate
`@electron-stagewright/plugin-*` packages that a consumer loads explicitly. ADR-006 already
anticipated this (`registerPluginCodes('production', …)` → `production.NOTARIZATION_FAILED`)
and deferred the full design here. This ADR locks the contract before any plugin package
exists, so trace/IPC/production all register tools and codes the same way.

## Decision

### 1. A plugin is data plus optional lifecycle hooks

Consistent with ADR-008's "a tool is data, not a function", a plugin is a plain
`StagewrightPlugin` object: a `name` (namespace), a `version`, optional `coreVersionRange`,
optional `tools` (authored with SHORT names), optional `errorCodes` (authored with BARE
keys), and optional async `setup` / `teardown` hooks. A plugin package's module exports one.

### 2. Tools are namespaced `<plugin>_<tool>` (underscore)

Plugin authors write short tool names (`start`); the loader registers them as
`<plugin>_<tool>` (`trace_start`). Plugin names must match `^[a-z][a-z0-9]*$` and may not be
the reserved core namespace `electron`, so plugin tools never collide with the core's
`electron_*` surface and live in the same flat snake_case MCP tool namespace.

This **diverges deliberately** from an earlier sketch (`electron-stagewright/production:verify_signature`,
with `/` and `:`): several MCP hosts restrict tool names to `[A-Za-z0-9_-]`, and `/`/`:` risk
breaking them. Underscore is universally safe and visually consistent with `electron_*`.
Collisions are prevented by the loader (duplicate-name rejection) rather than by punctuation.

### 3. Error codes are namespaced `<plugin>.CODE` (dot)

As locked by ADR-006, plugin error codes surface as `<plugin>.CODE`
(`trace.BUFFER_FULL`). Plugin authors declare BARE SCREAMING_SNAKE_CASE keys; the loader
registers each as `<plugin>.<KEY>` in a **runtime** registry (`registerPluginErrorCodes`)
separate from the core's closed compile-time `ErrorCode` union — the union cannot be
extended dynamically, so plugin codes live alongside it and the envelope builder resolves a
code's `http`/`retryable`/`hint` from either source via `lookupErrorCodeDefinition`. Plugin
handlers emit them with `makePluginError('<plugin>.CODE', …)` — handlers RETURN the
envelope, they do not throw it (`StagewrightError` accepts core codes only).

The runtime registry is **reference-counted**: it is process-global, but tests and
embedders may create more than one server with the same plugin loaded, so registering an
identical code (same `http`/`retryable`/`hint`) is idempotent and bumps a count, while a
code re-registered with a CONFLICTING definition fails closed. Registration is atomic
(validate every key, then mutate) so a malformed later key cannot leak earlier keys, and a
plugin's teardown decrements the count, deleting the code only when it reaches zero.

The dot (codes) vs underscore (tools) asymmetry is intentional: error codes live in the
envelope `code` field — a string the agent reads and branches on — where `<plugin>.CODE`
reads clearly and tells the agent which plugin failed; tool names live in the MCP tool-name
namespace where punctuation safety matters.

### 4. The loader is in-process, explicit, and fails closed

`loadPlugins(plugins, { coreVersion })` validates each manifest (name format, reserved
namespace, version, tool-name shape), checks the core version, namespaces tools and codes,
runs `setup`, and returns the namespaced tools plus an idempotent `teardownAll`. Any failure
— bad manifest, version mismatch, duplicate namespace or tool name, or a throwing `setup` —
**rejects the whole load and tears down any plugins already loaded in that call**, so a
half-initialised set never reaches the dispatcher. `createServer({ plugins })` is async for
this reason; `close()` runs each plugin's teardown (and unregisters its codes).

### 5. No auto-scan

The core NEVER discovers plugins by scanning `node_modules`. Plugins are passed explicitly
to `createServer` (or named explicitly on the CLI, a forthcoming ergonomic). v1 trusts
first-party in-process plugins; community-plugin sandboxing is out of scope and tracked
separately.

### 6. Core-version check (v1)

`coreVersionRange` is optional; v1 supports `*` (any) or an exact match against the running
core version, rejecting a mismatch with `PLUGIN_VERSION_MISMATCH`. Full semver-range matching
is a forthcoming follow-up, kept dependency-free for now.

## Rationale

- **Lean core protects agent accuracy and install size** — the two concrete costs above.
- **Namespacing prevents collisions without a central allocator** — two plugins can both
  ship a `start` tool or a `FAILED` code; the namespace disambiguates.
- **Fail-closed loading** mirrors the eval opt-in and the operation-type validation: a
  misconfigured extension fails at boot, never silently at an agent call.
- **Reusing `AnyToolDefinition` and `OperationType`** (no separate plugin-tool shape) keeps
  one tool contract; ADR-007's ten principles apply to plugin tools unchanged.

## Alternatives considered

| Alternative                                          | Why rejected                                                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Build every capability into the core                 | Bloats install + tool count; widens default security surface; couples release cadence.                                      |
| Auto-scan `node_modules` for plugins                 | Implicit, surprising, and a supply-chain risk; explicit configuration is safer and clearer.                                 |
| Extend the closed `ErrorCode` union for plugin codes | Impossible at runtime (`keyof typeof ERROR_CODES`); a parallel runtime registry is the only way to add codes after compile. |
| `<plugin>/<tool>` or `<plugin>:<tool>` tool names    | `/` and `:` break some MCP hosts; underscore is portable and consistent with `electron_*`.                                  |
| Sandbox community plugins now                        | Out of scope; v1 trusts first-party in-process plugins. Sandboxing is tracked for later.                                    |

## Consequences

- `createServer` is now async (a plugin `setup` may be async). The single production caller
  (the CLI) awaits it; tests that need plugins await it.
- `ErrorResponse.code` widens from `ErrorCode` to `ErrorCode | (string & {})` to carry
  namespaced plugin codes while keeping core-code autocomplete. No exhaustive switch over
  `code` exists, so this is non-breaking.
- The error-code mirror test stays core-only (it scans `packages/core/src`); plugin codes are
  registered at runtime and live in plugin packages or test fixtures, outside its scan.
- Downstream plugin tickets (trace, IPC, production) build on this contract; lifecycle `config`
  and a CLI `--plugin` flag are forthcoming extensions, not part of this slice.

## Status update (CLI loading + config, 2026-06-03)

The "forthcoming extensions" noted above are now realised — the contract above is unchanged;
this records what was added on top of it:

- **`importPlugin(spec)`** (`plugins/resolve.ts`) dynamic-imports a plugin by bare package
  specifier or file path (`path.resolve` + `pathToFileURL` for paths; bare specifiers pass to
  Node resolution unchanged), reads the default or named `plugin` export, and throws
  `PLUGIN_LOAD_FAILED` / `PLUGIN_MANIFEST_INVALID`. Dynamic import executes module top-level
  code, so the trust model is explicit-operator-supplied; community sandboxing stays out of scope.
- **CLI flags**: `--plugin <name|path>` (repeatable and comma-separated) and
  `--plugin-config <name>={json}`. `parseCliArgs` is now exported and unit-tested.
- **Config**: an optional `configSchema` (a `zod` schema) on the plugin is validated against the
  supplied config (defaults applied) before `setup(config)` runs; a mismatch throws the new
  `PLUGIN_CONFIG_INVALID` core code. Config validation happens AFTER codes + loaded-metadata are
  recorded, so the fail-closed teardown unwinds both on a bad config.
- **Introspection**: `electron_plugins` (query) reports loaded `{ name, version, tools }`, and is
  registered ONLY when at least one plugin loaded — a plugin-free server keeps the lean core
  surface. Backed by a best-effort, name-keyed loaded-plugin registry (not reference-counted,
  unlike error codes — display metadata only; the dispatcher's `tools/list` stays authoritative).
- **Example**: `examples/plugin-sample` is a plain-ESM plugin (one tool, one error code, a config
  schema, lifecycle hooks) plus a real-MCP scenario that loads it through the CLI `--plugin` flag.

## Related decisions

- **ADR-006** (Error code registry) — anticipated `registerPluginCodes` and `<plugin>.CODE`;
  this ADR realises that design.
- **ADR-008** (Server and tool dispatcher) — the tool-as-data contract and
  `createServer({ tools })` that the plugin tools register through.
- **ADR-007** (Agent-native UX) — every plugin tool must follow all ten principles.

## References

- `packages/core/src/plugins/` — contract (`types.ts`), loader (`loader.ts`), resolver
  (`resolve.ts`), introspection tool (`info-tool.ts`), loaded registry (`loaded-registry.ts`).
- `packages/core/src/errors/registry.ts` — `registerPluginErrorCodes` / `lookupErrorCodeDefinition`,
  `PLUGIN_CONFIG_INVALID`.
- `packages/core/src/errors/envelope.ts` — `makePluginError`.
- `packages/core/src/server/server.ts` — `createServer({ plugins, pluginConfigs })`.
- `packages/core/src/cli.ts` — `--plugin` / `--plugin-config` flags, `parseCliArgs`.
- `examples/plugin-sample/` — a runnable authoring example loaded over the real MCP protocol.
