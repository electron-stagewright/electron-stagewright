/**
 * Transport abstraction — the single contract every tool dispatches through.
 *
 * Three implementations sit behind this contract: PlaywrightElectronTransport
 * (default, uses Playwright's experimental _electron API), CDPTransport (raw
 * Chrome DevTools Protocol, deferred implementation), and InjectorTransport
 * (Node Inspector injection into a running process, deferred implementation).
 * Each transport declares a capability matrix at load time so the dispatcher
 * refuses unsupported operations with a registered error code from the central
 * registry instead of crashing into the underlying SDK.
 *
 * @module
 */

/** Identifier for each concrete transport implementation. */
export type TransportId = 'playwright-electron' | 'cdp' | 'injector'

/** Opaque session identifier — generated at launch/attach time. */
export type SessionId = string

/**
 * What a given transport can do. Inspected by the dispatcher BEFORE invoking any
 * method, so tools that need capabilities the active transport lacks are refused
 * at boot time (or at the first call) with a clear `TRANSPORT_UNSUPPORTED`
 * error rather than crashing partway through the SDK.
 */
export interface TransportCapabilities {
  /** The transport can spawn an Electron app from an executable path. */
  readonly canLaunch: boolean
  /** The transport can attach to an Electron process that is already running. */
  readonly canAttach: boolean
  /** The transport can inject a debugger into a running process that did not start with one. */
  readonly canInject: boolean
  /** The transport can intercept and modify network or IPC traffic mid-flight. */
  readonly canIntercept: boolean
  /** The transport can install a synthetic clock for time-based testing. */
  readonly canControlClock: boolean
  /** The transport can evaluate JavaScript in the main process context. */
  readonly supportsMainEval: boolean
  /** The transport can evaluate JavaScript in a renderer (BrowserWindow) context. */
  readonly supportsRendererEval: boolean
  /**
   * The transport can perform real user input (click, type, hover, drag, …) on a
   * renderer element. Drives the `electron_*` interaction tools; a transport that
   * declares this `false` rejects those methods with `NOT_IMPLEMENTED`.
   */
  readonly supportsInteraction: boolean
}

/**
 * Discriminated reference to a window. Each kind resolves differently:
 *
 * - `'index'`: position in the Electron app's BrowserWindow list (0-based).
 * - `'title'`: matches `window.document.title` — string for equality, RegExp for pattern.
 * - `'id'`: matches the transport-specific window identifier (CDP targetId, Playwright
 *   `Page` `_guid`, etc.).
 */
export type WindowRef =
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'title'; readonly pattern: string | RegExp }
  | { readonly kind: 'id'; readonly id: string }

/** Snapshot of one Electron window, returned by `TransportSession.windowsList()`. */
export interface WindowDescriptor {
  readonly id: string
  readonly index: number
  readonly title: string
  readonly url?: string
  readonly visible: boolean
  readonly focused: boolean
}

/** Options accepted by `ITransport.launch`. */
export interface LaunchOptions {
  /**
   * Absolute path to the app's main-process JavaScript entry. For Playwright's
   * Electron driver this is passed as the first command-line argument, not as
   * `executablePath`.
   */
  readonly appPath?: string
  /** Electron executable or packaged app binary to launch. Defaults to Playwright's bundled Electron. */
  readonly executablePath?: string
  /** Extra arguments appended after `appPath` when present. */
  readonly args?: readonly string[]
  /** Environment variables to set in the spawned Electron process. */
  readonly env?: Readonly<Record<string, string>>
  /** Working directory for the spawned process. Defaults to the parent process cwd. */
  readonly cwd?: string
  /** Maximum time to wait for the first window to appear. */
  readonly timeoutMs?: number
}

/** Options accepted by `ITransport.attach`. At least one identifier MUST be provided. */
export interface AttachOptions {
  /** Process ID of the running Electron app. */
  readonly pid?: number
  /** Full Chrome DevTools Protocol URL (e.g. `ws://localhost:9222/devtools/browser/...`). */
  readonly cdpUrl?: string
  /** CDP port (the transport resolves the browser endpoint from `/json/version`). */
  readonly port?: number
  /** Host name when using `port`. Defaults to `localhost`. */
  readonly host?: string
  /** Maximum time to wait for the attach handshake. */
  readonly timeoutMs?: number
}

