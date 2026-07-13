/**
 * Loader + injection helpers shared by the snapshot tools.
 *
 * The accessibility walker is bundled (by `scripts/build-renderer-bundle.mjs`)
 * into a single self-contained IIFE at `dist/snapshot/injected-walker.js`. This
 * module reads that artifact once (cached), first builds a compact renderer-eval
 * body that invokes an existing installation, and sends the installer only after
 * a marker miss. The bundle is read relative to this module so it resolves from
 * the published `dist`.
 *
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { fnv1a32 } from '../../hash.js'
import type { TransportSession } from '../../transports/types.js'

let cachedBundle: string | undefined
let cachedMarkerBundle: string | undefined
let cachedMarker: string | undefined

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
 * Derive the marker once per distinct bundle. The bundle comes from a cached local
 * artifact, but every walker/probe call needs its marker, so re-hashing ~30KB on
 * the server's hot path would undercut the renderer-wire optimization.
 */
function markerFor(bundle: string): string {
  if (cachedMarkerBundle === bundle && cachedMarker !== undefined) return cachedMarker
  const marker = `sw_${fnv1a32(bundle)}`
  cachedMarkerBundle = bundle
  cachedMarker = marker
  return marker
}

type InstalledGlobal = '__stagewrightWalk' | '__stagewrightProbe'

/** Build the compact hot-path body; `null` signals that a full installation is needed. */
function buildInvocationBody(bundle: string, global: InstalledGlobal): string {
  const marker = markerFor(bundle)
  return `if (globalThis.__stagewrightBundle !== ${JSON.stringify(marker)} || typeof globalThis.${global} !== 'function') return null;
return globalThis.${global}(arg);`
}

/** Build the cold-path body that transfers the bundle and then invokes its global. */
function buildInstallBody(bundle: string, global: InstalledGlobal): string {
  const marker = markerFor(bundle)
  return `if (globalThis.__stagewrightBundle !== ${JSON.stringify(marker)} || typeof globalThis.${global} !== 'function') {
${bundle}
globalThis.__stagewrightBundle = ${JSON.stringify(marker)};
}
return globalThis.${global}(arg);`
}

/** Minimal invocation for the accessibility walker. */
export function buildWalkBody(bundle: string): string {
  return buildInvocationBody(bundle, '__stagewrightWalk')
}

/** Full walker installation for a marker miss. */
export function buildWalkInstallBody(bundle: string): string {
  return buildInstallBody(bundle, '__stagewrightWalk')
}

/**
 * Minimal invocation for the single-element read probe. A marker miss returns
 * `null`, which is safe because every probe result is a non-null object.
 */
export function buildProbeBody(bundle: string): string {
  return buildInvocationBody(bundle, '__stagewrightProbe')
}

/** Full probe installation for a marker miss. */
export function buildProbeInstallBody(bundle: string): string {
  return buildInstallBody(bundle, '__stagewrightProbe')
}

/** The narrow renderer-evaluate surface used by the shared injection runner. */
type RendererEvaluator = Pick<TransportSession, 'evaluate'>

async function runInjected<T extends object>(
  session: RendererEvaluator,
  bundle: string,
  arg: unknown,
  buildInvocation: (bundle: string) => string,
  buildInstall: (bundle: string) => string,
): Promise<T> {
  const warm = await session.evaluate<T | null>('renderer', buildInvocation(bundle), arg)
  if (warm !== null) return warm
  return session.evaluate<T>('renderer', buildInstall(bundle), arg)
}

/** Run one accessibility walk, transferring the bundle only when its renderer lacks it. */
export function runWalk<T extends object>(
  session: RendererEvaluator,
  bundle: string,
  arg: unknown,
): Promise<T> {
  return runInjected(session, bundle, arg, buildWalkBody, buildWalkInstallBody)
}

/** Run one element/read probe, transferring the bundle only when its renderer lacks it. */
export function runProbe<T extends object>(
  session: RendererEvaluator,
  bundle: string,
  arg: unknown,
): Promise<T> {
  return runInjected(session, bundle, arg, buildProbeBody, buildProbeInstallBody)
}

/**
 * Build the renderer-eval body that retags elements after server-side ref
 * reconciliation. The initial walk tags elements with document-order refs; when
 * reconciliation reuses previous refs, the DOM tags must be swapped to match the
 * refs returned to the agent.
 *
 * ONE `querySelectorAll('[data-sw-ref]')` scan builds a ref→element map, then all
 * writes apply from it — O(n + retags) instead of a full-document `querySelector`
 * per assignment (O(retags x n), which bites exactly when it matters: a list
 * prepend or dialog open shifts document order and most refs move at once). The
 * resolve-then-write split also keeps ref SWAPS correct: all lookups happen
 * against the pre-retag tags before any write lands.
 */
export function buildRetagBody(): string {
  return `
const assignments = Array.isArray(arg) ? arg : [];
const byRef = new Map();
for (const element of document.querySelectorAll('[data-sw-ref]')) {
  byRef.set(element.getAttribute('data-sw-ref'), element);
}
const pairs = [];
for (const assignment of assignments) {
  const from = Number(assignment?.from);
  const to = Number(assignment?.to);
  if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
  const element = byRef.get(String(from));
  if (element !== undefined) pairs.push({ element, to });
}
let updated = 0;
for (const pair of pairs) {
  pair.element.setAttribute('data-sw-ref', String(pair.to));
  updated += 1;
}
return updated;
`
}
