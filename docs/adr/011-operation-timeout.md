# ADR-011: Request cancellation and operation-timeout backstop

Status: Accepted

## Status update (2026-10-03): cooperative request cancellation

Cancellation now reaches handlers through `ToolContext.signal`. This supersedes the original
abandon-only handler policy: the dispatcher still cannot interrupt JavaScript already sent to
Electron, but it can stop subsequent work and reclaim resources acquired by cancelled initialization.
A controlled regression demonstrated a launch handler registering a session after its dispatcher
had already returned `OPERATION_TIMEOUT`.

Each dispatch owns an AbortController. MCP request cancellation and the operation timeout both
abort it. Nested dispatches inherit the active parent's signal; unrelated requests remain isolated.
`DispatchOptions.signal` provides the same behavior to direct callers. Cancellation returns the
non-retryable `OPERATION_CANCELLED` envelope to direct callers and dispatch observers. For MCP,
the SDK handles the cancelled request's protocol response; no replacement response is sent by this
layer. Client cancellation reasons are not copied into errors or logs. A timeout retains the
existing retryable `OPERATION_TIMEOUT` code. Disabling the timeout does not disable cancellation.

`ToolContext.onCancel` registers idempotent, cancellation-only resource cleanup. A registration made
after cancellation runs immediately, which handles transports that resolve late. Completion clears
callbacks, timers and parent listeners; cleanup failure is logged without blocking the cancelled
response. Progress scopes close their heartbeat and phase timers even if the handler never settles.
The signal and cleanup hook are optional in the interface for existing manually constructed contexts;
the dispatcher always supplies both.

Launch/attach/inject keep cleanup armed until dispatch completion. Windows and launch renderer
readiness are prepared before registration. Cancellation stops only an app owned by launch;
attach/inject release their connection without asking an existing app to quit, even when a PID was
supplied. A cancelled initialization's handle is removed even if disconnect fails. Successful
requests transfer the session to the registry and later client cancellation does not reclaim it.
Renderer readiness retries check cancellation and their delay is abortable.

This is cooperative cancellation, not atomic rollback. Already-dispatched evaluations and renderer
polls may finish; completed actions and previously completed nested calls are not undone. Plugins
must check `ctx.signal` between asynchronous steps and register their own resource cleanup.
A launch handshake that never yields a session remains bounded by its transport's startup timeout;
the dispatcher can only clean up the session once that transport returns it. No arbitrary process
is killed to force cancellation.

## Context

The server drives a real app over a transport. Most per-tool operations are already bounded —
interaction actions clamp a Playwright `timeoutMs` (≤ 30s), the wait family self-bounds its poll in
the renderer (≤ 60s), and eval surfaces a transport timeout as `EVAL_TIMEOUT`. But there is one
unbounded class: a transport call that simply never settles. A frozen renderer makes
`page.evaluate` (the basis of snapshot / find / read / expect) wait indefinitely — Playwright's
`evaluate` has no implicit timeout. A tool whose handler awaits such a call hangs the dispatch
forever, and the agent is stranded with no envelope and no recovery.

The resilience/chaos review surfaced this as a real gap (a "hung app" has no bound) and explicitly
deferred it pending a policy decision rather than faking a fix.

## Decision

Add a **dispatch-level backstop timeout**: the dispatcher races each handler against a configurable
budget. If the handler does not settle within the budget, the dispatch resolves with a registered,
retryable `OPERATION_TIMEOUT` envelope (`details.timeout_ms` carries the budget) instead of hanging.

- **One place, all tools.** The race wraps the single `runWithSessionContext(() => handler(...))`
  call in `Dispatcher.dispatch`, so every tool — present and future — inherits the bound without
  per-tool code. The thrown `StagewrightError('OPERATION_TIMEOUT')` flows through the existing
  `#mapThrown` → envelope path, so observers still see the completed dispatch.
- **Backstop, not a tight budget.** The default is **120s**, deliberately above the longest
  legitimate per-tool budget (the wait family's 60s clamp), so it only ever fires on a genuine
  hang and never preempts a valid long wait/action. A configured budget at or under 60s logs a
  construction-time warning; `0` disables the backstop entirely (opt-out).
- **Configurable** via `DispatcherOptions.operationTimeoutMs` → `createServer({ operationTimeoutMs })`
  → CLI `--operation-timeout-ms <n>`.
- **Cooperative cancellation.** The timeout aborts the request signal and runs registered cleanup.
  An already-dispatched Playwright `evaluate` cannot be interrupted; the losing promise remains
  observed by the race so its eventual rejection cannot become an `unhandledRejection`. Timers are
  unreferenced and cleared. See the status update above for ownership and plugin obligations.

## Rationale

- The dispatch boundary is the one chokepoint every tool already passes through; bounding it there
  is the minimal, uniform fix and generalises the existing "bound every external call" invariant
  (the discovery scan already bounds its probes) to the tool surface.
- A retryable `OPERATION_TIMEOUT` is actionable: the agent can retry, raise the budget, or stop the
  session — far better than an indefinite hang.
- Cooperatively stop later work without waiting for an uninterruptible operation: the transport
  cannot promise rollback, and waiting for it to settle would reintroduce the hang.

## Alternatives considered

- **Wrap each transport method** (`evaluate`, `screenshot`, …) in the transport implementation —
  transport-specific, repeated, and misses any future unbounded call; the dispatch-level race is
  one place and total.
- **A tight per-op budget** — would have to special-case every tool that legitimately runs long
  (waits, slow launches), recreating per-tool timeout logic. The high backstop avoids that.
- **Do nothing / document only** — the prior slice's stance; rejected now that the policy
  (high backstop, opt-out, abandon semantics) is settled.

## Consequences

- `DispatcherOptions` / `CreateServerOptions` gain `operationTimeoutMs`; the CLI gains
  `--operation-timeout-ms`. A new registered code `OPERATION_TIMEOUT` (http 408, retryable).
- A genuinely hung app now yields a clean retryable envelope; a unit test drives a never-settling
  handler against a short budget so a real timer fires, and the resilience suite's "hung app" gap
  is closed.
- The backstop reclaims cancelled initialization resources when available. A wedged operation on
  an existing session may still need an explicit stop/relaunch; cancellation does not quit that app.

## Related decisions

- ADR-006 (error code registry) — `OPERATION_TIMEOUT` lives there alongside `WAIT_TIMEOUT` /
  `EVAL_TIMEOUT` (tool-intrinsic timeouts; this one is the dispatch backstop above them).
- ADR-008 (server and tool dispatcher) — the dispatch path the race wraps.
- ADR-009 (dispatch seam) — re-dispatch (`ctx.dispatch`) runs through the same `dispatch`, so a
  re-dispatched call is bounded too.

## References

- `packages/core/src/server/dispatcher.ts` — `operationTimeoutMs`,
  `DEFAULT_OPERATION_TIMEOUT_MS`, the construction-time warning.
- `packages/core/src/server/request-operation.ts` — cancellation lifetime and cleanup.
- `packages/core/src/errors/registry.ts` — the `OPERATION_TIMEOUT` definition.
- `packages/core/src/cli.ts` — `--operation-timeout-ms` parsing.
- `packages/core/tests/dispatcher.test.ts`, `packages/core/tests/resilience.test.ts` — the
  hung-handler bound, no-wedge recovery, opt-out, and the misconfig warning.
