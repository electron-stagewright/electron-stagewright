# ADR-030: Performance budget plugin

- **Status:** Proposed
- **Date:** 2026-11-13

## Context

An agent that changes an Electron app can check that the UI still works, but not that the change
kept the app within its performance limits. Teams that gate performance today write one-off
scripts per app: launch the build, read a number, compare it to a constant. The numbers are easy to
get subtly wrong. Working set, footprint, Pss and private bytes are different quantities; the GPU
process swings by hundreds of megabytes between machines; and a first launch and a relaunch load
different code paths.

Stagewright already holds a session on the real app, in the real main process, on three operating
systems. That is enough to measure without adding code to the app.

## Decision

Ship `@electron-stagewright/plugin-budget`: one budget file, one run format, an MCP face for agents
and a CLI for CI, both driving the same measurement code.

- **Measure through the session, classify by Electron, read from the OS.** `app.getAppMetrics()`
  supplies each process's pid and type. The host then reads each pid in the platform's own metric:
  `footprint` on macOS (`/usr/bin/footprint`), `pss` on Linux (`/proc/<pid>/smaps_rollup`), and
  `privateBytes` on Windows (already in the metrics). Working set is always recorded as well. The
  host reads a pid only when its process started when the app's main process did (`/proc` on
  Linux, `ps` on macOS); otherwise the app sits in another pid namespace and memory is
  `unmeasured`. When the host cannot tell, the read proceeds. Only plain integer pids reach the
  host.
- **Never compare across metrics.** A memory budget is a per-platform block that names its metric.
  A run measured in another metric is `unmeasured`, and every table prints the metric.
- **Sum per process type; GPU gates only when named.** Types are `main`, `renderer`, `gpu`,
  `utility`, `other`. A type the budget does not list is reported and never gates.
- **Main-thread blocking is the lateness of a 10 ms main-process timer.** Lateness of 10 ms or more
  counts as blocked. The budget limits the blocked share of the window and the worst stall. The
  timer is one per process, so budget calls on a session run one at a time, and a window nobody
  reads stops itself after 10 minutes.
- **IPC latency needs an app-specific probe.** The budget names a renderer expression that performs
  one round trip. Without it IPC is not measured: there is no generic channel every app exposes.
- **Startup is process creation to the end of the first window's load event,** from
  `process.getCreationTime()` and the navigation timing of the first window still open, read from
  the main process so the selected window does not matter. After a reload or a navigation of that
  window it is `unmeasured`.
- **Bundle size is bytes on disk** for the files or directories the budget lists, optionally
  gzipped. It needs no session.
- **Empty never passes.** A check with no expectation, or with no measurement, fails. A bundle entry
  that matches no file is `unmeasured`, not zero bytes. `measure` writes no run when no round
  produced one.
- **Phases.** The CLI measures a `cold` launch on an empty throwaway profile and a `warm` relaunch
  on it, for several rounds; a check reads the median. A live agent session is the `live` phase.

### Security posture (extends ADR-014)

- `budget_start` and `budget_measure` evaluate fixed bodies in the main process. They declare the
  main eval target and re-assert the grant at the tool boundary (as ADR-010 requires).
- `budget_check` stays visible without eval. It then checks bundle size only and reports every
  runtime metric as `unmeasured` with the reason, so an agent learns what to enable.
- Startup timing is a fixed body the main process runs in the first window
  (`webContents.executeJavaScript`). It reaches a renderer, so it still needs the renderer grant.
- The IPC probe is the one caller-supplied expression. It needs the renderer grant, passes the eval
  blocklist, and is audit-logged by length and hash, like `electron_eval_renderer`.
- The budget path is agent-supplied, so file reads are confined: bundle entries must resolve inside
  the bundle root, the budget file and its entries inside `--app-root` when one is set, and
  symlinks are resolved first. An unparseable budget does not echo the parser message.
- The `measure` CLI is operator-run, not agent-reachable. It grants itself eval for the same fixed
  bodies, and the `--main`, `--executable` and `--workload` it runs are operator code with the
  operator's privileges, on a throwaway profile it removes afterwards.

## Alternatives considered

- **Measure from outside, with no session** (spawn the binary, walk the process tree, classify by
  `--type=`). It works on builds whose fuses forbid inspection, and it does not perturb the main
  process. It cannot see main-thread blocking or IPC latency, needs a process-tree reader per
  platform, and would be a second measurement path beside the one agents use. Deferred; the run
  format does not preclude it.
- **A probe module the app imports.** Rejected: it puts measurement code in the product and makes
  the budget unusable on an app that has not adopted it.
- **Extend `packages/bench`.** Rejected: bench quantifies Stagewright's own token economy against a
  fixed fixture. Its single main-process RSS sample stays as it is.
- **One memory number for all platforms.** Rejected: there is no metric all three systems share
  that matches what their users see.

## Consequences

- Runtime metrics require main eval, and the inspector Stagewright attaches is part of what is
  measured. Budgets should be calibrated with the tool that enforces them.
- Hosted Windows and Linux runners render in software, so their GPU process does not represent a
  user's machine. This is one more reason GPU does not gate by default.
- Linux Pss reads depend on `/proc` permissions; an unreadable pid is `unmeasured`, never guessed.
- Budgets calibrated in working set must be recalibrated when they move to the platform metric.
