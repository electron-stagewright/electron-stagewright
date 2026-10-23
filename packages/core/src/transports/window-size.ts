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
 */
const SETTLE_FN = `
const __swSettle = async (read, target, before) => {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const start = Date.now();
  let last = read();
  let stableSince = start;
  while (Date.now() - start < 1000) {
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
// Window managers restore asynchronously; a resize issued before they finish can be undone.
const after = (event, action, ms) =>
  new Promise((resolve) => {
    const done = () => { clearTimeout(timer); win.removeListener(event, done); resolve(); };
    const timer = setTimeout(done, ms);
    win.once(event, done);
    action();
  });
let restored;
if (win.isKiosk()) {
  restored = 'kiosk';
  win.setKiosk(false);
}
if (win.isFullScreen()) {
  restored = restored ?? 'fullscreen';
  await after('leave-full-screen', () => win.setFullScreen(false), 2000);
} else if (typeof win.isSimpleFullScreen === 'function' && win.isSimpleFullScreen()) {
  restored = restored ?? 'fullscreen';
  win.setSimpleFullScreen(false);
}
if (win.isMaximized()) {
  restored = restored ?? 'maximized';
  await after('unmaximize', () => win.unmaximize(), 1000);
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
 * keeps reporting the requested outer size after the browser applied (and maybe clamped) it, while
 * the inner size is real from the resize event on; so the outer size is derived from the inner one
 * and a frame measured before this document's first resize.
 */
export const RENDERER_RESIZE_BODY = `
${SETTLE_FN}
const { width, height, content } = arg.request;
const frame = (globalThis.__stagewrightWindowFrame ??= [
  outerWidth - innerWidth,
  outerHeight - innerHeight,
]);
const read = () =>
  content ? [innerWidth, innerHeight] : [innerWidth + frame[0], innerHeight + frame[1]];
const before = read();
const outer = [content ? width + frame[0] : width, content ? height + frame[1] : height];
if (outer[0] !== innerWidth + frame[0] || outer[1] !== innerHeight + frame[1]) {
  await new Promise((resolve) => {
    const done = () => { clearTimeout(timer); removeEventListener('resize', done); resolve(); };
    const timer = setTimeout(done, 1000);
    addEventListener('resize', done);
    window.resizeTo(outer[0], outer[1]);
  });
}
await __swSettle(read, [width, height], before);
return {
  outer: { width: innerWidth + frame[0], height: innerHeight + frame[1] },
  content: { width: innerWidth, height: innerHeight },
  minimum: null,
  maximum: null,
  method: 'renderer',
};
`
