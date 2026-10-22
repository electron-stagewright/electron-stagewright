/**
 * Recognise a renderer call that failed because the page navigated or reloaded under it.
 *
 * @module
 */

/**
 * Transport messages for a renderer that navigated mid-call. Anchored on the transport's own prefix
 * (a Playwright API such as `page.evaluate:` or `locator.click:`, or a failed CDP method) so an
 * error the evaluated code throws with the same words (`page.evaluate: Error: …`,
 * `CDP evaluation threw: …`) is not mistaken for one.
 */
const NAVIGATED = [
  /^[\w.]+: execution context was destroyed/,
  /^cdp [\w.]+ failed: (inspected target navigated or closed|not attached to an active page)/,
]

/** Whether `err` is a transport report that the renderer navigated during the call. */
export function isRendererNavigation(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return NAVIGATED.some((pattern) => pattern.test(msg))
}
