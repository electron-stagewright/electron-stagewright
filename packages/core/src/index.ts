/**
 * @electron-stagewright/core
 *
 * MCP server entry point.
 *
 * Architecture summary:
 * - Server registers MCP stdio transport with @modelcontextprotocol/sdk.
 * - Tools dispatch through an ITransport abstraction with three implementations
 *   (Playwright `_electron`, CDP direct, Inspector inject).
 * - The core ships an in-process plugin model (manifest, loader, namespaced tools and
 *   error codes — see ADR-004); domain plugins ship as separate
 *   @electron-stagewright/plugin-* packages and are loaded explicitly, never auto-scanned.
 *
 * @packageDocumentation
 */

/**
 * The core package version and the reader behind it. `VERSION` is read from package.json (see
 * `version.ts`) — the single source of truth, so the exported `VERSION`, the MCP `serverInfo.version`,
 * and the plugin core-compatibility check never drift from the manifest. `readPackageVersion` is that
 * same reader, exported so first-party plugins advertise their own version from their manifest the same
 * way (call it with `import.meta.url`).
 */
export { VERSION, readPackageVersion } from './version.js'

/**
 * Error code registry, response envelope helpers, and operation-type routing.
 */
export * from './errors/index.js'

/**
 * Transport abstraction — the single contract every tool dispatches through.
 * Three implementations: Playwright `_electron`, raw CDP, Node Inspector
 * injector. Each declares a capability matrix at load time so the dispatcher
 * refuses unsupported operations with a registered error code.
 */
export * from './transports/index.js'

/**
 * Snapshot — framework-agnostic accessibility-tree walker. Produces the agent's
 * structured view of the current renderer (interactive elements with role,
 * name, state, bounding box, and stable fingerprint).
 */
export * from './snapshot/index.js'

/**
 * Tools — the {@link ToolDefinition} contract every tool is expressed in, plus
 * the concrete tool families (lifecycle, snapshot, interaction, read, wait, eval,
 * observe, and expect).
 */
export * from './tools/index.js'

/**
 * Server — the tool dispatcher, session manager, logger, and the `createServer`
 * assembly entry point. `await createServer()` followed by `connectStdio()` is the
 * production path; the executable entry lives in `cli.ts` (published as the
 * `electron-stagewright` bin).
 */
export * from './server/index.js'

/**
 * Plugins — the in-process extension model (ADR-004). `StagewrightPlugin` is the
 * contract a first-party plugin exports; `loadPlugins` validates and namespaces a set of
 * them; `createServer({ plugins })` wires them into a server. Plugin tools register as
 * `<plugin>_<tool>` and plugin error codes as `<plugin>.CODE`.
 */
export * from './plugins/index.js'

/**
 * Manifest tooling — project the dispatcher's machine-readable tool manifest into other formats.
 * `renderToolReference` emits the Markdown tool catalog committed as `TOOL-REFERENCE.md`.
 */
export * from './manifest/index.js'
