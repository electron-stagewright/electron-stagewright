import { readFileSync } from 'node:fs'

/**
 * The core package version — the single source of truth for the version advertised to MCP clients
 * (the `initialize` `serverInfo.version`) and passed to the plugin loader's core-compatibility check.
 *
 * Read from `package.json` at module load rather than duplicated as a literal, so a release bump in
 * the manifest can never drift from what the server reports (an earlier hardcoded literal shipped a
 * release advertising the wrong version). It is read with `fs` against a URL resolved relative to
 * this module — NOT a TypeScript `import ... with { type: 'json' }` — so the package.json stays
 * outside the compiled `dist/` layout and the published tarball (which ships `package.json` at its
 * root) resolves it the same way the source tree does: `version.ts` and its emitted `version.js` both
 * sit one directory below the manifest.
 */
export const VERSION: string = readCoreVersion()

function readCoreVersion(): string {
  const manifestUrl = new URL('../package.json', import.meta.url)
  const parsed = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { readonly version?: unknown }
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    throw new Error('core package.json must declare a non-empty string "version"')
  }
  return parsed.version
}
