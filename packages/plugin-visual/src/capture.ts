/** Fixed renderer preparation for a stable visual capture. */

export type AnimationMode = 'disabled' | 'allow'
export type CaretMode = 'hide' | 'initial'

export interface CapturePreparationRequest {
  readonly token: string
  readonly animations: AnimationMode
  readonly caret: CaretMode
  readonly style?: string
  readonly masks: readonly string[]
  readonly settleMs: number
}

export interface RendererEnvironment {
  readonly electronVersion: string
  readonly userAgent: string
  readonly viewport: { readonly width: number; readonly height: number }
  readonly devicePixelRatio: number
  readonly colorScheme: 'dark' | 'light' | 'no-preference'
  readonly locale: string
}

export type CapturePreparationResult =
  | {
      readonly kind: 'prepared'
      readonly environment: RendererEnvironment
      readonly masksTruncated: boolean
    }
  | { readonly kind: 'invalid_selector'; readonly selector: string; readonly message: string }
  | { readonly kind: 'unstable' }

/**
 * Install temporary fixed CSS and bounded mask overlays, then wait for two
 * animation frames plus the caller's bounded settle interval. The only caller
 * input interpreted as selectors or CSS is kept in a temporary style element;
 * no agent JavaScript reaches the renderer.
 */
export const PREPARE_CAPTURE_BODY = `
const input = arg;
const key = Symbol.for('electron-stagewright.visual.capture-preparation');
const entries = globalThis[key] instanceof Map ? globalThis[key] : new Map();
globalThis[key] = entries;
const remove = (entry) => {
  entry.style?.remove();
  for (const mask of entry.masks) mask.remove();
};
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const measure = () => ({
  width: window.innerWidth,
  height: window.innerHeight,
  scrollWidth: document.documentElement.scrollWidth,
  scrollHeight: document.documentElement.scrollHeight,
  dpr: window.devicePixelRatio,
});
const before = measure();
const entry = { style: undefined, masks: [] };
try {
  const style = document.createElement('style');
  const rules = [];
  if (input.animations === 'disabled') {
    rules.push('*, *::before, *::after { animation: none !important; transition: none !important; }');
  }
  if (input.caret === 'hide') rules.push('* { caret-color: transparent !important; }');
  if (typeof input.style === 'string' && input.style.length > 0) rules.push(input.style);
  style.textContent = rules.join('\\n');
  (document.head || document.documentElement).append(style);
  entry.style = style;

  let masksTruncated = false;
  for (const selector of input.masks) {
    let matches;
    try {
      matches = document.querySelectorAll(selector);
    } catch (error) {
      remove(entry);
      return { kind: 'invalid_selector', selector, message: error instanceof Error ? error.message : String(error) };
    }
    for (const element of matches) {
      if (entry.masks.length >= 100) {
        masksTruncated = true;
        break;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const mask = document.createElement('div');
      mask.setAttribute('aria-hidden', 'true');
      Object.assign(mask.style, {
        position: 'absolute',
        left: (rect.left + window.scrollX) + 'px',
        top: (rect.top + window.scrollY) + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
        background: '#ff00ff',
        pointerEvents: 'none',
        zIndex: '2147483647',
      });
      document.body.append(mask);
      entry.masks.push(mask);
    }
    if (masksTruncated) break;
  }

  await nextFrame();
  if (input.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, input.settleMs));
  await nextFrame();
  const after = measure();
  if (before.width !== after.width || before.height !== after.height || before.scrollWidth !== after.scrollWidth || before.scrollHeight !== after.scrollHeight || before.dpr !== after.dpr) {
    remove(entry);
    return { kind: 'unstable' };
  }
  entries.set(input.token, entry);
  const userAgent = String(navigator.userAgent).slice(0, 1024);
  const electron = /Electron\\/([^\\s]+)/.exec(userAgent)?.[1] ?? 'unknown';
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'no-preference';
  return {
    kind: 'prepared',
    masksTruncated,
    environment: {
      electronVersion: electron,
      userAgent,
      viewport: { width: after.width, height: after.height },
      devicePixelRatio: after.dpr,
      colorScheme,
      locale: String(navigator.language || 'und'),
    },
  };
} catch (error) {
  remove(entry);
  throw error;
}
`

/** Remove the temporary capture preparation, if the renderer is still alive. */
export const CLEANUP_CAPTURE_BODY = `
const key = Symbol.for('electron-stagewright.visual.capture-preparation');
const entries = globalThis[key];
const entry = entries instanceof Map ? entries.get(arg) : undefined;
if (entry !== undefined) {
  entry.style?.remove();
  for (const mask of entry.masks) mask.remove();
  entries.delete(arg);
}
return { cleaned: entry !== undefined };
`
