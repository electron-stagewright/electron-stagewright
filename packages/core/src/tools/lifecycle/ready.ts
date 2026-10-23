/**
 * Renderer readiness shared by `electron_launch` and `electron_reload`: wait until the active
 * renderer has finished its initial render, so a snapshot or find right after sees a populated app.
 *
 * @module
 */

import { StagewrightError } from '../../errors/registry.js'
import type { TransportSession } from '../../transports/index.js'
import { isRendererNavigation } from '../../transports/navigation.js'
import { sleep } from '../wait/sleep.js'

/** Default budget for the renderer-ready wait (ms). */
export const DEFAULT_READY_TIMEOUT_MS = 5000

/** Brief retry delay when a renderer target changes during the first readiness probe. */
const RENDERER_READY_RETRY_INTERVAL_MS = 50

/**
 * Upper bound on `readyTimeoutMs`. The renderer-ready wait runs INSIDE the launch dispatch, so a
 * value above the dispatch operation-timeout backstop (default 120s) would turn a successful launch
 * into a retryable OPERATION_TIMEOUT — the app is up and the session registered, but the agent sees
 * a timeout, retries, and hits ALREADY_RUNNING. Mirrors the 60s clamp the wait family uses to stay
 * under the backstop.
 */
export const MAX_READY_TIMEOUT_MS = 60_000

/**
 * Renderer-evaluable, self-bounded poll: resolve as soon as the document has finished its
 * initial parse AND its body contains meaningful rendered content (not just an empty app
 * root container), or `{ ready: false }` once the `arg.timeoutMs` budget elapses. Runs
 * inside the transport's `(async () => { … })()` wrapper, so `await` / `return` work and
 * Date.now/setTimeout are the renderer's.
 */
const RENDERER_READY_BODY = `
const deadline = Date.now() + (typeof arg.timeoutMs === 'number' ? arg.timeoutMs : 0);
function ready() {
  if (typeof document === 'undefined') return false;
  if (document.readyState === 'loading' || !document.body) return false;
  // Short-circuit on the FIRST non-whitespace text node (skipping script/style/template)
  // rather than concatenating the whole subtree — a ready large DOM returns on the first
  // hit instead of materialising all its text.
  function hasMeaningfulText(node) {
    if (!node) return false;
    if (node.nodeType === 3) return (node.textContent || '').trim().length > 0;
    if (node.nodeType !== 1) return false;
    var tagName = (node.tagName || '').toLowerCase();
    if (tagName === 'script' || tagName === 'style' || tagName === 'template') return false;
    for (var i = 0; i < node.childNodes.length; i += 1) {
      if (hasMeaningfulText(node.childNodes.item(i))) return true;
    }
    return false;
  }
  if (hasMeaningfulText(document.body)) return true;
  return !!document.body.querySelector(
    'button,input,textarea,select,a[href],[role],[aria-label],[aria-labelledby],img,svg,canvas,video,table,ul,ol,li,h1,h2,h3,h4,h5,h6,[data-testid],[data-test]'
  );
}
for (;;) {
  if (ready()) return { ready: true };
  if (Date.now() >= deadline) return { ready: ready() };
  await new Promise((r) => setTimeout(r, 50));
}
`

/**
 * Wait (up to `timeoutMs`) for the session's active renderer to finish its initial render,
 * returning whether it became ready. Best-effort: a transport that cannot evaluate in the
 * renderer, or a renderer that rejects the probe, yields `false` rather than failing the launch —
 * the session is still usable, the agent just learns the DOM was not confirmed populated. A
 * transient CDP target/disconnection error is retried within the same budget because packaged apps
 * can replace their first page target during startup. `timeoutMs: 0` performs a single
 * instantaneous check.
 */
export async function awaitRendererReady(
  session: TransportSession,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    signal?.throwIfAborted()
    const remainingMs = Math.max(0, deadline - Date.now())
    try {
      const result = await session.evaluate<{ ready?: boolean }>('renderer', RENDERER_READY_BODY, {
        timeoutMs: remainingMs,
      })
      return result?.ready === true
    } catch (error) {
      signal?.throwIfAborted()
      const retryable =
        (error instanceof StagewrightError &&
          (error.code === 'REF_NOT_FOUND' ||
            error.code === 'SURFACE_CLOSED' ||
            error.code === 'CDP_DISCONNECTED' ||
            error.code === 'CDP_TIMEOUT' ||
            error.code === 'INTERNAL_ERROR')) ||
        // The page can still be navigating (a reload, a redirect); try again on the new document.
        isRendererNavigation(error)
      const retryDelayMs = Math.min(
        RENDERER_READY_RETRY_INTERVAL_MS,
        Math.max(0, deadline - Date.now()),
      )
      if (!retryable || retryDelayMs === 0) return false
      await sleep(retryDelayMs, signal)
    }
  }
}
