/**
 * @electron-stagewright/core
 *
 * MCP server entry point.
 *
 * Architecture summary (see docs/adr/ for full rationale):
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
 * See docs/adr/006-error-code-registry.md for the full design.
 */
export * from './errors/index.js'

// Placeholder entry. The real Server + Transport + Tool dispatcher are
// being implemented; the package publishes cleanly so downstream tooling
// can pin against a real npm artifact during early integration.

if (import.meta.url === `file://${process.argv[1]}`) {
  console.error(`@electron-stagewright/core ${VERSION} — pre-alpha.`)
  process.exit(0)
}
