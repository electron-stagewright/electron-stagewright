# @electron-stagewright/plugin-budget

Performance budgets for Electron apps: write the limits in one JSON file, measure a build, and fail
the change that goes over. An agent asks `budget_check` whether its change broke a budget; CI runs the
`electron-stagewright-budget` CLI. Both read the same budget file and the same run format.

It measures startup to first window, memory per process type in the platform's own metric,
main-thread blocking, IPC round-trip latency, and bundle size. The app needs no code change: the
plugin samples through the session Stagewright already holds.

## Load it

```sh
electron-stagewright --plugin budget --allow-eval
```

```js
import { createServer } from '@electron-stagewright/core'
import budgetPlugin from '@electron-stagewright/plugin-budget'

const server = await createServer({
  plugins: [budgetPlugin],
  allowEval: true,
  pluginConfigs: { budget: { budgetFile: '/abs/path/perf-budget.json' } },
})
```

Config (`pluginConfigs.budget`): `budgetFile` (default budget for `budget_check`), `root` (where
bundle paths resolve; defaults to the budget file's directory), `windowMs` (idle window, default 2000).

| Metric                       | Needs                                              |
| ---------------------------- | -------------------------------------------------- |
| Memory, main-thread blocking | A session and main eval (`--allow-eval=main`)      |
| IPC latency, startup         | The above plus renderer eval (bare `--allow-eval`) |
| Bundle size                  | Nothing: no session, no eval                       |

The bodies evaluated in the app are fixed. The one caller-supplied expression is the IPC probe (from
`ipcProbe` or the budget file): it needs the renderer grant, passes the same blocklist as
`electron_eval_renderer`, and leaves the same audit line. Bundle entries must resolve inside `root`,
and with `--app-root` set the budget file and its entries must sit inside it.

## Tools

- **`budget_check`** `{ budgetPath?, sessionId?, windowMs?, strict?, requireMeasurement? }` — measure
  the running app and the bundle entries and compare them to the budget. Returns
  `{ passed, reason?, summary, results }`; each result is `pass`, `fail`, or `unmeasured` with the
  reason. `passed` is false when a limit is exceeded and when nothing could be measured. Visible
  without eval; then only the bundle is checked.
- **`budget_start`** `{ budgetPath?, ipcProbe?, ipcIntervalMs?, sessionId? }` — open a measurement
  window, then drive the app with the other tools. The next `budget_measure` or `budget_check` closes
  it, so blocking and IPC latency cover the interaction instead of an idle app.
- **`budget_measure`** `{ budgetPath?, ipcProbe?, windowMs?, sessionId? }` — the numbers without a
  verdict: `{ measured: [{ id, value, unit, metric? }], unavailable? }`.

Main-thread blocking is the lateness of a 10 ms timer in the main process: `blockedPercent` is the
share of the window it ran 10 ms or more late, `maxStallMs` the worst single stall. The IPC probe
times one round trip of the budget's `ipc.probe` expression every `intervalMs` (default 25).
Startup is process creation to the end of the first window's load event; it is `unmeasured` after
a reload.

## Budget file

```jsonc
{
  "thresholdPercent": 10,
  "startup": { "maxFirstWindowMs": 3000 },
  "memory": {
    "darwin": {
      "metric": "footprint",
      "phase": "warm",
      "perTypeMb": { "main": 100, "renderer": 80, "utility": 10 },
      "totalWithoutGpuMb": 160,
    },
    "win32": { "metric": "privateBytes", "perTypeMb": { "main": 90 } },
    "linux": { "metric": "pss", "perTypeMb": { "main": 90 } },
  },
  "mainThread": { "windowMs": 5000, "maxBlockedPercent": 5, "maxStallMs": 100 },
  "ipc": { "probe": "window.api.getVersion()", "maxP99Ms": 15 },
  "bundle": {
    "entries": [{ "path": "dist/renderer", "extensions": [".js"], "gzip": true, "maxKb": 500 }],
  },
}
```

- **Memory has one block per platform.** `footprint` (macOS), `pss` (Linux), `privateBytes`
  (Windows) and `workingSet` count different things, so megabytes are only ever compared within the
  metric the budget names. Every table prints the metric next to the value.
- **Processes are summed per type** (`main`, `renderer`, `gpu`, `utility`, `other`). A type the
  budget does not name is reported and never gates; GPU memory swings widely between machines, so
  leave it out unless you mean to gate it.
- **`thresholdPercent`** is the tolerance over each limit; a section may override it.
- **`$comment`** is allowed in every object. Unknown keys are rejected, so a typo cannot silently
  disable a limit.

## CLI

```sh
electron-stagewright-budget measure --main dist/main.js --budget perf-budget.json \
  --rounds 5 --out run.json --check
electron-stagewright-budget check run.json --budget perf-budget.json [--strict] [--require-measurement]
electron-stagewright-budget compare before.json after.json
electron-stagewright-budget bundle --budget perf-budget.json [--root <dir>] [--out run.json]
```

- `measure` launches the app (`--main <main.js>`, or `--executable <path>` for a packaged build;
  repeat `--arg` and `--env K=V` to pass them through) on an empty throwaway profile. Each round is
  a `cold` launch and a `warm` relaunch on the same profile (`--phases` picks one). It waits for
  the window to load, settles (`--settle-ms`, default 3000), measures a window (`--window-ms`), and
  writes the run. `--check` gates it in the same command. On Linux CI run it under `xvfb-run`.
- `--workload <script.mjs>` replaces the idle window with your interaction. The module
  default-exports `async ({ dispatch, sessionId, phase }) => { ... }`, where `dispatch(tool, args)`
  calls any Stagewright tool on the launched app:

  ```js
  export default async ({ dispatch, sessionId }) => {
    await dispatch('electron_click', { sessionId, selector: '#new-sale' })
  }
  ```

- `bundle` measures the `bundle` entries (paths resolve from `--root`, default the budget file's
  directory) and gates them. It needs no Electron and no display.
- `check` compares a run file to the budget. Values are the median over the rounds of a phase.
- `compare` prints a before/after table of two runs.
- `--strict` ignores `thresholdPercent`. `--require-measurement` fails a budgeted metric the run did
  not measure; without it that metric is listed as `unmeasured`.
- `--json` prints the machine report instead of the table.

Exit codes: `0` within budget, `1` over budget **or nothing measured**, `2` usage error, unreadable
input, or any other error. A bundle entry that matches no file is `unmeasured`, never zero bytes,
and fails `bundle`. `measure` writes no run when no round produced a measurement.

The inspector Stagewright attaches is part of what `measure` measures, so calibrate budgets with
this tool. A packaged build whose fuses forbid inspection cannot be measured yet.

## Library

```ts
import { checkRun, loadBudget, loadRun } from '@electron-stagewright/plugin-budget'

const report = checkRun(await loadRun('run.json'), await loadBudget('perf-budget.json'))
if (!report.passed) console.error(report.results.filter((r) => r.status === 'fail'))
```
