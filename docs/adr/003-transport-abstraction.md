# ADR-003: Transport Abstraction

- **Status**: Accepted (public ADR; implementation amendments recorded below)
- **Date**: 2026-05-27
- **Deciders**: johnny4young

## Context

Electron Stagewright is an MCP server that drives Electron desktop applications. Before any tool can be written (click, type, snapshot, eval, etc.), the project needs a settled answer to "how does the server actually talk to the running Electron process?"

Three viable mechanisms exist, each with distinct trade-offs:

1. **Playwright `_electron`** — Microsoft's experimental wrapper around the Chromium driver. Convenient, well-typed, but marked experimental and could be deprecated. See [Playwright MCP PR #1291](https://github.com/microsoft/playwright-mcp/pull/1291) for the upstream-deprecation signal that informs this ADR.
2. **Raw Chrome DevTools Protocol (CDP)** — the stable public protocol that Chrome DevTools itself uses. Lower-level, requires hand-rolling WebSocket + JSON-RPC plumbing, but doesn't depend on any upstream wrapper that could go away.
3. **Inject Node Inspector into a running process** — best ergonomic for developers (no pre-flag required, attach to an app that's already running) but experimental, platform-dependent, and uses `process._debugProcess` whose Windows behaviour is less reliable than POSIX.

If the server's tools hardcode any single mechanism, they inherit its limitations forever. If they leave the choice ad-hoc per tool, the plumbing duplicates N times and inconsistencies between tools surface as confusing failures. This ADR locks the contract that every tool dispatches through.

## Decision

### 1. Single contract: `ITransport`

```ts
export interface ITransport {
  readonly id: TransportId // 'playwright-electron' | 'cdp' | 'injector'
  readonly capabilities: TransportCapabilities

  launch(opts: LaunchOptions): Promise<TransportSession>
  attach(opts: AttachOptions): Promise<TransportSession>
  inject(opts: InjectOptions): Promise<TransportSession>
  stop(session: TransportSession, opts?: StopOptions): Promise<void>
  forceKill(session: TransportSession): Promise<void>
}

export interface TransportSession {
  readonly id: SessionId
  readonly transport: TransportId

  evaluate<T>(target: 'main' | 'renderer', body: string, arg?: unknown): Promise<T>
  screenshot(target: WindowRef, opts?: ScreenshotOptions): Promise<Buffer>
  windowsList(): Promise<readonly WindowDescriptor[]>
  readonly ipc: IpcChannel
  readonly console: ConsoleStream

  /** Idempotent — calling twice does not throw, does not double-free. */
  dispose(): Promise<void>
}
```

Every tool dispatches through `ITransport`. The transport implementation can change without touching tools, plugins, or examples; the contract is the seam.

### 2. Capability matrix

Every transport declares its capabilities up front via a `TransportCapabilities` record. The dispatcher inspects the matrix BEFORE invoking a method and refuses unsupported operations with `TRANSPORT_UNSUPPORTED` (registered code from the central error registry) instead of crashing partway through the SDK with a vague Playwright/CDP error.

```ts
export interface TransportCapabilities {
  readonly canLaunch: boolean
  readonly canAttach: boolean
  readonly canInject: boolean
  readonly canIntercept: boolean // network / IPC mid-flight modification
  readonly canControlClock: boolean
  readonly supportsMainEval: boolean
  readonly supportsRendererEval: boolean
}
```

A helper `assertCapability(transport, capability)` is exported alongside the interface so tool handlers can refuse-when-unsupported with a single line.

### 3. Three implementations

| Transport                     | canLaunch | canAttach | canInject | canIntercept | canControlClock | supportsMainEval | supportsRendererEval |
| ----------------------------- | --------- | --------- | --------- | ------------ | --------------- | ---------------- | -------------------- |
| `PlaywrightElectronTransport` | ✓         | ✗         | ✗         | ✗            | ✗               | ✓                | ✓                    |
| `CDPTransport`                | ✗         | ✓         | ✗         | ✓            | ✓               | ✓                | ✓                    |
| `InjectorTransport`           | ✗         | ✓         | ✓         | ✗            | ✗               | ✓                | ✗                    |

**PlaywrightElectronTransport** ships as the only fully-implemented transport in this slice. It uses Playwright's experimental `_electron.launch()` API loaded via **dynamic import** so the `playwright` peer dependency stays optional: consumers can install `@electron-stagewright/core` without `playwright` and still import the package; only invoking `launch()` surfaces a `TRANSPORT_UNSUPPORTED` error with a clear remediation hint.

**Deviation from the original scope**: the design draft assumed `PlaywrightElectronTransport` would also support `canAttach: true`. After investigation, Playwright's `_electron` does NOT expose a public `attach` API — it only exposes `launch`. Attach behaviour is delegated to `CDPTransport` (which connects to an already-running app via its CDP endpoint). The Playwright transport now declares `canAttach: false` and its `attach()` method rejects with `TRANSPORT_UNSUPPORTED`. The capability matrix above reflects this corrected reality.

**CDPTransport** and **InjectorTransport** ship as stubs in this slice. Their constructors succeed, their capability matrices are declared honestly, and every method rejects with a registered error code (`TRANSPORT_UNSUPPORTED` when the capability matrix already refuses; `NOT_IMPLEMENTED` when the capability is claimed but the body is deferred). The point of shipping the stubs now is to **force every downstream slice to honour the contract** — tools cannot reach into transport-specific behaviour because there is no transport-specific behaviour to reach into yet.

### 4. CDP connection pool (design captured, implementation deferred)

When `CDPTransport`'s body lands in a future slice, the connection pool design adopted from prior art (`laststance/electron-mcp-server/src/utils/cdp-pool.ts`) is:

- **Multiplexed WebSocket per target**. One socket connection per Electron target (main process, each renderer); messages from all in-flight calls share the same socket via per-target queueing.
- **Pending-message map keyed by request ID**. CDP uses `id` field on every JSON-RPC envelope; the pool keeps a `Map<id, { resolve, reject }>` so responses route back to their callers without races.
- **Per-method timeout handles**. Default 30s with caller-overridable `timeoutMs`. Timer is cleared on response or rejection.
- **`enabledDomains: Set<string>` per target**. CDP requires explicit `Page.enable`, `Runtime.enable`, `DOM.enable` before the corresponding events fire. The pool tracks which domains are already enabled so subsequent calls skip the redundant enable.
- **`awaitPromise: true` option**. `Runtime.evaluate` accepts a flag that waits for Promise resolution before returning. Tools that evaluate async code (most of them) pass `awaitPromise: true` through the pool's evaluate helper.

None of this ships in the current slice; the design lives here so the CDP-implementation slice has a contract to honour.

### 5. Eval payload validation lives in the dispatcher, not the transport

The transport's `evaluate()` method does NOT validate the body string against the eval blocklist (see [ADR-006](./006-error-code-registry.md)). The dispatcher invokes `routeByOperationType(operationType, payload)` BEFORE calling `transport.evaluate()`, and `operationType: 'eval'` flows through `validateEvalContent` which screens the keyword blocklist. Direct callers (tests, application code) that bypass the dispatcher inherit responsibility for validating untrusted payloads.

The current `evaluate()` implementation wraps the body in a function string using positional parameter names (`async (electronApp, arg) => { ${body} }` for main, `async (arg) => { ${body} }` for renderer). A malicious or malformed body string CAN break out of the wrapper. The robust protocol (AST inspection, structured eval messages instead of string concatenation) lands with the eval-tool ADR and the threat-model ADR. The string wrapper here is intentionally minimal.

## Rationale

### Why three implementations behind one interface

A single implementation locks the project to one vendor's roadmap. The Playwright deprecation signal makes this concrete: if Microsoft removes `_electron`, the project either rewrites every tool against CDP or dies. With three implementations behind `ITransport`, the dispatcher can swap implementations transparently. The cost is one interface definition + capability matrix; the benefit is multi-year survivability.

### Why a capability matrix instead of dynamic feature detection

Boot-time matrix inspection is cheap (a property read) and lets the dispatcher refuse-when-unsupported at the first opportunity. Dynamic feature detection (try the call, catch the error, fall back) burns at least one round-trip per failure and surfaces transport-specific exceptions to tools. The matrix is also self-documenting: a contributor reading `CDPTransport` sees `canLaunch: false` in the constructor and immediately understands why `launch()` rejects.

### Why dynamic `await import('playwright')`

`playwright` is declared as an OPTIONAL peer dependency. A consumer installing `@electron-stagewright/core` and NEVER using `PlaywrightElectronTransport` should not be forced to install Playwright. Static `import` at module-load time crashes the package import for those consumers; dynamic `await import('playwright')` defers the failure until the first `launch()` call, at which point the failure is structured (`TRANSPORT_UNSUPPORTED` with an install-instruction hint) instead of a raw module-not-found crash.

### Why ship the CDP / Injector stubs now

Two reasons:

1. **The capability matrix becomes load-bearing immediately.** Downstream slices that need attach (the future "attach-without-restart" Brecha A work) will read `cdp.capabilities.canAttach === true` and consume that as a contract. Shipping the stubs now means slices can be planned against the real capability matrix instead of pseudo-code.
2. **The seams are the security surface, not the bodies.** Once `routeByOperationType` + `assertCapability` exist as the single entry points, tool implementations cannot accidentally bypass them. Shipping the bodies as stubs that throw `NOT_IMPLEMENTED` is more honest than not shipping the classes at all — the capability matrix lies if it claims `canAttach: true` and the class doesn't exist.

### Why `dispose()` is idempotent

The dispatcher may call `dispose()` during normal shutdown AND during error recovery. A non-idempotent `dispose()` produces double-free crashes in the recovery path. The contract is documented at the interface level; the Playwright session honours it via a `disposed: boolean` flag; the test fake demonstrates the same shape.

## Alternatives considered

| Alternative                                                                           | Why rejected                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hardcode Playwright `_electron` everywhere**                                        | One-vendor risk. Microsoft has signalled the API is experimental; rewriting every tool against CDP after they ship is far more expensive than defining the interface up front.                                                                                                                                                                                                  |
| **Hardcode raw CDP from day 1**                                                       | ~1500 LOC of WebSocket + JSON-RPC + types just to type a single `click()`. Playwright wraps the same surface in well-tested helpers. Burn the cost only when forced to.                                                                                                                                                                                                         |
| **Per-tool transport choice (no abstraction)**                                        | Plumbing duplicates N times across N tools. Inconsistencies between tools surface as confusing failures for agents ("why does click work but scroll fail?").                                                                                                                                                                                                                    |
| **`chrome-remote-interface` library inside `CDPTransport`**                           | Considered; adds a dependency we may not need long-term. The CDP-implementation slice will spike `chrome-remote-interface` vs hand-rolling against the pool design above and decide then. Not decided in this slice.                                                                                                                                                            |
| **Make the capability matrix dynamic (computed per-session)**                         | Boot-time matrix is enough for the dispatcher's needs. A dynamic matrix would require every consumer to wait for session creation before knowing what the transport can do, which defeats the purpose of cheap upfront refusal. If a future use case requires per-session capability variance, we add it as additive metadata; the static matrix remains the baseline contract. |
| **Replace `NotImplementedError` class with `StagewrightError('NOT_IMPLEMENTED', …)`** | Adopted. The project's error infrastructure already has `StagewrightError` keyed on `ErrorCode`. Inventing a parallel class fragments the error hierarchy and confuses the mirror test.                                                                                                                                                                                         |

## Consequences

- Every tool dispatches through `ITransport`. Tools cannot import `playwright` directly; they cannot reach into a transport-specific method.
- Adding a new transport (e.g. WebDriverTransport, ExtensionHostTransport) means implementing `ITransport` and declaring a capability matrix — no other changes required to existing tools.
- The capability matrix is the API surface tools depend on. Adding a new capability (e.g. `canSendNotification`) is a backwards-incompatible change to `TransportCapabilities` — every transport must update its declared matrix in the same PR.
- The `playwright` peer dependency stays optional. Consumers without Playwright cannot use `PlaywrightElectronTransport.launch()` but can still import the package and use `CDPTransport` once its body lands.
- `dispose()` is idempotent at the contract level. Implementations that fail to honour this are buggy; the test fake demonstrates the shape.
- The dispatcher is the single chokepoint for eval validation (via `routeByOperationType` from ADR-006). Transport implementations do NOT validate eval payloads on their own; direct callers bypassing the dispatcher inherit the responsibility.
- Eval tools now ship behind `--allow-eval` with dispatcher-level keyword
  validation. A future threat-model slice can still replace the minimal string
  wrapper with structured messages, AST inspection, and richer audit logging.

## Amendment (2026-05-28): Interaction surface

The original contract covered observation (`evaluate`, `screenshot`, `windowsList`) but no real user input. Driving an Electron app requires click/type/hover/drag/scroll, so the contract is extended additively. The seam is unchanged — tools still dispatch through `ITransport` / `TransportSession`; this amendment adds methods, it does not alter the existing ones.

### New capability flag

`TransportCapabilities` gains an eighth flag:

```ts
/**
 * The transport can perform real user input (click, type, hover, drag, …) on a
 * renderer element. A transport declaring this `false` rejects those methods.
 */
readonly supportsInteraction: boolean
```

Per-transport values:

| Transport                     | supportsInteraction | Notes                                                                                                        |
| ----------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PlaywrightElectronTransport` | ✓                   | Fully implemented against Playwright's `Page` action API.                                                    |
| `CDPTransport`                | ✗                   | Historical value for this amendment; the 2026-06-10 status update records the current `true` implementation. |
| `InjectorTransport`           | ✗                   | Node Inspector has no renderer-input surface on its own.                                                     |

Adding a capability flag is a backwards-incompatible change to `TransportCapabilities` (every transport must update its matrix in the same change), exactly as the original Consequences section anticipated.

### New session methods

`TransportSession` gains nine methods, all operating on the active/default window with real user input: `click`, `fill`, `hover`, `press`, `selectOption`, `setChecked`, `setInputFiles`, `dragTo`, and `scroll`. Three option types support them:

- `InteractionOptions { force?, timeoutMs? }` — common actionability controls. The Playwright transport maps these onto its action options as `{ force, timeout }`, omitting absent keys (required under `exactOptionalPropertyTypes`).
- `PressOptions extends InteractionOptions { selector? }` — `press` focuses `selector` first when given, otherwise presses against the active keyboard.
- `ScrollOptions { selector?, dx?, dy?, timeoutMs? }` — `scroll` centres `selector` into view when given, otherwise dispatches a wheel delta.

### No-match must be observable

Eight of the nine methods delegate to Playwright actions that already reject when the selector matches nothing. `scroll`'s into-view path runs in the renderer (the minimal page surface intentionally does not expose Playwright locators), so it explicitly reports whether the element was found and rejects with `SELECTOR_NO_MATCH` on a miss. A silent success here would let the tool layer report a phantom scroll it cannot diagnose — every interaction method surfaces a missing target uniformly.

### Scope of this slice

This amendment ships the **contract plus the Playwright implementation only**. The agent-facing interaction tools (and the `ref` → `[data-sw-ref="…"]` resolution they perform before reaching the transport) land in the following slice; the CDP/Injector bodies remain deferred and continue to reject with `NOT_IMPLEMENTED` once their sessions exist.

### Follow-up (tool layer): two additive surface refinements

The tool-layer slice that builds on this amendment added two backwards-compatible methods to the interaction surface, both implemented in `PlaywrightElectronTransport` and recorded by the test fake:

- **`ClickOptions extends InteractionOptions { button?, clickCount? }`** — `click` now carries an optional pointer button (`left`/`right`/`middle`) and click count, so one method covers right-click (context menus) and double-click (click-to-edit) without separate transport methods.
- **`typeText(text, opts?: PressOptions)`** — real per-character keystrokes (each fires keydown/keypress/input/keyup), distinct from `fill` (which sets `.value` and fires a single input event). For inputs with per-keystroke handlers (editors, autocompletes). Focuses `opts.selector` first when given; otherwise types into the active element.

Both are additive — existing callers are unaffected, and `supportsInteraction` already gates them. The CDP/Injector stubs declare `supportsInteraction: false` and gain no method bodies.

The tool layer also established a shared resolver (`ref`/`selector` → one selector), a bounded per-action timeout (default 5s, clamp 30s), a raw-throw → registered-code classifier (mirroring the launch-error diagnoser, e.g. a Playwright "element is not enabled" message → `ELEMENT_DISABLED`), a `ref`-freshness guard against the stored snapshot, and `similar_refs` candidates sourced from a fresh live walk on a miss.

## Amendment (2026-05-30): Console-output buffer

The observation tool slice (`electron_screenshot` + `electron_console_logs`) needed the transport to surface renderer console output. Screenshots already had a method (`screenshot(window, opts)`); console output did not, because console messages are _events_ — they arrive asynchronously while the app runs, and a query-time pull cannot retroactively observe a `console.log` that already fired. So the contract gains a small capture buffer.

### New session method

```ts
interface ConsoleEntry {
  readonly type: string // 'log' | 'info' | 'warning' | 'error' | 'debug' | ...
  readonly text: string
  readonly timestamp: number // epoch ms
  readonly location?: { url?: string; line?: number; column?: number }
}

interface ConsoleLogsResult {
  readonly entries: readonly ConsoleEntry[]
  readonly overflowed: number // count of older entries the buffer dropped
}

// on TransportSession:
consoleLogs(): Promise<ConsoleLogsResult>
```

### Capture model

- `PlaywrightElectronTransport` subscribes to `page.on('console')` on the **launch-time first window**, synchronously in the session constructor (the launch path resolves `firstWindow()` once and passes the page in, so console capture adds no extra `firstWindow()` round-trip).
- The buffer is a **bounded ring** (cap 1000). On overflow the oldest entry is shifted out and an `overflowed` counter increments, so `electron_console_logs` can tell the agent the view is incomplete rather than silently truncating (ADR-007 — surface staleness, never fake completeness).
- Entries are plain JSON-serialisable records (no `Map`/`Set`/`Date`), consistent with the agent-payload invariant. Playwright's `location.lineNumber`/`columnNumber` are normalised to `line`/`column`.

### Scope and deferrals

- **Single window only.** Only the launch-time first window's console is captured; multi-window console aggregation is out of scope for this slice (no demand yet, and it would require tracking page lifecycle across `switch_window`).
- **Post-dispose behaviour.** `consoleLogs()` calls `requireRunning()` and rejects with `NOT_RUNNING` after the session is disposed — contract-consistent with the other read methods. A crash does not dispose the session, so the in-memory buffer survives a renderer crash for post-mortem inspection; an explicit `stop`/`force_kill` clears it. (Product decision: keep the buffer ephemeral, tied to session lifetime.)
- Historical scope: the CDP/Injector stubs gained no console capture in this amendment because their sessions did not exist yet. The 2026-06-10 status update records the current CDP/Injector capture support.

`dialog_handler` (the other event-driven surface originally bundled with this slice) is deferred to its own follow-up so this console-buffer amendment ships isolated from a `page.on('dialog')` amendment.

## Amendment (2026-05-31): Dialog handling

The deferred follow-up to the console-buffer amendment. Native JS dialogs (`alert` / `confirm` / `prompt` / `beforeunload`) block the renderer until something answers, so — like console output — they cannot be observed by a query-time pull, and unlike console they require an _active_ response. The contract gains a small forward-looking auto-responder plus a capture buffer.

### New types and session methods

```ts
type DialogAction = 'accept' | 'dismiss'
type DialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

interface DialogPolicy {
  readonly action: DialogAction // default for any unmatched dialog
  readonly promptText?: string // submitted to prompt() when its effective action is accept
  readonly perType?: Partial<Record<DialogType, DialogAction>> // per-kind overrides; falls back to action
  readonly oneShot?: boolean // resolve exactly one dialog, then revert to the dismiss default
}

interface DialogEvent {
  readonly type: string
  readonly message: string
  readonly action: DialogAction // how the responder resolved it
  readonly defaultValue?: string // prompt()'s default, when non-empty
  readonly promptText?: string // text submitted to a prompt() accept
  readonly timestamp: number // epoch ms
}

interface DialogEventsResult {
  readonly entries: readonly DialogEvent[]
  readonly overflowed: number
  readonly policy: DialogPolicy // the policy currently in effect
}

// on TransportSession:
setDialogPolicy(policy: DialogPolicy): Promise<void>
dialogEvents(opts?: { clear?: boolean }): Promise<DialogEventsResult>
```

### Capture and response model

- `PlaywrightElectronTransport` subscribes to `page.on('dialog')` on the **launch-time first window**, synchronously in the session constructor, alongside the console listener (the launch path resolves `firstWindow()` once and passes the page in, so dialog capture adds no extra round-trip).
- **Critical invariant: attaching a `dialog` listener disables Playwright's own auto-dismiss.** Once a listener exists, the listener MUST resolve every dialog (`accept`/`dismiss`) or the renderer hangs forever. The session defaults its policy to `dismiss`, so dialogs are always resolved — even before the agent arms anything — and the app never hangs.
- The handler reads `type`/`message`/`defaultValue` **before** calling `accept`/`dismiss` (which can invalidate the handle), resolves per the active policy, and records the event **regardless** of whether `accept`/`dismiss` throws (an already-handled or closed dialog is still worth recording for post-mortem).
- `oneShot` reverts the policy to the safe `dismiss` default after a single dialog, so a lingering `accept` cannot silently confirm a later, unexpected (possibly destructive) dialog.
- The buffer is a **bounded ring** (cap 200) with an `overflowed` counter (dialogs are far rarer than console messages, so a smaller cap than the console buffer's 1000). Overflow surfaces to the agent rather than silently truncating (ADR-007).
- Entries are plain JSON-serialisable records (no `Map`/`Set`/`Date`), consistent with the agent-payload invariant.

### Scope and deferrals

- **Single window only.** Same boundary as the console buffer — only the launch-time first window's dialogs are captured.
- **Post-dispose behaviour.** `setDialogPolicy()` / `dialogEvents()` call `requireRunning()` and reject with `NOT_RUNNING` after dispose — contract-consistent with `consoleLogs()`. The buffer survives a renderer crash (the session is not disposed) for post-mortem; an explicit `stop`/`force_kill` clears it.
- **No new capability flag.** Like the console buffer, dialog capture rides the session. Historical scope: the CDP/Injector stubs gained no dialog handling in this amendment because their sessions did not exist yet; the 2026-06-10 status update records the current CDP support and Injector boundary.
- **`prompt()` caveat.** Electron does not implement renderer `window.prompt()` (it is a no-op returning `null` and fires no dialog), so the real-Electron smoke exercises `confirm` + `alert`; prompt-text handling is validated through the transport fake in unit tests. The contract still carries `promptText` for transports/runtimes that do surface prompts.

## Related decisions

- [ADR-001](./001-naming-and-license.md) — Naming and License. Transports ship under MIT, no contributor agreement needed.
- [ADR-002](./002-runtime-and-language.md) — Runtime and Language. The dynamic `await import('playwright')` idiom and the strict-plus TypeScript profile (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) directly shape this slice.
- [ADR-006](./006-error-code-registry.md) — Error Code Registry and Agent-UX Response Envelope. Transports consume codes (`TRANSPORT_UNSUPPORTED`, `NOT_IMPLEMENTED`, `CDP_DISCONNECTED`, `INJECT_FAILED`, `LAUNCH_TIMEOUT`, `REF_NOT_FOUND`, `NOT_RUNNING`); the mirror test enforces every literal usage matches a registered key.
- [ADR-007](./007-agent-native-ux-principles.md) — Agent-native UX principles. The capability matrix is the seam that lets tool descriptions (Principle 1) cite the failure codes they can raise without leaking transport-specific failure modes.
- [ADR-004](./004-plugin-model.md) — Plugin model; plugin-provided tools and codes register alongside the same transport/tool contracts.
- Eval tools — already shipped behind `--allow-eval`; the transport contract remains the execution seam.
- Threat-model ADR (forthcoming) — will harden eval validation beyond the keyword blocklist already shipped in ADR-006.

## References

- `packages/core/src/transports/types.ts` — the contract itself.
- `packages/core/src/transports/capabilities.ts` — `assertCapability` helper.
- `packages/core/src/transports/playwright-electron.ts` — first concrete implementation.
- `packages/core/src/transports/cdp.ts` — CDP implementation plus pool design history captured in this ADR.
- `packages/core/src/transports/injector.ts` — Node-inspector inject/attach implementation.
- `packages/core/tests/transports.test.ts` — table-driven capability-vs-method drift detection.
- [Playwright `_electron` documentation](https://playwright.dev/docs/api/class-electron) — upstream API surface.
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) — the public protocol `CDPTransport` will speak.
- [Playwright MCP PR #1291](https://github.com/microsoft/playwright-mcp/pull/1291) — the deprecation signal that motivates this abstraction.

## Status Update — 2026-06-10

The CDP transport's connection pool and the Injector transport's Node-inspector
attach/inject paths are now implemented. Earlier sections remain the historical
record of the contract-first slice that shipped the stubs; the current
implementation status is below.

- `packages/core/src/transports/cdp-connection.ts` realises the pool design this
  ADR captured: one WebSocket per target, a pending map keyed by request id,
  per-method timeouts (new registered code `CDP_TIMEOUT`), an enabled-domain
  cache, and `awaitPromise` evaluation. The socket is created through an
  injectable factory; the default is Node's global `WebSocket`, so the core
  gains no runtime dependency.
- `CDPTransport.attach` resolves the browser endpoint from a `cdpUrl` or
  `host:port` (`/json/version` + `/json/list`), pools per-page-target
  connections lazily, aggregates console (`Runtime.consoleAPICalled`) and
  dialog (`Page.javascriptDialogOpening`) capture across every target, supports
  screenshots and renderer/main `Runtime.evaluate`, implements core
  interaction through `Input.dispatch*` / `DOM.setFileInputFiles`, and runs a
  bounded `Browser.close` stop that escalates to SIGKILL when the attach
  supplied a pid.
- `InjectorTransport` triggers or reuses the Node inspector, polls the bounded
  `/json/list` discovery path, verifies the discovered target title belongs to
  the requested pid (and verifies `process.pid` for direct `cdpUrl` attaches
  with a supplied pid), supports main-process `Runtime.evaluate`, window
  listing, console capture, and a bounded graceful quit. It still does not
  expose renderer eval or interaction; those remain CDP/Playwright
  responsibilities.
- `ITransport.stop` now returns a `StopResult` (`{ escalated }`): every
  transport's graceful stop is bounded and escalates to SIGKILL rather than
  wedging on a hung app — the session is always released with the process
  reaped, never orphaned without a handle.
- The Playwright transport additionally attaches console/dialog capture to
  EVERY window (the `window` event), attributes buffered entries by
  `windowId`, and recovers the active window from the known list before
  blocking on a new `window` event after modal-induced handle loss.

## Status Update — 2026-06-16: Network capture seam (canIntercept's first consumer)

The `canIntercept` capability, dormant since this ADR reserved it, gains its first consumer (see
ADR-016). `TransportSession` is extended with an ARMED network-capture seam — `startNetworkCapture`,
`networkEvents`, `stopNetworkCapture` — alongside the always-on console/dialog buffers.

- The **Playwright transport** implements the seam via `page.on('requestfinished'|'requestfailed')`
  (renderer traffic) and flips `canIntercept` from `false` to `true` — capture is the observe half of
  "intercept". The listeners attach next to the console/dialog ones (current + future windows) and
  stay inert until a filter is armed.
- The **CDP transport** declares `canIntercept: false` for now: its Network domain could serve
  capture, but the seam is not wired, and a capability that now has a consumer (the plugin gate) stays
  honest rather than advertising methods that reject at runtime. The flag flips to `true` when the CDP
  seam lands. Its three seam methods still throw `NOT_IMPLEMENTED` for a direct caller that bypasses
  the gate (distinct from its `canControlClock`, which stays aspirational-true while it has no
  consumer).
- The **injector transport** keeps `canIntercept: false` (no renderer network).

So the plugin's capability gate refuses both CDP and injector sessions with `network.UNSUPPORTED`
(naming the Playwright transport), while `NOT_IMPLEMENTED` remains the contract-level signal for a
direct caller that ignores the capability. Capture rides this seam rather than the eval seam
(ADR-010's approach) because protocol-level network is invisible to `evaluate`, and so it is NOT
`--allow-eval` gated.

## Status Update — 2026-06-18: canIntercept's second consumer (CDP network seam)

The seam reserved above is now wired on the **CDP transport** too, so `canIntercept` flips from
`false` to `true` on CDP and the capability is honest on both attach-mode and launch-mode (see ADR-016).

- **Capture + bodies** ride the CDP **Network domain** (`Network.enable`, the `requestWillBeSent` →
  `responseReceived` → `loadingFinished`/`loadingFailed` correlation, `Network.getResponseBody`); the
  inert-until-armed listener pattern matches the Playwright transport (the listeners attach per pooled
  page connection in `#attachCapture`; `Network.enable`/`disable` toggles on arm/stop).
- **Stubbing** rides the **Fetch domain** (`Fetch.enable` + `Fetch.requestPaused` → `fulfill`/`fail`/
  `continue`). The five seam methods are fully implemented — none throws `NOT_IMPLEMENTED` — so
  `canIntercept: true` is honest, not aspirational.
- **Scope** is renderer page-target traffic, the same as Playwright (not the main process's `net`
  module). The **injector** transport keeps `canIntercept: false` (no renderer network).

The `canIntercept` capability now has TWO honest implementers; it is the per-transport gate the network
plugin reads, and a transport advertises it only once the whole seam is wired.
