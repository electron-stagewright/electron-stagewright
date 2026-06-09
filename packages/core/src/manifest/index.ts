/**
 * Manifest tooling — project the dispatcher's tool manifest into other formats. Currently a
 * Markdown reference generator ({@link renderToolReference}); the writer that emits the committed
 * `TOOL-REFERENCE.md` lives in `gen-tool-reference.ts` (run via `pnpm docs:tools`) and is not
 * re-exported, as it is an executable entry rather than library API.
 *
 * @module
 */

export { renderToolReference } from './tool-reference.js'
