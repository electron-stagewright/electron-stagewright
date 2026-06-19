# @electron-stagewright/plugin-clock

Deterministic virtual-time control for an Electron app under agent-driven testing (ADR-017, built on
the ADR-004 plugin contract). Install a fake clock over the renderer's `Date` / `setTimeout` /
`setInterval`, freeze it at a chosen instant, and advance it by an exact amount to fire the app's timers
on demand — so a "session expires in 30s" banner, a countdown, a debounce, or a midnight rollover can be
tested without waiting real wall-clock seconds.

Like the network plugin, the clock tools ride a dedicated **transport seam**, not main-process eval — so
they do **not** require `--allow-eval`. They run on the default **Playwright** launch transport (via
Playwright's `page.clock`); the CDP transport's clock control is a deferred follow-up.

## Load it

```sh
node packages/core/dist/cli.js --plugin @electron-stagewright/plugin-clock
```

Programmatically:

```js
import { createServer } from '@electron-stagewright/core'
import clockPlugin from '@electron-stagewright/plugin-clock'

const server = await createServer({ plugins: [clockPlugin] })
```

No configuration.

## Tools

The loader namespaces each tool under the plugin name `clock`:

- **`clock_install`** `{ time?, sessionId? }` — install a fake clock, optionally starting at `time`
  (epoch ms or ISO-8601). **Required before any other clock tool.** Re-installing replaces the clock.
  Returns `{ installed, time? }`.
- **`clock_set_time`** `{ time, sessionId? }` — freeze the clock at `time`: `Date.now()` returns it and
  timers do **not** auto-fire (use `clock_advance` to fire them). Returns `{ fixed }`.
- **`clock_set_system_time`** `{ time, sessionId? }` — set the clock to `time` and let it keep running
  (timers fire as wall-clock time advances them), unlike the frozen `clock_set_time`. Returns
  `{ systemTime }`.
- **`clock_advance`** `{ ms, sessionId? }` — jump the clock forward by `ms`, firing every timer due in
  that window in order, then stopping. The deterministic way to trigger time-based UI. Returns
  `{ advancedMs }`.
- **`clock_run_for`** `{ ms, sessionId? }` — tick the clock forward by `ms`, firing timers at each
  interval as they come due (unlike `clock_advance`, which jumps). For tight timer loops that
  re-schedule. Returns `{ ranForMs }`.
- **`clock_pause`** `{ time, sessionId? }` — fast-forward to `time` firing the timers due up to it, then
  hold there (a frozen pause at a future instant). Returns `{ pausedAt }`.
- **`clock_resume`** `{ sessionId? }` — resume the real clock (timers advance with real time again).
  Returns `{ resumed }`.
- **`clock_status`** `{ sessionId? }` — report whether a clock is installed and its last mode/time.
  Returns `{ installed, mode?, time? }`.

Error codes: `clock.UNSUPPORTED` (the transport cannot control the clock), `clock.NOT_INSTALLED` (a
set/advance/resume call before `clock_install`). Invalid arguments (a negative `ms`, a missing or
unparseable `time`) are core `BAD_ARGUMENT`.

## Security

Clock control **modifies app behaviour** — it changes the time the app sees and fires its timers. It is
bounded by the transport's `canControlClock` capability and the fact that the operator chose to load the
plugin. It runs **no app JavaScript** (the fake clock is a transport-level timer override, not eval), so
the plugin is not `--allow-eval` gated. It is not a secret surface — there is nothing to redact.

## Scope and limitations

- **Renderer clock only, on the Playwright launch transport.** `page.clock` overrides the renderer's
  `Date` / `setTimeout` / `setInterval`; it does not control the main process's timers. CDP-transport
  clock control (over the Emulation domain) is the deferred broader path — and it cannot resume to the
  real clock, so it stays unwired until a CDP increment maps the supported subset.
- **Install first.** `clock_install` must precede the other tools (`clock.NOT_INSTALLED` otherwise),
  and a timer must be registered by the app **after** install for the fake clock to govern it.
- **Freezing vs firing.** `clock_set_time` freezes `Date.now()` but does not fire pending timers;
  `clock_advance` / `clock_run_for` fire them. This split is deliberate — freeze to inspect, advance to
  trigger.
- **One clock per session.** Each running app session controls its clock independently, keyed by the
  unique session id. The install registry is process-global, like the other first-party plugins; run
  independent server lifecycles in separate Node processes. Requires a transport whose `canControlClock`
  capability is set (the default Playwright launch transport); others return `clock.UNSUPPORTED`.
