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
  /**
   * The transport can observe and/or intercept network traffic through the transport seam. The first
   * consumer is observe-only network capture; request/response mutation can build on the same flag
   * when a stubbing seam exists.
   */
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
  /** Process ID of the running Electron app, used for ownership checks and stop escalation. */
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
  /**
   * Maximum time to wait for graceful shutdown before escalating to a SIGKILL.
   * Transports default this to a bounded budget (10s for the Playwright
   * transport) so a hung app can never wedge a stop indefinitely.
   */
  readonly timeoutMs?: number
  /** Skip graceful shutdown entirely and SIGKILL the process. */
  readonly force?: boolean
}

/**
 * Result of `ITransport.stop`. `escalated: true` means the graceful close did
 * not finish within its budget and the transport force-killed the process
 * instead — the session is still fully released either way, so the caller
 * never inherits an orphaned process with no handle to it.
 */
export interface StopResult {
  /** True when graceful shutdown timed out and the process was SIGKILLed. */
  readonly escalated: boolean
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
  /**
   * Transport-scoped id of the window that emitted this message (matches
   * `WindowDescriptor.id`). Present when capture is attached per-window, so an
   * aggregated multi-window buffer stays attributable.
   */
  readonly windowId?: string
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
  /**
   * Transport-scoped id of the window that raised this dialog (matches
   * `WindowDescriptor.id`). Present when capture is attached per-window.
   */
  readonly windowId?: string
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
 * The capture filter armed by {@link TransportSession.startNetworkCapture}. Capture is opt-in and
 * bounded to an explicit URL allowlist — there is no capture-everything — so a careless arm cannot
 * silently record the whole app's traffic. All fields are JSON-serialisable.
 */
export interface NetworkCaptureFilter {
  /**
   * URL substrings to capture (an allowlist — at least one is required). A request is recorded when
   * its full URL CONTAINS any entry, e.g. `['/api/', 'auth.example.com']`. Substring rather than glob
   * keeps the semantics predictable and transport-neutral.
   */
  readonly urls: readonly string[]
  /**
   * Optional HTTP-method allowlist (case-insensitive, e.g. `['GET', 'POST']`). When omitted or empty,
   * every method whose URL matches is captured.
   */
  readonly methods?: readonly string[]
  /**
   * Opt into capturing request/response bodies (default off — headers + metadata only). `true` records
   * the decoded body text, capped by {@link NetworkCaptureFilter.maxBodyBytes}; `'size'` records ONLY
   * the byte length without the body content, so an agent can assert payload
   * size/presence while the body's secrets never reach it. Bodies are captured only for text-ish
   * content types (see {@link NetworkCaptureFilter.bodyContentTypes}). Body content is NOT
   * value-redacted by the transport — the explicit opt-in, the URL allowlist, the size cap, and the
   * content-type gate are the bound.
   */
  readonly captureBodies?: boolean | 'size'
  /**
   * Maximum body BYTES exposed per request when {@link NetworkCaptureFilter.captureBodies} records
   * text (a transport default applies when omitted). A larger body is truncated to this many UTF-8
   * bytes and the event's `*BodyTruncated` flag is set; the true byte length is still reported in
   * `*BodyBytes`. This caps what reaches the agent, not what the underlying transport buffers.
   */
  readonly maxBodyBytes?: number
  /**
   * Content-type substrings whose bodies are eligible for capture, overriding the transport's text-ish
   * default (json / text / xml / form-urlencoded / javascript). A body is captured only when its
   * `content-type` header CONTAINS one of these (case-insensitive) — the guard that keeps binary
   * payloads (images, archives) from being decoded as text. An explicit empty list captures no body.
   */
  readonly bodyContentTypes?: readonly string[]
}

/**
 * One captured network request/response, recorded at terminal state (the request finished or failed),
 * in the per-session ring buffer read by {@link TransportSession.networkEvents}. Headers and bodies
 * can carry secrets; bodies are captured only when {@link NetworkCaptureFilter.captureBodies} opts in
 * (off by default — headers + metadata only), and the capturing plugin redacts named headers (and,
 * with `redactBodies`, body content) before the event reaches the agent. All fields are
 * JSON-serialisable (no `Headers` objects/`Buffer` — plain records/strings/numbers).
 */
export interface NetworkEvent {
  /** HTTP method (`GET`, `POST`, …). */
  readonly method: string
  /** Full request URL. */
  readonly url: string
  /** Playwright resource type when known (`fetch`, `xhr`, `document`, `stylesheet`, …). */
  readonly resourceType?: string
  /** Response status code; absent when the request failed before a response. */
  readonly status?: number
  /** True when {@link NetworkEvent.status} is in the 2xx range; absent on failure. */
  readonly ok?: boolean
  /** Request headers as a plain record; redactable by the capturing plugin. */
  readonly requestHeaders?: Record<string, string>
  /**
   * Decoded request body (e.g. a POST payload), captured only when {@link NetworkCaptureFilter.captureBodies}
   * is `true` and the request's content-type is text-ish; absent in `'size'` mode and when no body / a
   * non-text content-type. Capped to {@link NetworkCaptureFilter.maxBodyBytes}.
   */
  readonly requestBody?: string
  /** True (full) byte length of the request body, even when {@link NetworkEvent.requestBody} is truncated or size-only. */
  readonly requestBodyBytes?: number
  /** True when {@link NetworkEvent.requestBody} was cut to the byte cap (an inline marker tails the text). */
  readonly requestBodyTruncated?: boolean
  /** Response headers as a plain record; redactable by the capturing plugin. Absent on failure. */
  readonly responseHeaders?: Record<string, string>
  /**
   * Decoded response body, captured only when {@link NetworkCaptureFilter.captureBodies} is `true` and
   * the response content-type is text-ish; absent in `'size'` mode, on failure, and for a non-text
   * content-type. Capped to {@link NetworkCaptureFilter.maxBodyBytes}.
   */
  readonly responseBody?: string
  /** True (full) byte length of the response body, even when {@link NetworkEvent.responseBody} is truncated or size-only. */
  readonly responseBodyBytes?: number
  /** True when {@link NetworkEvent.responseBody} was cut to the byte cap (an inline marker tails the text). */
  readonly responseBodyTruncated?: boolean
  /** Failure text (e.g. `net::ERR_ABORTED`) when the request failed; absent on success. */
  readonly failure?: string
  /** Total request duration in ms, when the transport's timing is available. */
  readonly durationMs?: number
  /** Epoch milliseconds when the event was recorded by the server. */
  readonly timestamp: number
  /** Transport-scoped id of the window that issued the request (matches {@link WindowDescriptor.id}). */
  readonly windowId?: string
}

/** Options for {@link TransportSession.networkEvents}. */
export interface NetworkEventsOptions {
  /** When true, flush the entire network buffer (and overflow counter) AFTER reading it. */
  readonly clear?: boolean
}

/**
 * Result of reading a session's network buffer. `events` is the retained tail (oldest first);
 * `overflowed` is the number of older entries the capped ring dropped, so an agent knows the view is
 * incomplete.
 */
export interface NetworkEventsResult {
  readonly events: readonly NetworkEvent[]
  readonly overflowed: number
}

/** The canned response a {@link NetworkStub} fulfills a matched request with. JSON-serialisable. */
export interface NetworkStubResponse {
  /** HTTP status code (100-599). Defaults to 200. */
  readonly status?: number
  /** Response headers as a plain record. */
  readonly headers?: Record<string, string>
  /** Content-Type shortcut (maps to Playwright's `contentType`); a `headers` entry takes precedence. */
  readonly contentType?: string
  /** Response body as a string. */
  readonly body?: string
}

/**
 * Playwright-compatible abort reasons for {@link NetworkStub.abort}. The names mirror
 * `Route.abort(errorCode)` so a user-facing `network_stub` call cannot silently degrade to live
 * traffic because the underlying transport rejected an unknown reason.
 */
export type NetworkAbortReason =
  | 'aborted'
  | 'accessdenied'
  | 'addressunreachable'
  | 'blockedbyclient'
  | 'blockedbyresponse'
  | 'connectionaborted'
  | 'connectionclosed'
  | 'connectionfailed'
  | 'connectionrefused'
  | 'connectionreset'
  | 'internetdisconnected'
  | 'namenotresolved'
  | 'timedout'
  | 'failed'

/**
 * A network stub registered by {@link TransportSession.stubNetwork}. It MODIFIES what the app receives:
 * a request matching the allowlist is fulfilled with a canned response ({@link NetworkStub.fulfill},
 * or the default 200 response when omitted) or aborted ({@link NetworkStub.abort}). Like capture, it is
 * bounded to an explicit URL allowlist (no stub-everything). All fields are JSON-serialisable (A1).
 */
export interface NetworkStub {
  /** URL substrings to stub (an allowlist — at least one). A request matches when its URL CONTAINS any. */
  readonly urls: readonly string[]
  /** Optional HTTP-method allowlist (case-insensitive); omit to stub every method whose URL matches. */
  readonly methods?: readonly string[]
  /** The canned response to fulfill with. Mutually exclusive with {@link NetworkStub.abort}. */
  readonly fulfill?: NetworkStubResponse
  /** Abort the request with this Playwright-compatible reason. Mutually exclusive with `fulfill`. */
  readonly abort?: NetworkAbortReason
  /** Apply at most this many times, then the stub expires and the request goes live. Omit for unlimited. */
  readonly times?: number
  /** Delay before fulfilling/aborting, in ms, to simulate a slow endpoint. */
  readonly delayMs?: number
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
   * true only for offscreen / aria-hidden inputs that really accept keyboard input. Modern
   * code-editor hidden hosts can swallow text; use `electron_type_into_editor` on the visible
   * editor content area instead. No effect when `selector` is absent (global keystrokes).
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

