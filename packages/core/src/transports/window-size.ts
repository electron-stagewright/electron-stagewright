/**
 * Shared bodies behind `TransportSession.setWindowSize`: the main-process path resizes the
 * `BrowserWindow` and reads its limits; the renderer path (CDP attach, no main process) calls
 * `window.resizeTo`, which Electron applies to the native window unless the app vetoes it.
 *
 * @module
 */

/**
 * Wait until the read size equals the target, or stops changing (sooner once it moved, later
 * when it never did), within one second: Linux window managers apply a resize asynchronously.
 * `minWaitMs` delays the first read until the browser has had time to answer.
 */
const SETTLE_FN = `
const __swSettle = async (read, target, before, minWaitMs = 0) => {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const start = Date.now();
  if (minWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, minWaitMs));
  let last = read();
  let stableSince = Date.now();
  while (Date.now() - start < 1000 + minWaitMs) {
    const now = read();
    if (same(now, target)) return;
    if (!same(now, last)) { last = now; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= (same(now, before) ? 300 : 100)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
`

/** Main-process body; the caller's prelude binds `win` (a BrowserWindow, or null). */
const MAIN_RESIZE_BODY = `
${SETTLE_FN}
if (!win) return null;
const { width, height, content } = arg.request;
let restored;
if (win.isFullScreen()) {
  restored = 'fullscreen';
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    win.once('leave-full-screen', () => { clearTimeout(timer); resolve(); });
    win.setFullScreen(false);
  });
} else if (win.isMaximized()) {
  restored = 'maximized';
  win.unmaximize();
}
const read = () => (content ? win.getContentSize() : win.getSize());
const before = read();
if (content) win.setContentSize(width, height); else win.setSize(width, height);
await __swSettle(read, [width, height], before);
const size = (pair) => (pair[0] > 0 || pair[1] > 0 ? { width: pair[0], height: pair[1] } : null);
const [ow, oh] = win.getSize();
const [cw, ch] = win.getContentSize();
return {
  outer: { width: ow, height: oh },
  content: { width: cw, height: ch },
  minimum: size(win.getMinimumSize()),
  maximum: size(win.getMaximumSize()),
  ...(restored !== undefined ? { restored_from: restored } : {}),
  method: 'browser_window',
};
`

/** Main body that finds the window by a renderer's DevTools target id (Playwright launch). */
export const RESIZE_BY_TARGET_BODY = `
const wc = electronApp.webContents.fromDevToolsTargetId(arg.targetId);
const win = wc ? electronApp.BrowserWindow.fromWebContents(wc) : null;
${MAIN_RESIZE_BODY}
`

/** Main body that finds the window by its BrowserWindow id (injector). */
export const RESIZE_BY_ID_BODY = `
const win = electronApp.BrowserWindow.fromId(Number(arg.windowId));
${MAIN_RESIZE_BODY}
`

/**
 * Renderer body: `window.resizeTo` sets the outer size, so a content request adds the frame. Blink
 * reports the requested size until the browser applies (and maybe clamps) it, hence the minimum wait.
 */
export const RENDERER_RESIZE_BODY = `
${SETTLE_FN}
const { width, height, content } = arg.request;
const read = () => (content ? [innerWidth, innerHeight] : [outerWidth, outerHeight]);
const before = read();
window.resizeTo(
  content ? width + (outerWidth - innerWidth) : width,
  content ? height + (outerHeight - innerHeight) : height,
);
await __swSettle(read, [width, height], before, 150);
return {
  outer: { width: outerWidth, height: outerHeight },
  content: { width: innerWidth, height: innerHeight },
  minimum: null,
  maximum: null,
  method: 'renderer',
};
`
