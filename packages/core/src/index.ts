/**
 * @electron-stagewright/core
 *
 * MCP server entry point.
 *
 * Architecture summary:
 * - Server registers MCP stdio transport with @modelcontextprotocol/sdk.
 * - Tools dispatch through an ITransport abstraction with three implementations
 *   (Playwright `_electron`, CDP direct, Inspector inject).
 * - Domain plugins are planned as separate @electron-stagewright/plugin-* packages;
 *   the current package intentionally ships only the core tool surface.
 *
 * @packageDocumentation
 */

export const VERSION = '0.0.0'

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
 * assembly entry point. `createServer().connectStdio()` is the production path;
 * the executable entry lives in `cli.ts` (published as the `electron-stagewright`
 * bin).
 */
export * from './server/index.js'
