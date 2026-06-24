import { readFileSync } from 'node:fs'

/**
 * Read and validate the `version` field of the `package.json` one directory above the compiled module
 * identified by `moduleUrl`. Pass `import.meta.url` from any package's entry module: every package
 * compiles its entry to `dist/<entry>.js` (one level under the package root, where npm always ships
 * `package.json`), so `../package.json` resolves to that package's own manifest in both the source tree
 * and the published tarball. Reading the version at load time — rather than duplicating it as a literal —
 * means a release bump in the manifest can never drift from what the code advertises (an earlier
 * hardcoded literal shipped a release advertising the wrong version). It uses `fs` against a resolved
 * URL, NOT a TypeScript `import ... with { type: 'json' }`, so the manifest stays outside the compiled
 * `dist/` layout.
 *
 * @param moduleUrl the caller's `import.meta.url`
 * @returns the manifest's non-empty `version` string
 * @throws if the resolved `package.json` declares no non-empty string `version`
 */
export function readPackageVersion(moduleUrl: string): string {
  const manifestUrl = new URL('../package.json', moduleUrl)
  const parsed = JSON.parse(readFileSync(manifestUrl, 'utf8')) as { readonly version?: unknown }
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    throw new Error(`package.json at ${manifestUrl.href} must declare a non-empty string "version"`)
  }
  return parsed.version
}

/**
 * The core package version — the single source of truth for the version advertised to MCP clients
 * (the `initialize` `serverInfo.version`) and passed to the plugin loader's core-compatibility check.
 * Read from `package.json` via {@link readPackageVersion} rather than duplicated as a literal.
 */
export const VERSION: string = readPackageVersion(import.meta.url)
