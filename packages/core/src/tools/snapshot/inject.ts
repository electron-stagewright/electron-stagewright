/**
 * Loader + injection helpers shared by the snapshot tools.
 *
 * The accessibility walker is bundled (by `scripts/build-renderer-bundle.mjs`)
 * into a single self-contained IIFE at `dist/snapshot/injected-walker.js`. This
 * module reads that artifact once (cached) and builds the renderer-eval body
 * that installs `globalThis.__stagewrightWalk` and invokes it. The bundle is
 * read relative to this module so it resolves from the published `dist`.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let cachedBundle: string | undefined

/**
 * Read the bundled walker IIFE from `dist`. Cached after first read. Throws if
 * the bundle is missing (i.e. the package was not built with `build:renderer`).
 */
export function loadInjectedWalker(): string {
  if (cachedBundle === undefined) {
    const bundleUrls = [
      // Runtime path from compiled dist/tools/snapshot/inject.js.
      new URL('../../snapshot/injected-walker.js', import.meta.url),
      // Test/source path when this TypeScript module is loaded directly.
      new URL('../../../dist/snapshot/injected-walker.js', import.meta.url),
    ]
    for (const bundleUrl of bundleUrls) {
      try {
        cachedBundle = readFileSync(fileURLToPath(bundleUrl), 'utf8')
        break
      } catch {
        // Try the next layout before reporting a build-artifact error.
      }
    }
    if (cachedBundle === undefined) {
      throw new Error(
        'Snapshot walker bundle is missing. Run pnpm -F @electron-stagewright/core build.',
      )
    }
  }
  return cachedBundle
}

/**
 * Build the renderer-eval body that runs the bundled walker. The bundle installs
 * `globalThis.__stagewrightWalk`; the body then calls it with the walk options
 * (`arg`, supplied by the transport's evaluate wrapper) and returns the snapshot.
 */
export function buildWalkBody(bundle: string): string {
  return `${bundle}\nreturn globalThis.__stagewrightWalk(arg);`
}

/**
 * Build the renderer-eval body that retags elements after server-side ref
 * reconciliation. The initial walk tags elements with document-order refs; when
 * reconciliation reuses previous refs, the DOM tags must be swapped to match the
 * refs returned to the agent.
 */
export function buildRetagBody(): string {
  return `
const assignments = Array.isArray(arg) ? arg : [];
const pairs = [];
for (const assignment of assignments) {
  const from = Number(assignment?.from);
  const to = Number(assignment?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
  const element = document.querySelector('[data-sw-ref="' + from + '"]');
  pairs.push({ element, to });
}
let updated = 0;
for (const pair of pairs) {
  if (pair.element === null) continue;
  pair.element.setAttribute('data-sw-ref', String(pair.to));
  updated += 1;
}
return updated;
`
}
