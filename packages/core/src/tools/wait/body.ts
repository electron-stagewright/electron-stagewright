/**
 * Renderer poll-body builders for the wait tools. Each body runs inside the
 * renderer (via `session.evaluate('renderer', …)`, wrapped by the transport in
 * `(async () => { … })()`) and SELF-BOUNDS by `arg.timeoutMs` — the same
 * remaining-time loop the scroll-into-view body uses — so a never-satisfied
 * predicate resolves with `{ satisfied: false }` instead of hanging `evaluate`.
 *
 * Every body resolves to one of:
 * - `{ satisfied: true, … }` — the condition held.
 * - `{ satisfied: false, state? }` — timed out (carries the last observed state
 *   for `wait_for_state`, so the tool can report which flag never matched).
 * - `{ satisfied: false, invalid_selector: true, error }` — malformed CSS selector.
 * - `{ satisfied: false, missing_target: true }` — a selector-targeted event wait
 *   whose target element is not present.
 *
 * @module
 */

/** Shared loop preamble: read a finite, non-negative `timeoutMs` and start the clock. */
const POLL_PREAMBLE = `
const timeoutMs =
  typeof arg.timeoutMs === 'number' && Number.isFinite(arg.timeoutMs) ? Math.max(0, arg.timeoutMs) : 0;
const startedAt = Date.now();`

/** Shared loop tail: sleep up to 50ms, or bail when the budget is exhausted. */
function pollTail(timedOutReturn: string): string {
  return `  const remaining = timeoutMs - (Date.now() - startedAt);
  if (remaining <= 0) return ${timedOutReturn};
  await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));`
}

/**
 * Body for `wait_for_selector`: poll `arg.selector` until it reaches `arg.state`
 * (`attached` | `visible` | `hidden` | `detached`). `hidden` is satisfied by an
 * absent OR not-visible element; `visible` requires an attached, laid-out,
 * non-`visibility:hidden` element (matching the snapshot walker's notion).
 */
export function buildWaitForSelectorBody(): string {
  return `
const selector = String(arg.selector);
const want = String(arg.state || 'visible');
${POLL_PREAMBLE}
function isVisible(el) {
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && el.getClientRects().length > 0;
}
function satisfies(el) {
  const attached = el !== null;
  if (want === 'attached') return attached;
  if (want === 'detached') return !attached;
  const visible = attached && isVisible(el);
  if (want === 'visible') return visible;
  if (want === 'hidden') return !visible;
  return false;
}
for (;;) {
  let el = null;
  try {
    el = document.querySelector(selector);
  } catch (err) {
    return { satisfied: false, invalid_selector: true, error: err instanceof Error ? err.message : String(err) };
  }
  if (satisfies(el)) return { satisfied: true, state: want };
${pollTail('{ satisfied: false, state: want }')}
}
`
}

/**
 * Body for `wait_for_state`: poll the element via the injected `__stagewrightProbe`
 * and resolve when every flag in `arg.want` matches the element's live state.
 * On timeout, returns the last observed state so the caller can report which flag
 * never matched. Caller must prepend the walker bundle (it installs the probe).
 */
export function buildWaitForStateBody(bundle: string): string {
  return `${bundle}
const selector = String(arg.selector);
const want = (arg.want && typeof arg.want === 'object') ? arg.want : {};
const keys = Object.keys(want);
${POLL_PREAMBLE}
let last = null;
for (;;) {
  const probe = globalThis.__stagewrightProbe({ mode: 'element', selector });
  if (probe.found === false) {
    if (probe.invalid_selector) return { satisfied: false, invalid_selector: true, error: probe.error };
  } else {
    const state = { ...probe.state, enabled: probe.state.disabled === false };
    last = state;
    let ok = true;
    for (const k of keys) { if (state[k] !== want[k]) { ok = false; break; } }
    if (ok) return { satisfied: true, state };
  }
${pollTail('{ satisfied: false, state: last }')}
}
`
}

/**
 * Body for `wait_for_event`: attach a listener for `arg.eventName` on the target
 * (`arg.selector` element, or `document` when no selector) and resolve when it
 * fires or `timeoutMs` elapses. The listener and timer are always cleaned up.
 */
export function buildWaitForEventBody(): string {
  return `
const eventName = String(arg.eventName);
const selector = (typeof arg.selector === 'string' && arg.selector.length > 0) ? arg.selector : null;
const timeoutMs =
  typeof arg.timeoutMs === 'number' && Number.isFinite(arg.timeoutMs) ? Math.max(0, arg.timeoutMs) : 0;
let target;
if (selector !== null) {
  try {
    target = document.querySelector(selector);
  } catch (err) {
    return { satisfied: false, invalid_selector: true, error: err instanceof Error ? err.message : String(err) };
  }
  if (target === null) return { satisfied: false, missing_target: true };
} else {
  target = document;
}
return await new Promise((resolve) => {
  let done = false;
  function cleanup() {
    clearTimeout(timer);
    target.removeEventListener(eventName, onEvent);
  }
  function onEvent() {
    if (done) return;
    done = true;
    cleanup();
    resolve({ satisfied: true, event: eventName });
  }
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    cleanup();
    resolve({ satisfied: false, event: eventName });
  }, timeoutMs);
  target.addEventListener(eventName, onEvent);
});
`
}
