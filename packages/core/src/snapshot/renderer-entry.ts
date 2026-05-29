/**
 * Renderer-injected entry point for the snapshot walker.
 *
 * This module is NOT imported by the server at runtime. It is bundled into a
 * single self-contained IIFE (`dist/snapshot/injected-walker.js`, built by
 * `scripts/build-renderer-bundle.mjs` with esbuild) and that bundle string is
 * injected into the Electron renderer by the snapshot tool via
 * `session.evaluate('renderer', …)`. The renderer cannot resolve ESM imports, so
 * the walker plus its helpers must be bundled — hand-serialising the function
 * with `Function.prototype.toString` would drop its dependencies.
 *
 * On injection it exposes `globalThis.__stagewrightWalk(options)`, which runs the
 * shared accessibility walker against the live `document` and tags each
 * interactive element with `data-sw-ref="<ref>"` so a later interaction tool can
 * resolve `ref: N` to the `[data-sw-ref="N"]` selector.
 *
 * @module
 */

import type { Snapshot } from './schema.js'
import { type WalkerOptions, walkAccessibilityTree } from './walker.js'

/** Attribute each interactive element is tagged with, keyed to its ref number. */
export const REF_ATTRIBUTE = 'data-sw-ref'

/** The global the injected bundle installs for the snapshot tool to call. */
export interface StagewrightWalkGlobal {
  __stagewrightWalk?: (options?: WalkerOptions) => Snapshot
}

const target = globalThis as typeof globalThis & StagewrightWalkGlobal

target.__stagewrightWalk = (options: WalkerOptions = {}): Snapshot =>
  walkAccessibilityTree(document, { ...options, refAttribute: REF_ATTRIBUTE })