/** Options accepted by `ITransport.inject`. */
export interface InjectOptions {
  /** Process ID of the running Electron app to inject the Node Inspector into. */
  readonly pid: number
  /** Maximum time to wait for the inspector handshake. */
  readonly timeoutMs?: number
}

/** Options accepted by `ITransport.stop`. */
export interface StopOptions {
  /** Maximum time to wait for graceful shutdown before falling back to forceKill. */
  readonly timeoutMs?: number
  /** Skip graceful shutdown entirely and SIGKILL the process. */
  readonly force?: boolean
}

/** Options accepted by `TransportSession.screenshot`. */
export interface ScreenshotOptions {
  /** Capture the full scrollable page rather than just the viewport. */
  readonly fullPage?: boolean
  /** Restrict the capture to a rectangle in CSS pixels. */
  readonly clip?: { x: number; y: number; width: number; height: number }
  /** Output image format. Defaults to `'png'`. */
  readonly format?: 'png' | 'jpeg'
  /** JPEG quality (0-100). Ignored when format is `'png'`. */
  readonly quality?: number
}

/**
 * IPC observation/injection surface for a session. Minimal placeholder shape for
 * transports that can surface IPC channels; concrete IPC tools can extend this
 * contract without changing session ownership.
 */
export interface IpcChannel {
  /** Which transport produced this channel. */
  readonly transport: TransportId
}

/**
 * Rolling console buffer surface for a session. Minimal placeholder shape for
 * transports that can surface console output; concrete log tools can extend this
 * contract without changing session ownership.
 */
export interface ConsoleStream {
  /** Which transport produced this stream. */
  readonly transport: TransportId
}

/**
 * One captured console message from the app's renderer, in the rolling per-session
 * buffer read by `TransportSession.consoleLogs`. All fields are JSON-serialisable.
 */
export interface ConsoleEntry {
  /** Console level reported by the renderer (`'log'`, `'info'`, `'warning'`, `'error'`, `'debug'`, …). */
  readonly type: string
  /** The message text. */
  readonly text: string
  /** Epoch milliseconds when the message was captured by the server. */
  readonly timestamp: number
  /** Source location, when the renderer reports one. */
  readonly location?: {
    readonly url?: string
    readonly line?: number
    readonly column?: number
  }
}

/**
 * Result of reading a session's console buffer. `entries` is the retained tail
 * (oldest first); `overflowed` is the number of older entries the capped ring
 * dropped, so an agent knows the view is incomplete.
 */
export interface ConsoleLogsResult {
  readonly entries: readonly ConsoleEntry[]
  readonly overflowed: number
}

/** How the dialog auto-responder resolves a native JS dialog. */
export type DialogAction = 'accept' | 'dismiss'

/** The kinds of native JS dialog an Electron renderer can raise. */
export type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

/**
 * The auto-response policy for native JS dialogs (`alert` / `confirm` / `prompt` /
 * `beforeunload`). These dialogs block the renderer until something answers, so
 * there is no time to round-trip to the agent — the session applies this policy
 * the instant a dialog fires. The policy is forward-looking: it governs the next
 * dialog onward and never retroactively changes an already-handled dialog.
 */
export interface DialogPolicy {
  /** Default action for any dialog without a more specific {@link DialogPolicy.perType} entry. */
  readonly action: DialogAction
  /** Text submitted to a `prompt()` dialog when its effective action is `accept`; ignored otherwise. */
  readonly promptText?: string
  /**
   * Per-type overrides (e.g. accept `confirm` but dismiss `beforeunload`). A type
   * absent from this map falls back to {@link DialogPolicy.action}.
   */
  readonly perType?: Partial<Record<DialogType, DialogAction>>
  /**
   * When true, the policy resolves exactly ONE dialog and then reverts to the safe
   * `dismiss` default. Prevents a lingering `accept` from silently confirming a
   * later, unexpected (possibly destructive) dialog.
   */
  readonly oneShot?: boolean
}

