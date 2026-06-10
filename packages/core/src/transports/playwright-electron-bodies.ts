/**
 * Static renderer-side JavaScript that {@link PlaywrightElectronTransport}
 * injects via `evaluate`. Kept as plain strings (not closures) so they cross the
 * renderer boundary verbatim; each reads its single `arg` payload and returns a
 * JSON-serialisable result.
 *
 * @module
 */

/**
 * Settle delay (ms) before re-reading an element's editable content for the type-effect check.
 * Editors like Monaco process input asynchronously (read + clear their hidden textarea on the
 * input event), so reading immediately can catch a transient pre-clear value; a short settle
 * lets that resolve before we decide whether the type landed.
 */
export const TYPE_EFFECT_SETTLE_MS = 10

/**
 * Renderer body returning an element's editable content (a form control's `value`, else its
 * `textContent`), or `null` when the element is absent. Optionally settles first (see
 * {@link TYPE_EFFECT_SETTLE_MS}). Used to verify a type actually landed.
 */
export const EDITABLE_SIGNATURE_BODY = `
const settleMs = typeof arg.settleMs === 'number' ? arg.settleMs : 0;
if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
let el = null;
try {
  el = document.querySelector(String(arg.selector));
} catch {
  return null;
}
if (el === null) return null;
return typeof el.value === 'string' ? el.value : (el.textContent || '');
`

/** Renderer body for selector-based scroll. Waits only when `timeoutMs` is set. */
export function buildScrollIntoViewBody(): string {
  return `
const selector = String(arg.selector);
const timeoutMs =
  typeof arg.timeoutMs === 'number' && Number.isFinite(arg.timeoutMs)
    ? Math.max(0, arg.timeoutMs)
    : 0;
const startedAt = Date.now();
for (;;) {
  let element = null;
  try {
    element = document.querySelector(selector);
  } catch {
    return false;
  }
  if (element !== null) {
    element.scrollIntoView({ block: 'center', inline: 'center' });
    return true;
  }
  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) return false;
  await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
}
`
}
