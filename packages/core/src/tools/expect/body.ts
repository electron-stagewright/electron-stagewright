/**
 * Renderer poll-body builders for the `expect_*` assertions. Each body runs inside
 * the renderer (wrapped by the transport in `(async () => { … })()`) and
 * SELF-BOUNDS by `arg.timeoutMs` — the same remaining-time loop the wait bodies
 * use — so a never-satisfied expectation resolves `{ satisfied: false, actual }`
 * instead of hanging `evaluate`.
 *
 * Every body resolves to one of:
 * - `{ satisfied: true, actual }` — the expectation held; `actual` is the observed value.
 * - `{ satisfied: false, actual }` — timed out; `actual` is the last observed value
 *   (null when the element was never present), surfaced as `EXPECTATION_FAILED.details.actual`.
 * - `{ satisfied: false, invalid_selector: true, error }` — malformed CSS selector → BAD_ARGUMENT.
 *
 * `expect_visible` and `expect_state` reuse the wait bodies directly; only the
 * text / value / url / count assertions need bespoke bodies.
 *
 * @module
 */

import { ACCESSIBLE_TEXT_FN } from '../accessible-text.js'
import { POLL_PREAMBLE, pollTail } from '../wait/body.js'
import { COUNT_MATCH_FN, STRING_MATCH_FN } from './match.js'

/**
 * Body for `expect_text` / `expect_value` / `assert_pattern`: poll the element
 * identified by `arg.selector`, read its text (`textContent`), value (`.value`),
 * or an attribute (`getAttribute(arg.attribute)`) per `arg.source`, and resolve
 * when the value satisfies `arg.match`.
 *
 * Missing-element behaviour depends on `arg.missAsError`:
 * - false/absent (the polling `expect_*` tools): a missing element keeps polling
 *   (actual stays null) so the assertion also waits for the element to appear,
 *   then times out as a failure rather than a separate miss.
 * - true (the one-shot `assert_pattern`): a missing element is a precondition
 *   failure reported as `{ missing_target: true }`, which the tool layer maps to
 *   `SELECTOR_NO_MATCH` (not-retryable, carries similar_refs) instead of a
 *   retryable value-mismatch.
 */
export function buildExpectTextBody(): string {
  return `${STRING_MATCH_FN}
${ACCESSIBLE_TEXT_FN}
const selector = String(arg.selector);
const source = arg.source === 'value' ? 'value' : (arg.source === 'attribute' ? 'attribute' : 'text');
const attribute = typeof arg.attribute === 'string' ? arg.attribute : '';
const missAsError = arg.missAsError === true;
${POLL_PREAMBLE}
for (;;) {
  let el;
  try {
    el = document.querySelector(selector);
  } catch (err) {
    return { satisfied: false, invalid_selector: true, error: err instanceof Error ? err.message : String(err) };
  }
  if (el === null && missAsError) return { satisfied: false, missing_target: true };
  let actual = null;
  if (el !== null) {
    if (source === 'value') actual = (typeof el.value === 'string' ? el.value : '');
    else if (source === 'attribute') actual = el.getAttribute(attribute);
    else actual = __swAccessibleText(el);
  }
  if (el !== null && __swMatchString(actual, arg.match)) return { satisfied: true, actual };
${pollTail('{ satisfied: false, actual }')}
}
`
}

/**
 * Body for `expect_count` (selector mode): poll `document.querySelectorAll(arg.selector)`
 * (optionally filtered by visibility) and resolve when the match count
 * satisfies `arg.match` (`{ min?, max?, equals? }`).
 */
export function buildExpectCountBody(): string {
  return `${COUNT_MATCH_FN}
const selector = String(arg.selector);
const hasVisibleFilter = typeof arg.visible === 'boolean';
const wantVisible = arg.visible === true;
function isVisible(el) {
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && el.getClientRects().length > 0;
}
${POLL_PREAMBLE}
for (;;) {
  let els;
  try {
    els = Array.from(document.querySelectorAll(selector));
  } catch (err) {
    return { satisfied: false, invalid_selector: true, error: err instanceof Error ? err.message : String(err) };
  }
  const actual = hasVisibleFilter ? els.filter((el) => isVisible(el) === wantVisible).length : els.length;
  if (__swCountOk(actual, arg.match)) return { satisfied: true, actual };
${pollTail('{ satisfied: false, actual }')}
}
`
}

/**
 * Body for `expect_url`: poll `location.href` and resolve when it satisfies
 * `arg.match` (a string predicate; `contains` or `regex`). No element target.
 */
export function buildExpectUrlBody(): string {
  return `${STRING_MATCH_FN}
${POLL_PREAMBLE}
for (;;) {
  const actual = location.href;
  if (__swMatchString(actual, arg.match)) return { satisfied: true, actual };
${pollTail('{ satisfied: false, actual }')}
}
`
}
