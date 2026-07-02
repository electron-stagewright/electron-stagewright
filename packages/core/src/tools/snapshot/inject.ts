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

import { fnv1a32 } from '../../hash.js'

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
 * Wrap the ~30KB walker bundle so it is parsed and executed by the renderer only
 * ONCE per document, then reused across every subsequent snapshot / find / read /
 * probe call. The bundle installs `globalThis.__stagewrightWalk` /
 * `__stagewrightProbe` unconditionally, so re-shipping and re-running it on every
 * tool call is pure waste — the globals are already installed. A per-document
 * version marker keyed to the bundle's content hash re-installs automatically when
 * a server upgrade ships a different bundle against a still-open renderer, and a
 * renderer reload clears the marker so the next call re-installs from scratch.
 *
 * The wire still carries the full bundle every call (the eval body is stateless),
 * but the renderer skips the expensive re-parse/re-execute when the marker matches.
 */
function wrapBundle(bundle: string, invocation: string): string {
  const marker = `sw_${fnv1a32(bundle)}`
  return `if (globalThis.__stagewrightBundle !== ${JSON.stringify(marker)}) {
${bundle}
globalThis.__stagewrightBundle = ${JSON.stringify(marker)};
}
${invocation}`
}

/**
 * Build the renderer-eval body that runs the bundled walker. The bundle installs
 * `globalThis.__stagewrightWalk`; the body then calls it with the walk options
 * (`arg`, supplied by the transport's evaluate wrapper) and returns the snapshot.
 */
export function buildWalkBody(bundle: string): string {
  return wrapBundle(bundle, 'return globalThis.__stagewrightWalk(arg);')
}

/**
 * Build the renderer-eval body that runs the single-element read probe the
 * bundle installs as `globalThis.__stagewrightProbe`. The read tools call it with
 * `arg = { mode, selector?, limit? }` (the transport's evaluate wrapper passes
 * `arg`), reusing the same role / accname / state machinery as the walker.
 */
export function buildProbeBody(bundle: string): string {
  return wrapBundle(bundle, 'return globalThis.__stagewrightProbe(arg);')
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
