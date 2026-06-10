/**
 * Minimal structural type shims for the slice of Playwright's experimental
 * `_electron` API that {@link PlaywrightElectronTransport} depends on.
 *
 * We deliberately avoid `import type { ElectronApplication } from 'playwright'`:
 * Playwright is an OPTIONAL peer dependency, so it may not be installed at
 * typecheck time on a consumer project. These hand-written interfaces describe
 * only the methods we actually call, keeping the transport importable (and the
 * capability matrix inspectable) without the peer present.
 *
 * Pure compile-time declarations — no runtime footprint.
 *
 * @module
 */

import type { ScreenshotOptions } from './types.js'

/** A renderer/main `evaluate` payload: a function-body string plus an optional argument. */
export interface EvalPayload {
  readonly body: string
  readonly arg?: unknown
}

/** The slice of Playwright's actionability options the interaction methods use. */
export interface PWActionOptions {
  force?: boolean
  timeout?: number
}

/** Playwright's click options — actionability plus pointer-button + multi-click. */
export interface PWClickOptions extends PWActionOptions {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}

/** The slice of Playwright's `Page` surface the transport drives. */
export interface PWPage {
  url(): string
  title(): Promise<string>
  evaluate<T = unknown>(fn: (payload: EvalPayload) => unknown, arg?: EvalPayload): Promise<T>
  screenshot(opts?: {
    fullPage?: boolean
    clip?: ScreenshotOptions['clip']
    type?: 'png' | 'jpeg'
    quality?: number
  }): Promise<Buffer>
  isVisible(selector: string): Promise<boolean>
  // focus() waits only for the element to be ATTACHED, not visible (hence no `force`
  // option in Playwright) — so it can focus an intentionally offscreen / aria-hidden
  // input that press()/type() would reject on their visibility actionability.
  focus(selector: string, opts?: { timeout?: number }): Promise<void>
  click(selector: string, opts?: PWClickOptions): Promise<void>
  fill(selector: string, value: string, opts?: PWActionOptions): Promise<void>
  hover(selector: string, opts?: PWActionOptions): Promise<void>
  press(selector: string, key: string, opts?: PWActionOptions): Promise<void>
  type(selector: string, text: string, opts?: PWActionOptions): Promise<void>
  selectOption(
    selector: string,
    values: readonly string[],
    opts?: PWActionOptions,
  ): Promise<readonly string[]>
  check(selector: string, opts?: PWActionOptions): Promise<void>
  uncheck(selector: string, opts?: PWActionOptions): Promise<void>
  setInputFiles(selector: string, files: readonly string[], opts?: PWActionOptions): Promise<void>
  dragAndDrop(source: string, target: string, opts?: PWActionOptions): Promise<void>
  keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> }
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> }
  on(event: 'console', handler: (message: PWConsoleMessage) => void): void
  on(event: 'dialog', handler: (dialog: PWDialog) => void): void
}

/** The slice of Playwright's `ConsoleMessage` we read into a `ConsoleEntry`. */
export interface PWConsoleMessage {
  type(): string
  text(): string
  location(): { url?: string; lineNumber?: number; columnNumber?: number }
}

/**
 * The slice of Playwright's `Dialog` we read + resolve. Once a `dialog` listener is
 * attached, Playwright stops auto-dismissing dialogs, so the handler MUST call
 * `accept`/`dismiss` or the renderer hangs.
 */
export interface PWDialog {
  type(): string
  message(): string
  defaultValue(): string
  accept(promptText?: string): Promise<void>
  dismiss(): Promise<void>
}

/** The slice of Playwright's `ElectronApplication` (the launched app handle) we use. */
export interface PWElectronApp {
  windows(): readonly PWPage[]
  firstWindow(opts?: { timeout?: number }): Promise<PWPage>
  evaluate<T = unknown>(
    fn: (electronApp: unknown, payload: EvalPayload) => unknown,
    arg?: EvalPayload,
  ): Promise<T>
  close(): Promise<void>
  process(): { pid: number | undefined; kill(signal: string): boolean }
}

/** The experimental `_electron` namespace entry point: `_electron.launch()`. */
export interface PWElectron {
  launch(opts: {
    executablePath?: string
    args?: readonly string[]
    cwd?: string
    env?: Record<string, string>
    timeout?: number
  }): Promise<PWElectronApp>
}

/** The shape of the dynamically-imported `playwright` module, probing for `_electron`. */
export interface PWModule {
  _electron?: PWElectron
  default?: { _electron?: PWElectron }
}