/**
 * One observed native JS dialog, recorded in the per-session ring buffer AFTER the
 * auto-responder resolved it. All fields are JSON-serialisable.
 */
export interface DialogEvent {
  /** Dialog kind reported by the renderer (`'alert'`/`'confirm'`/`'prompt'`/`'beforeunload'`, …). */
  readonly type: string
  /** The dialog's message text. */
  readonly message: string
  /** How the auto-responder resolved this dialog. */
  readonly action: DialogAction
  /** The `prompt()` default value, when the renderer supplied a non-empty one. */
  readonly defaultValue?: string
  /** The text submitted to a `prompt()` accept, when any. */
  readonly promptText?: string
  /** Epoch milliseconds when the dialog was captured by the server. */
  readonly timestamp: number
}

/** Options for {@link TransportSession.dialogEvents}. */
export interface DialogEventsOptions {
  /** When true, flush the entire dialog buffer (and overflow counter) AFTER reading it. */
  readonly clear?: boolean
}

/**
 * Result of reading a session's dialog buffer. `entries` is the retained tail
 * (oldest first); `overflowed` is the number of older entries the capped ring
 * dropped; `policy` is the auto-response policy currently in effect.
 */
export interface DialogEventsResult {
  readonly entries: readonly DialogEvent[]
  readonly overflowed: number
  readonly policy: DialogPolicy
}

/**
 * Common options for interaction methods. `selector` is a CSS or text selector
 * the tool layer has already resolved (a snapshot `ref` becomes
 * `[data-sw-ref="<ref>"]` before reaching the transport).
 */
export interface InteractionOptions {
  /**
   * Bypass actionability checks (visibility, enabled, stable, receives-events).
   * Default false — the transport waits for the element to be actionable and
   * surfaces a failure the tool maps to `ELEMENT_DISABLED` / `ELEMENT_NOT_VISIBLE`.
   */
  readonly force?: boolean
  /** Max wait for the element to become actionable, in ms. */
  readonly timeoutMs?: number
}

/** Options for {@link TransportSession.press} and {@link TransportSession.typeText}. */
export interface PressOptions {
  /** When set, focus this element before pressing the key / typing; otherwise act globally. */
  readonly selector?: string
  /**
   * Bypass actionability checks on `selector` (visibility/stability). Default false. Set
   * true to type into intentionally offscreen / aria-hidden inputs such as a code editor's
   * hidden textarea (e.g. Monaco), which a normal visibility-gated type would reject with
   * `ELEMENT_NOT_VISIBLE`. No effect when `selector` is absent (global keystrokes).
   */
  readonly force?: boolean
  /** Max wait for the element to receive the key / text, in ms. */
  readonly timeoutMs?: number
}

/**
 * Options for {@link TransportSession.click}. Extends the common actionability
 * options with pointer-button selection and multi-click support, so one `click`
 * method covers right-click (context menus) and double-click (click-to-edit)
 * without separate transport methods.
 */
export interface ClickOptions extends InteractionOptions {
  /** Which mouse button to use. Defaults to `'left'`. */
  readonly button?: 'left' | 'right' | 'middle'
  /** Number of sequential clicks (2 for a double-click). Defaults to 1; must be a positive integer. */
  readonly clickCount?: number
}

/** Options for {@link TransportSession.scroll}. */
export interface ScrollOptions {
  /** When set, scroll this element into view (centred). */
  readonly selector?: string
  /** Horizontal wheel delta in CSS pixels (used when `selector` is omitted). */
  readonly dx?: number
  /** Vertical wheel delta in CSS pixels (used when `selector` is omitted). */
  readonly dy?: number
  /** Max wait for the element, in ms. */
  readonly timeoutMs?: number
}

/**
 * A live session against an Electron app, returned by `launch`, `attach`, or
 * `inject`. Disposal is idempotent: calling `dispose()` twice MUST NOT throw,
 * and MUST NOT double-free underlying resources.
 */
export interface TransportSession {
  readonly id: SessionId
  readonly transport: TransportId

  /** Evaluate a JavaScript body in the main process or a renderer. */
  evaluate<T = unknown>(target: 'main' | 'renderer', body: string, arg?: unknown): Promise<T>

