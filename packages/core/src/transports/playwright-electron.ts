/**
 * PlaywrightElectronTransport — the default, uses Playwright's experimental
 * `_electron.launch()` API. Playwright is declared as an OPTIONAL peer
 * dependency, so this module never imports it statically; the SDK is loaded
 * lazily inside `launch()`. Consumers that install `@electron-stagewright/core`
 * without `playwright` can still import the package and inspect the capability
 * matrix; only invoking `launch()` will surface a `TRANSPORT_UNSUPPORTED` error
 * with a clear remediation hint.
 *
 * ## Capability decisions
 *
 * - `canLaunch: true` — Playwright `_electron.launch()` is the primary purpose.
 * - `canAttach: false` — Playwright's `_electron` does NOT expose an attach API
 *   in the published surface; attach is provided by CDPTransport instead. The
 *   capability matrix reflects the upstream API rather than the broader
 *   Stagewright transport contract.
 * - `canInject: false` — Injector is its own transport.
 * - `canIntercept: false` — Network/IPC interception is not exposed through this
 *   transport contract.
 * - `canControlClock: false` — Clock control is not provided by this transport.
 * - `supportsMainEval: true` — `electronApp.evaluate()`.
 * - `supportsRendererEval: true` — `page.evaluate()`.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'

import { StagewrightError } from '../errors/registry.js'
import type {
  AttachOptions,
  ClickOptions,
  ConsoleEntry,
  ConsoleLogsResult,
  ConsoleStream,
  DialogAction,
  DialogEvent,
  DialogEventsOptions,
  DialogEventsResult,
  DialogPolicy,
  DialogType,
  ITransport,
  InjectOptions,
  InteractionOptions,
  IpcChannel,
  LaunchOptions,
  PressOptions,
  ScreenshotOptions,
  ScrollOptions,
  StopOptions,
  TransportCapabilities,
  TransportId,
  TransportSession,
  WindowDescriptor,
  WindowRef,
} from './types.js'

const TRANSPORT_ID: TransportId = 'playwright-electron'

/** Map the transport-neutral interaction options onto Playwright's action options. */
function toActionOptions(opts: InteractionOptions): { force?: boolean; timeout?: number } {
  return {
    ...(opts.force !== undefined ? { force: opts.force } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  }
}

/** Map {@link ClickOptions} onto Playwright's click options (adds button + clickCount). */
function toClickOptions(opts: ClickOptions): {
  force?: boolean
  timeout?: number
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
} {
  return {
    ...toActionOptions(opts),
    ...(opts.button !== undefined ? { button: opts.button } : {}),
    ...(opts.clickCount !== undefined ? { clickCount: opts.clickCount } : {}),
  }
}

/** Map the transport-neutral timeout option onto Playwright APIs that lack `force`. */
function toTimeoutOptions(opts: { readonly timeoutMs?: number }): { timeout?: number } {
  return {
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  }
}

/**
 * Settle delay (ms) before re-reading an element's editable content for the type-effect check.
 * Editors like Monaco process input asynchronously (read + clear their hidden textarea on the
 * input event), so reading immediately can catch a transient pre-clear value; a short settle
 * lets that resolve before we decide whether the type landed.
 */
const TYPE_EFFECT_SETTLE_MS = 10

/**
 * Renderer body returning an element's editable content (a form control's `value`, else its
 * `textContent`), or `null` when the element is absent. Optionally settles first (see
 * {@link TYPE_EFFECT_SETTLE_MS}). Used to verify a type actually landed.
 */
const EDITABLE_SIGNATURE_BODY = `
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
function buildScrollIntoViewBody(): string {
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

/**
 * Local opaque interfaces describing the slice of Playwright's API we use. We
 * avoid `import type { ElectronApplication } from 'playwright'` because the
 * optional peerDep may not be installed at typecheck time on consumer projects.
 */
/** The slice of Playwright's actionability options the interaction methods use. */
interface PWActionOptions {
  force?: boolean
  timeout?: number
}

/** Playwright's click options — actionability plus pointer-button + multi-click. */
interface PWClickOptions extends PWActionOptions {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}

interface PWPage {
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

/** The slice of Playwright's ConsoleMessage we read into a {@link ConsoleEntry}. */
interface PWConsoleMessage {
  type(): string
  text(): string
  location(): { url?: string; lineNumber?: number; columnNumber?: number }
}

/**
 * The slice of Playwright's Dialog we read + resolve. Once a `dialog` listener is
 * attached, Playwright stops auto-dismissing dialogs, so the handler MUST call
 * `accept`/`dismiss` or the renderer hangs.
 */
interface PWDialog {
  type(): string
  message(): string
  defaultValue(): string
  accept(promptText?: string): Promise<void>
  dismiss(): Promise<void>
}

interface PWElectronApp {
  windows(): readonly PWPage[]
  firstWindow(opts?: { timeout?: number }): Promise<PWPage>
  evaluate<T = unknown>(
    fn: (electronApp: unknown, payload: EvalPayload) => unknown,
    arg?: EvalPayload,
  ): Promise<T>
  close(): Promise<void>
  process(): { pid: number | undefined; kill(signal: string): boolean }
}

interface PWElectron {
  launch(opts: {
    executablePath?: string
    args?: readonly string[]
    cwd?: string
    env?: Record<string, string>
    timeout?: number
  }): Promise<PWElectronApp>
}

interface PWModule {
  _electron?: PWElectron
  default?: { _electron?: PWElectron }
}

interface EvalPayload {
  readonly body: string
  readonly arg?: unknown
}

export interface PlaywrightElectronTransportOptions {
  readonly loadElectron?: () => Promise<PWElectron>
}

export interface PlaywrightLaunchOptions {
  readonly executablePath?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Record<string, string>
  readonly timeout?: number
}

async function loadPlaywrightElectron(): Promise<PWElectron> {
  let mod: PWModule
  try {
    mod = (await import('playwright')) as PWModule
  } catch (cause) {
    throw new StagewrightError(
      'TRANSPORT_UNSUPPORTED',
      'Playwright peer dependency is not installed. Install with: pnpm add -D playwright',
      {
        transport: TRANSPORT_ID,
        cause: cause instanceof Error ? cause.message : String(cause),
      },
    )
  }
  const electron = mod._electron ?? mod.default?._electron
  if (!electron) {
    throw new StagewrightError(
      'TRANSPORT_UNSUPPORTED',
      'The installed playwright build does not expose the experimental _electron API. Upgrade to playwright >= 1.49.',
      { transport: TRANSPORT_ID },
    )
  }
  return electron
}

function mergeEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (env === undefined) return undefined
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  return { ...base, ...env }
}

export function buildPlaywrightLaunchOptions(opts: LaunchOptions): PlaywrightLaunchOptions {
  if (opts.appPath === undefined && opts.executablePath === undefined) {
    throw new StagewrightError('BAD_ARGUMENT', 'launch requires appPath or executablePath.', {
      transport: TRANSPORT_ID,
    })
  }

  const args = opts.appPath !== undefined ? [opts.appPath, ...(opts.args ?? [])] : opts.args
  const env = mergeEnv(opts.env)

  return {
    ...(opts.executablePath !== undefined ? { executablePath: opts.executablePath } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  }
}

class PlaywrightSession implements TransportSession {
  public readonly id: string
  public readonly transport: TransportId = TRANSPORT_ID
  public readonly ipc: IpcChannel = { transport: TRANSPORT_ID }
  public readonly console: ConsoleStream = { transport: TRANSPORT_ID }

  private app: PWElectronApp | null
  private disposed = false
  private readonly windowIds = new WeakMap<PWPage, string>()
  private nextWindowId = 0

  /** Max console entries retained; older ones are dropped and counted in `#consoleOverflow`. */
  static readonly #CONSOLE_CAP = 1000
  private readonly consoleBuffer: ConsoleEntry[] = []
  private consoleOverflow = 0

  /** Max dialog events retained; older ones are dropped and counted in `dialogOverflow`. */
  static readonly #DIALOG_CAP = 200
  private readonly dialogBuffer: DialogEvent[] = []
  private dialogOverflow = 0
  /**
   * Active dialog auto-response policy. Defaults to `dismiss` so that — the moment
   * a `dialog` listener is attached (which stops Playwright's own auto-dismiss) —
   * every dialog is still resolved and the renderer never hangs, even before the
   * agent arms anything.
   */
  private dialogPolicy: DialogPolicy = { action: 'dismiss' }

  constructor(app: PWElectronApp, initialPage?: PWPage) {
    this.id = `pw-${randomUUID()}`
    this.app = app
    // Best-effort console + dialog capture from the first window, from launch
    // onward. A failure to attach (no window, dead app) is non-fatal — the
    // buffers simply stay empty. When the caller already resolved the first
    // window (launch does), reuse it so we make no extra firstWindow() call.
    if (initialPage !== undefined) {
      this.attachConsole(initialPage)
      this.attachDialog(initialPage)
    } else {
      void this.attachCapture()
    }
  }

  /** Resolve the first window (when not supplied) and attach the event listeners. */
  private async attachCapture(): Promise<void> {
    try {
      const app = this.app
      if (app === null) return
      const page = await app.firstWindow()
      this.attachConsole(page)
      this.attachDialog(page)
    } catch {
      // Event capture is best-effort; a missing/closed window is not an error.
    }
  }

  /** Attach the console listener to `page` so its messages buffer for `consoleLogs`. */
  private attachConsole(page: PWPage): void {
    page.on('console', (message) => this.pushConsole(message))
  }

  /** Attach the dialog listener to `page` so it auto-responds and buffers events. */
  private attachDialog(page: PWPage): void {
    page.on('dialog', (dialog) => {
      // `handleDialog` is fire-and-forget; a malformed dialog handle (a throwing
      // getter) would otherwise surface as an unhandled rejection and, under Node's
      // default `--unhandled-rejections=throw`, terminate the whole server. Swallow
      // here so one bad dialog can never take down every live session.
      void this.handleDialog(dialog).catch(() => {})
    })
  }

  /** Resolve a native JS dialog per the active policy and record what happened. */
  private async handleDialog(dialog: PWDialog): Promise<void> {
    // Read the dialog's fields BEFORE responding — accept()/dismiss() can
    // invalidate the handle.
    const type = dialog.type()
    const message = dialog.message()
    const defaultValue = dialog.defaultValue()
    const policy = this.dialogPolicy
    const action: DialogAction = policy.perType?.[type as DialogType] ?? policy.action
    const promptText = action === 'accept' && type === 'prompt' ? policy.promptText : undefined

    // A one-shot policy reverts to the safe default after a single dialog, so a
    // lingering `accept` cannot silently confirm a later, unexpected dialog.
    if (policy.oneShot === true) {
      this.dialogPolicy = { action: 'dismiss' }
    }

    try {
      if (action === 'accept') {
        await dialog.accept(promptText)
      } else {
        await dialog.dismiss()
      }
    } catch {
      // The dialog may already be handled or the page may have closed mid-flight;
      // recording the event is still useful for post-mortem, so swallow and fall
      // through to push it.
    }

    this.pushDialog({
      type,
      message,
      action,
      ...(defaultValue !== '' ? { defaultValue } : {}),
      ...(promptText !== undefined ? { promptText } : {}),
      timestamp: Date.now(),
    })
  }

  /** Append a captured dialog event, dropping the oldest when the buffer is full. */
  private pushDialog(entry: DialogEvent): void {
    this.dialogBuffer.push(entry)
    if (this.dialogBuffer.length > PlaywrightSession.#DIALOG_CAP) {
      this.dialogBuffer.shift()
      this.dialogOverflow += 1
    }
  }

  /** Append a captured console message, dropping the oldest when the buffer is full. */
  private pushConsole(message: PWConsoleMessage): void {
    const loc = message.location()
    const entry: ConsoleEntry = {
      type: message.type(),
      text: message.text(),
      timestamp: Date.now(),
      ...(loc.url !== undefined || loc.lineNumber !== undefined
        ? {
            location: {
              ...(loc.url !== undefined ? { url: loc.url } : {}),
              ...(loc.lineNumber !== undefined ? { line: loc.lineNumber } : {}),
              ...(loc.columnNumber !== undefined ? { column: loc.columnNumber } : {}),
            },
          }
        : {}),
    }
    this.consoleBuffer.push(entry)
    if (this.consoleBuffer.length > PlaywrightSession.#CONSOLE_CAP) {
      this.consoleBuffer.shift()
      this.consoleOverflow += 1
    }
  }

  async consoleLogs(): Promise<ConsoleLogsResult> {
    this.requireRunning()
    return { entries: [...this.consoleBuffer], overflowed: this.consoleOverflow }
  }

  async setDialogPolicy(policy: DialogPolicy): Promise<void> {
    this.requireRunning()
    this.dialogPolicy = copyDialogPolicy(policy)
  }

  async dialogEvents(opts: DialogEventsOptions = {}): Promise<DialogEventsResult> {
    this.requireRunning()
    // Snapshot the buffer (a copy) BEFORE an optional clear, so the returned
    // entries survive the flush.
    const result: DialogEventsResult = {
      entries: [...this.dialogBuffer],
      overflowed: this.dialogOverflow,
      policy: copyDialogPolicy(this.dialogPolicy),
    }
    if (opts.clear === true) {
      this.dialogBuffer.length = 0
      this.dialogOverflow = 0
    }
    return result
  }

  private requireRunning(): PWElectronApp {
    if (this.disposed || this.app === null) {
      throw new StagewrightError(
        'NOT_RUNNING',
        'PlaywrightElectronTransport session has been disposed.',
        {
          transport: TRANSPORT_ID,
          sessionId: this.id,
        },
      )
    }
    return this.app
  }

  async evaluate<T = unknown>(
    target: 'main' | 'renderer',
    body: string,
    arg?: unknown,
  ): Promise<T> {
    const app = this.requireRunning()
    const payload: EvalPayload = arg === undefined ? { body } : { body, arg }
    // Playwright serialises a function plus one argument into the target context.
    // Main process receives (electron module namespace, payload); renderer receives
    // (payload). The payload body is still executed dynamically, but the wrapper is
    // actually invoked by Playwright instead of being treated as a passive string.
    //
    // Security note: this transport does NOT validate body content. The dispatcher
    // is responsible for calling validateEvalContent (see errors/operation-type.ts)
    // before invoking this method. Direct callers (tests, application code) that
    // bypass the dispatcher inherit the responsibility for validating untrusted
    // payloads. Prefer structured function serialization at any public API boundary
    // that accepts untrusted JavaScript.
    if (target === 'main') {
      return app.evaluate<T>(
        (electronApp, input) =>
          Function(
            'electronApp',
            'arg',
            `"use strict"; return (async () => { ${input.body} })()`,
          )(electronApp, input.arg),
        payload,
      )
    }
    const page = await app.firstWindow()
    return page.evaluate<T>(
      (input) =>
        Function('arg', `"use strict"; return (async () => { ${input.body} })()`)(input.arg),
      payload,
    )
  }

  async screenshot(target: WindowRef, opts: ScreenshotOptions = {}): Promise<Buffer> {
    const app = this.requireRunning()
    const page = await this.resolveWindow(app, target)
    const playwrightOpts: Parameters<PWPage['screenshot']>[0] = {}
    if (opts.fullPage !== undefined) playwrightOpts.fullPage = opts.fullPage
    if (opts.clip !== undefined) playwrightOpts.clip = opts.clip
    if (opts.format !== undefined) playwrightOpts.type = opts.format
    if (opts.quality !== undefined) playwrightOpts.quality = opts.quality
    return page.screenshot(playwrightOpts)
  }

  async windowsList(): Promise<readonly WindowDescriptor[]> {
    const app = this.requireRunning()
    const pages = app.windows()
    const descriptors: WindowDescriptor[] = []
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]
      if (page === undefined) continue
      const title = await page.title().catch(() => '')
      const url = page.url()
      descriptors.push({
        id: this.idForWindow(page),
        index: i,
        title,
        ...(url ? { url } : {}),
        visible: true,
        focused: i === 0,
      })
    }
    return descriptors
  }

  /** The active window that interaction targets. Playwright's first window. */
  private async activePage(): Promise<PWPage> {
    return this.requireRunning().firstWindow()
  }

  async click(selector: string, opts: ClickOptions = {}): Promise<void> {
    await (await this.activePage()).click(selector, toClickOptions(opts))
  }

  async fill(selector: string, value: string, opts: InteractionOptions = {}): Promise<void> {
    const before = await this.readEditableSignature(selector, 0)
    await (await this.activePage()).fill(selector, value, toActionOptions(opts))
    await this.assertTyped(selector, value, before)
  }

  async hover(selector: string, opts: InteractionOptions = {}): Promise<void> {
    await (await this.activePage()).hover(selector, toActionOptions(opts))
  }

  async press(key: string, opts: PressOptions = {}): Promise<void> {
    const page = await this.activePage()
    if (opts.selector === undefined) {
      await page.keyboard.press(key)
      return
    }
    if (opts.force === true) {
      // Editor-aware path: focus the (possibly offscreen / aria-hidden) selector — focus
      // tolerates non-visible elements — then emit the key globally so editors like Monaco
      // receive it. Avoids page.press' visibility actionability (ELEMENT_NOT_VISIBLE).
      await page.focus(opts.selector, toTimeoutOptions(opts))
      await page.keyboard.press(key)
      return
    }
    await page.press(opts.selector, key, toTimeoutOptions(opts))
  }

  async typeText(text: string, opts: PressOptions = {}): Promise<void> {
    const page = await this.activePage()
    if (opts.selector === undefined) {
      await page.keyboard.type(text)
      return
    }
    if (opts.force === true) {
      // See press(): focus tolerates offscreen / aria-hidden inputs, then type globally. But a
      // focused-yet-inert input (e.g. a modern Monaco editor's hidden textarea, whose real input
      // is an EditContext element) silently swallows the keystrokes — so verify the content
      // actually changed and surface TYPE_NO_EFFECT instead of a false success.
      const before = await this.readEditableSignature(opts.selector, 0)
      await page.focus(opts.selector, toTimeoutOptions(opts))
      await page.keyboard.type(text)
      await this.assertTyped(opts.selector, text, before)
      return
    }
    // page.type focuses the selector and emits a real keystroke per character.
    const before = await this.readEditableSignature(opts.selector, 0)
    await page.type(opts.selector, text, toTimeoutOptions(opts))
    await this.assertTyped(opts.selector, text, before)
  }

  /** Read an element's editable content (value or textContent), or null when absent. */
  private async readEditableSignature(selector: string, settleMs: number): Promise<string | null> {
    return this.evaluate<string | null>('renderer', EDITABLE_SIGNATURE_BODY, { selector, settleMs })
  }

  /**
   * After a fill/type, confirm the text landed: the editable content changed, or already equals
   * the typed text (an idempotent re-fill). When non-empty text leaves the content unchanged and
   * not equal to it, the target ignored the input — throw `TYPE_NO_EFFECT`.
   *
   * Deliberately errs toward NOT throwing — a missed swallow is cheaper than a false rejection
   * that blocks a type that actually worked:
   * - empty text is a no-op (clearing / typing nothing is a legitimate no-change);
   * - an unreadable signature (`null`: the element is gone, or not reachable via
   *   `document.querySelector` — e.g. inside a shadow root Playwright pierced but our eval cannot)
   *   skips the check rather than risk a spurious failure;
   * - an editor whose model updates asynchronously gets {@link TYPE_EFFECT_SETTLE_MS} to settle
   *   before the re-read. A model slower than that settle is the residual false-negative this
   *   check accepts to keep the common (synchronous) case honest.
   */
  private async assertTyped(selector: string, text: string, before: string | null): Promise<void> {
    if (text.length === 0) return
    const after = await this.readEditableSignature(selector, TYPE_EFFECT_SETTLE_MS)
    if (after === null) return
    const landed = after !== before || after === text
    if (!landed) {
      throw new StagewrightError(
        'TYPE_NO_EFFECT',
        `Text did not land in "${selector}": its editable content did not change. The target ` +
          "likely ignores input routed to it (a code editor's hidden textarea). Click the " +
          'editor content area, then type into the active element with no selector.',
        { selector },
      )
    }
  }

  async selectOption(
    selector: string,
    values: readonly string[],
    opts: InteractionOptions = {},
  ): Promise<readonly string[]> {
    return (await this.activePage()).selectOption(selector, values, toActionOptions(opts))
  }

  async setChecked(
    selector: string,
    checked: boolean,
    opts: InteractionOptions = {},
  ): Promise<void> {
    const page = await this.activePage()
    if (checked) {
      await page.check(selector, toActionOptions(opts))
    } else {
      await page.uncheck(selector, toActionOptions(opts))
    }
  }

  async setInputFiles(
    selector: string,
    paths: readonly string[],
    opts: InteractionOptions = {},
  ): Promise<void> {
    await (await this.activePage()).setInputFiles(selector, paths, toTimeoutOptions(opts))
  }

  async dragTo(source: string, target: string, opts: InteractionOptions = {}): Promise<void> {
    await (await this.activePage()).dragAndDrop(source, target, toActionOptions(opts))
  }

  async scroll(opts: ScrollOptions = {}): Promise<void> {
    const page = await this.activePage()
    if (opts.selector !== undefined) {
      // Scroll the element into view via the renderer; avoids needing a separate
      // Playwright locator API in the minimal page surface. The body reports
      // whether the element was found so a no-match surfaces as SELECTOR_NO_MATCH
      // instead of resolving silently — every other interaction method rejects on
      // a missing target, and scroll must not diverge or the tool layer would
      // report a phantom success it cannot diagnose.
      const found = await page.evaluate<boolean>(
        (input) =>
          Function('arg', `"use strict"; return (async () => { ${input.body} })()`)(input.arg),
        {
          body: buildScrollIntoViewBody(),
          arg: { selector: opts.selector, timeoutMs: opts.timeoutMs },
        },
      )
      if (!found) {
        throw new StagewrightError(
          'SELECTOR_NO_MATCH',
          `scroll target "${opts.selector}" matched no element.`,
          { transport: TRANSPORT_ID, selector: opts.selector },
        )
      }
      return
    }
    await page.mouse.wheel(opts.dx ?? 0, opts.dy ?? 0)
  }

  private async resolveWindow(app: PWElectronApp, ref: WindowRef): Promise<PWPage> {
    const pages = app.windows()
    if (pages.length === 0) {
      throw new StagewrightError('REF_NOT_FOUND', 'No windows are open in the Electron app.', {
        transport: TRANSPORT_ID,
        ref,
      })
    }
    if (ref.kind === 'index') {
      const page = pages[ref.index]
      if (page === undefined) {
        throw new StagewrightError(
          'REF_NOT_FOUND',
          `Window index ${ref.index} is out of range (have ${pages.length} windows).`,
          { transport: TRANSPORT_ID, ref },
        )
      }
      return page
    }
    if (ref.kind === 'title') {
      const matcher =
        ref.pattern instanceof RegExp ? ref.pattern : new RegExp(`^${escapeRegex(ref.pattern)}$`)
      for (const page of pages) {
        const title = await page.title().catch(() => '')
        if (matcher.test(title)) return page
      }
      throw new StagewrightError(
        'REF_NOT_FOUND',
        `No window matched title pattern ${String(ref.pattern)}.`,
        { transport: TRANSPORT_ID, ref },
      )
    }
    for (const page of pages) {
      if (this.idForWindow(page) === ref.id) {
        return page
      }
    }
    throw new StagewrightError(
      'REF_NOT_FOUND',
      `Window id "${ref.id}" was not produced by this session.`,
      { transport: TRANSPORT_ID, ref },
    )
  }

  private idForWindow(page: PWPage): string {
    const existing = this.windowIds.get(page)
    if (existing !== undefined) return existing
    const id = `${this.id}-window-${this.nextWindowId}`
    this.nextWindowId += 1
    this.windowIds.set(page, id)
    return id
  }

  async dispose(): Promise<void> {
    // Idempotent — second and subsequent calls are no-ops, never throw.
    if (this.disposed) return
    this.disposed = true
    const app = this.app
    this.app = null
    if (app === null) return
    try {
      await app.close()
    } catch {
      // Closing twice or against a dead process is a benign condition during
      // shutdown. Swallow so callers can `dispose()` defensively.
    }
  }

  async forceKill(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const app = this.app
    this.app = null
    if (app === null) return

    try {
      app.process().kill('SIGKILL')
    } catch {
      // If the process is already gone, app.close() below still releases any
      // remaining Playwright-side resources.
    }
    try {
      await app.close()
    } catch {
      // A killed process can make Playwright close() reject. Force-kill should
      // remain best-effort and idempotent.
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function copyDialogPolicy(policy: DialogPolicy): DialogPolicy {
  return {
    action: policy.action,
    ...(policy.promptText !== undefined ? { promptText: policy.promptText } : {}),
    ...(policy.perType !== undefined ? { perType: { ...policy.perType } } : {}),
    ...(policy.oneShot !== undefined ? { oneShot: policy.oneShot } : {}),
  }
}

export class PlaywrightElectronTransport implements ITransport {
  public readonly id: TransportId = TRANSPORT_ID
  private readonly loadElectron: () => Promise<PWElectron>

  constructor(opts: PlaywrightElectronTransportOptions = {}) {
    this.loadElectron = opts.loadElectron ?? loadPlaywrightElectron
  }

  public readonly capabilities: TransportCapabilities = {
    canLaunch: true,
    // Playwright's _electron does not expose an attach API in its public
    // surface. Attach is provided by CDPTransport.
    canAttach: false,
    canInject: false,
    canIntercept: false,
    canControlClock: false,
    supportsMainEval: true,
    supportsRendererEval: true,
    supportsInteraction: true,
  }

  async launch(opts: LaunchOptions): Promise<TransportSession> {
    const electron = await this.loadElectron()
    const launchOpts = buildPlaywrightLaunchOptions(opts)
    let app: PWElectronApp
    try {
      app = await electron.launch(launchOpts)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const isTimeout = /timeout/i.test(message)
      throw new StagewrightError(
        isTimeout ? 'LAUNCH_TIMEOUT' : 'INTERNAL_ERROR',
        `Playwright launch failed: ${message}`,
        { transport: TRANSPORT_ID, appPath: opts.appPath ?? opts.executablePath ?? '' },
      )
    }
    let initialPage: PWPage
    try {
      initialPage = await app.firstWindow(
        opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : undefined,
      )
    } catch (cause) {
      try {
        await app.close()
      } catch {
        // A failed launch can leave the app half-open; closing is best-effort.
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      const isTimeout = /timeout/i.test(message)
      throw new StagewrightError(
        isTimeout ? 'LAUNCH_TIMEOUT' : 'INTERNAL_ERROR',
        `Playwright did not report an initial window: ${message}`,
        { transport: TRANSPORT_ID, appPath: opts.appPath ?? opts.executablePath ?? '' },
      )
    }
    // Reuse the window we already awaited for console capture, so launch makes a
    // single firstWindow() call rather than one here and one in the session.
    return new PlaywrightSession(app, initialPage)
  }

  attach(_opts: AttachOptions): Promise<TransportSession> {
    return Promise.reject(
      new StagewrightError(
        'TRANSPORT_UNSUPPORTED',
        'PlaywrightElectronTransport does not support attach; use CDPTransport for attach-to-running.',
        { transport: TRANSPORT_ID, capability: 'canAttach' },
      ),
    )
  }

  inject(_opts: InjectOptions): Promise<TransportSession> {
    return Promise.reject(
      new StagewrightError(
        'TRANSPORT_UNSUPPORTED',
        'PlaywrightElectronTransport does not support inject; use InjectorTransport.',
        { transport: TRANSPORT_ID, capability: 'canInject' },
      ),
    )
  }

  async stop(session: TransportSession, _opts?: StopOptions): Promise<void> {
    await session.dispose()
  }

  async forceKill(session: TransportSession): Promise<void> {
    if (session instanceof PlaywrightSession) {
      await session.forceKill()
      return
    }
    await session.dispose()
  }
}
