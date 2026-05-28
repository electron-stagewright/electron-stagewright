/**
 * @electron-stagewright/core
 *
 * MCP server entry point.
 *
 * Architecture summary:
 * - Server registers MCP stdio transport with @modelcontextprotocol/sdk.
 * - Tools dispatch through an ITransport abstraction with three implementations
 *   (Playwright `_electron`, CDP direct, Inspector inject).
 * - Plugins are dynamically loaded by package name from @electron-stagewright/plugin-*.
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

// Placeholder entry. The real Server + Transport + Tool dispatcher are
// being implemented; the package publishes cleanly so downstream tooling
// can pin against a real npm artifact during early integration.

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(`@electron-stagewright/core ${VERSION} — pre-alpha.`)
  process.exit(0)
}