  /** Capture a screenshot of the given window. */
  screenshot(target: WindowRef, opts?: ScreenshotOptions): Promise<Buffer>

  /** Enumerate the current windows. */
  windowsList(): Promise<readonly WindowDescriptor[]>

  /** Read the session's rolling console buffer (oldest first) plus the dropped-entry count. */
  consoleLogs(): Promise<ConsoleLogsResult>

  /**
   * Arm the auto-responder for native JS dialogs. The policy takes effect for the
   * NEXT dialog onward; it does not retroactively change already-handled dialogs.
   */
  setDialogPolicy(policy: DialogPolicy): Promise<void>

  /**
   * Read the captured dialog events (oldest first), the dropped-entry count, and
   * the active policy. Pass `{ clear: true }` to flush the buffer after reading.
   */
  dialogEvents(opts?: DialogEventsOptions): Promise<DialogEventsResult>

  // --- Interaction surface (requires `capabilities.supportsInteraction`) ---
  // All operate on the active/default window with real user input. Transports
  // that cannot interact reject these with `NOT_IMPLEMENTED`.

  /** Click an element matched by `selector`. Supports button + multi-click via {@link ClickOptions}. */
  click(selector: string, opts?: ClickOptions): Promise<void>

  /** Set the value of a text input / textarea matched by `selector` (fires input events). */
  fill(selector: string, value: string, opts?: InteractionOptions): Promise<void>

  /** Hover the element matched by `selector`. */
  hover(selector: string, opts?: InteractionOptions): Promise<void>

  /** Press a key (e.g. `'Enter'`, `'Control+A'`); focuses `opts.selector` first when given. */
  press(key: string, opts?: PressOptions): Promise<void>

  /**
   * Type `text` as real per-character keystrokes (fires keydown/keypress/input/keyup
   * for each char), unlike {@link fill} which sets `.value` and fires a single input
   * event. Focuses `opts.selector` first when given; otherwise types into the active
   * element. Use this for inputs with per-keystroke handlers (editors, autocompletes).
   */
  typeText(text: string, opts?: PressOptions): Promise<void>

  /** Select option(s) by value in a `<select>` matched by `selector`. Returns the selected values. */
  selectOption(
    selector: string,
    values: readonly string[],
    opts?: InteractionOptions,
  ): Promise<readonly string[]>

  /** Check or uncheck a checkbox / radio matched by `selector`. */
  setChecked(selector: string, checked: boolean, opts?: InteractionOptions): Promise<void>

  /** Set the files of a file input matched by `selector` (absolute paths). */
  setInputFiles(
    selector: string,
    paths: readonly string[],
    opts?: InteractionOptions,
  ): Promise<void>

  /** Drag the element matched by `source` onto the element matched by `target`. */
  dragTo(source: string, target: string, opts?: InteractionOptions): Promise<void>

  /** Scroll an element into view (`opts.selector`) or the page by a wheel delta (`dx`/`dy`). */
  scroll(opts: ScrollOptions): Promise<void>

  readonly ipc: IpcChannel
  readonly console: ConsoleStream

  /**
   * Release session resources. Safe to call multiple times — the second and
   * subsequent invocations are no-ops. After dispose, every other method on
   * this session MUST throw `NOT_RUNNING`.
   */
  dispose(): Promise<void>
}

/**
 * The single contract every tool dispatches through. Three concrete
 * implementations exist: PlaywrightElectronTransport, CDPTransport,
 * InjectorTransport.
 */
export interface ITransport {
  readonly id: TransportId
  readonly capabilities: TransportCapabilities

  /** Spawn a new Electron app. */
  launch(opts: LaunchOptions): Promise<TransportSession>

  /** Connect to an already-running Electron app exposing a debug port. */
  attach(opts: AttachOptions): Promise<TransportSession>

  /** Inject a Node Inspector into a running Electron process that lacks one. */
  inject(opts: InjectOptions): Promise<TransportSession>

  /** Gracefully shut down the session. */
  stop(session: TransportSession, opts?: StopOptions): Promise<void>

  /** Forcefully kill the underlying process and release the session. */
  forceKill(session: TransportSession): Promise<void>
}
