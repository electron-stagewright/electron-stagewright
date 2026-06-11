# ADR-011: Operation-timeout backstop at the dispatch boundary

Status: Accepted

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
- **Abandon, do not cancel.** A Playwright `evaluate` cannot be cancelled. When the timer wins, the
  pending handler promise is ABANDONED: a no-op `.catch` swallows its eventual rejection (no
  unhandledRejection after we have returned), and the timer is `unref`-ed and cleared so it never
  keeps the process alive. The agent is unblocked; the orphaned op settles or dies with the session.

## Rationale

- The dispatch boundary is the one chokepoint every tool already passes through; bounding it there
  is the minimal, uniform fix and generalises the existing "bound every external call" invariant
  (the discovery scan already bounds its probes) to the tool surface.
- A retryable `OPERATION_TIMEOUT` is actionable: the agent can retry, raise the budget, or stop the
  session — far better than an indefinite hang.
- Abandon-not-cancel is the honest trade-off: the alternative (true cancellation) is not available
  from the transport, and blocking until the op settles is exactly the failure we are removing.

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
- The backstop does not free the underlying resource; a wedged renderer still needs a stop/relaunch
  to reclaim it. This is documented, not hidden.

## Related decisions

- ADR-006 (error code registry) — `OPERATION_TIMEOUT` lives there alongside `WAIT_TIMEOUT` /
  `EVAL_TIMEOUT` (tool-intrinsic timeouts; this one is the dispatch backstop above them).
- ADR-008 (server and tool dispatcher) — the dispatch path the race wraps.
- ADR-009 (dispatch seam) — re-dispatch (`ctx.dispatch`) runs through the same `dispatch`, so a
  re-dispatched call is bounded too.

## References

- `packages/core/src/server/dispatcher.ts` — `#withTimeout`, `operationTimeoutMs`,
  `DEFAULT_OPERATION_TIMEOUT_MS`, the construction-time warning.
- `packages/core/src/errors/registry.ts` — the `OPERATION_TIMEOUT` definition.
- `packages/core/src/cli.ts` — `--operation-timeout-ms` parsing.
- `packages/core/tests/dispatcher.test.ts`, `packages/core/tests/resilience.test.ts` — the
  hung-handler bound, no-wedge recovery, opt-out, and the misconfig warning.
