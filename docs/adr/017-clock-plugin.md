# ADR-017: Clock control plugin via a transport clock seam

Status: Accepted (Playwright transport; CDP-transport clock deferred)

## Context

An agent driving an Electron app cannot test time-dependent UI deterministically. "Does the session
banner appear after 30 seconds?", "does the countdown reach zero?", "does the 'last updated 5 minutes
ago' label roll over?", "what happens at midnight?" — answering these by _waiting real wall-clock time_
is slow and flaky, and some states (a far-future expiry) can't be reached at all. The transport
capability matrix has reserved `canControlClock` since ADR-003, but it had no seam and no consumer (the
CDP transport even declared it aspirationally true). This is the clock analog of the network capture
plugin (ADR-016): the same "a transport seam + a capability gate + a plugin that drives it" shape.

## Decision

### 1. A dedicated clock seam on the transport, gated by `canControlClock`

`TransportSession` gains a clock seam — `installClock(options)`, `setFixedTime(time)`,
`setSystemTime(time)`, `advanceClock(ms)`, `runClockFor(ms)`, `pauseClockAt(time)`, `resumeClock()`.
The Playwright transport implements it via `page.clock` (its fake-timer controller, which overrides the
renderer's `Date` / `setTimeout` / `setInterval`), and flips `canControlClock` from `false` to `true` —
the capability's first consumer.

`@electron-stagewright/plugin-clock` drives that seam: `clock_install`, `clock_set_time`,
`clock_set_system_time`, `clock_advance`, `clock_run_for`, `clock_pause`, `clock_resume`,
`clock_status`. The plugin keeps the orchestration (the per-session install lifecycle, the gate, error
envelopes) in TypeScript; the transport owns the actual clock.

A seam — not eval — because the fake clock must override the renderer's timer globals transparently and
survive across calls; that is a transport concern, not arbitrary JavaScript, so it should not inherit
the eval threat model or the `--allow-eval` opt-in.

### 2. Gated by `canControlClock`, install-before-use, NOT `--allow-eval` gated

- **`canControlClock`** — the clock tools resolve the session and refuse a transport whose
  `canControlClock` is unset (`clock.UNSUPPORTED`, naming the Playwright transport). The Playwright
  transport declares `true`; the **CDP** transport flips from its aspirational `true` to **honest
  `false`** (see Alternatives); the injector declares `false`.
- **Install before use** — `clock_install` must precede the other clock tools; the plugin tracks
  per-session install state and returns `clock.NOT_INSTALLED` otherwise (mirroring the network plugin's
  `NOT_CAPTURING`).
- **NOT `--allow-eval` gated** — clock control runs no app JavaScript, so it does not require the eval
  opt-in. Like the network plugin and unlike the IPC plugin.

Clock control **alters app behaviour** (it changes the time the app sees and fires its timers), so it
is bounded the same way as the other modify-capable plugins: the `canControlClock` capability and the
operator-loaded plugin. It is not a secret surface, so there is no redaction concern.

## Rationale

- A clock seam, capability-flagged like the network seam, is the honest place this power lives; it
  mirrors how the agent already reads/drives the app through capability-gated seams.
- `fastForward` / `runFor` map cleanly onto agent-facing verbs (advance, tick). The seam's
  `setFixedTime` is intentionally a true hold (set the wall time and pause timers) rather than
  Playwright's Date-only `setFixedTime`, because the agent-facing `clock_set_time` contract is
  "freeze until I advance or resume". `advanceClock` firing the due timers is exactly the
  deterministic trigger the agent needs — no real waiting, no flakiness.

## Alternatives considered

- **Clock control via `evaluate`** (override `Date`/`setTimeout` with injected JS) — rejected: a
  correct, transparent fake clock is exactly what Playwright's `page.clock` already provides; reusing it
  via a seam avoids re-implementing a fake-timer library and keeps clock control out of the eval
  threat model.
- **Wiring the seam on the CDP transport now (via `Emulation.setVirtualTimePolicy`)** — deferred: CDP's
  virtual-time model is budget-based (advance/pause) and, critically, cannot **resume to the real
  clock** (Chromium virtual time, once enabled, has no "return to real time" policy). It therefore
  cannot honestly satisfy the full seam, so flipping CDP `canControlClock: true` would be the
  aspirational-capability trap ADR-003 warns against. CDP stays honest-`false` and its seam methods
  reject `NOT_IMPLEMENTED`; a CDP clock increment that maps the supported subset is a clean follow-up.

## Consequences

- New package `@electron-stagewright/plugin-clock` with the eight `clock_*` tools and namespaced
  `clock.*` error codes (`UNSUPPORTED`, `NOT_INSTALLED`). Invalid args (negative `ms`, missing `time`,
  invalid date-time strings) are core `BAD_ARGUMENT` (schema), not a plugin code.
- `TransportSession` gains seven methods every transport must satisfy: real on Playwright,
  `NOT_IMPLEMENTED` on CDP and injector (and the test fake records them). `canControlClock` gains its
  first consumer (amends ADR-003): Playwright flips `false → true`, CDP flips its aspirational
  `true → false`.
- **Playwright launch transport only.** `page.clock` is the renderer's fake clock; CDP-transport clock
  control is the deferred broader path.
- **Honest capability.** `canControlClock: true` means the whole seam works; a transport that cannot
  satisfy it declares `false` rather than advertising methods that reject at runtime.

## Related decisions

- ADR-003 (transport abstraction) — the `canControlClock` capability this consumes; amended with a
  Status Update for its first consumer.
- ADR-004 (plugin model) — the contract + in-process trust model this plugin is built on.
- ADR-006 (error code registry) — the namespaced `clock.*` codes.
- ADR-016 (network plugin) — the sibling plugin whose transport-seam + capability-gate shape this
  mirrors.

## References

- `packages/core/src/transports/types.ts` — the seam methods + `ClockTime` / `ClockInstallOptions`.
- `packages/core/src/transports/playwright-electron.ts` — the `page.clock` implementation.
- `packages/plugin-clock/src/index.ts` — the tools, capability gate, per-session install state.
- `packages/plugin-clock/tests/` — simulated-seam integration + the gated real-Electron smoke.