  // --- Network capture surface (requires `capabilities.canIntercept`) ---
  // Capture is ARMED (unlike the always-on console/dialog buffers): listeners only record once a
  // filter is set. A transport that cannot capture rejects these with `NOT_IMPLEMENTED`.

  /**
   * Arm network capture for the requests matching `filter` (an explicit URL allowlist + optional
   * method filter). Attaches to the current and future windows; re-arming replaces the filter and
   * resets the buffer. The capturing plugin tracks the per-session capture lifecycle on top of this.
   */
  startNetworkCapture(filter: NetworkCaptureFilter): Promise<void>

  /**
   * Read the captured network events (oldest first) plus the dropped-entry count. Pass
   * `{ clear: true }` to flush the buffer after reading. Returns an empty buffer when not capturing.
   */
  networkEvents(opts?: NetworkEventsOptions): Promise<NetworkEventsResult>

  /** Disarm network capture and clear its buffer. Safe to call when not capturing (a no-op). */
  stopNetworkCapture(): Promise<void>

  // --- Network stubbing surface (requires `capabilities.canIntercept`) ---
  // The MODIFY half of "intercept": a registered stub fulfills or aborts the requests matching its
  // allowlist. Independent of capture (a stubbed request is still captured). A transport that cannot
  // intercept rejects these with `NOT_IMPLEMENTED`.

  /**
   * Register a network stub on the current and future windows. A request matching the stub's allowlist
   * is fulfilled with its canned response (or aborted). Multiple stubs may be active; the first
   * registered match wins. Registering does not affect non-matching traffic.
   */
  stubNetwork(stub: NetworkStub): Promise<void>

  /**
   * Remove network stubs and restore live traffic — every stub, or only those whose allowlist includes
   * `url` (exact match) when given. Idempotent: safe to call when nothing is stubbed.
   */
  clearNetworkStubs(url?: string): Promise<void>

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

  /**
   * Gracefully shut down the session, escalating to SIGKILL when the graceful
   * close exceeds its budget (see {@link StopOptions.timeoutMs}). The result
   * reports whether escalation happened.
   */
  stop(session: TransportSession, opts?: StopOptions): Promise<StopResult>

  /** Forcefully kill the underlying process and release the session. */
  forceKill(session: TransportSession): Promise<void>
}
