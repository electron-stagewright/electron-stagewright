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
  it, so blocking and IPC latency cover the interaction instead of an idle app. A window nobody
  reads stops itself after 10 minutes. Budget calls on one session run one at a time.
- **`budget_measure`** `{ budgetPath?, ipcProbe?, windowMs?, sessionId? }` — the numbers without a
  verdict: `{ measured: [{ id, value, unit, metric? }], unavailable? }`.

Main-thread blocking is the lateness of a 10 ms timer in the main process: `blockedPercent` is the
share of the window it ran 10 ms or more late, `maxStallMs` the worst single stall. The IPC probe
times one round trip of the budget's `ipc.probe` expression every `intervalMs` (default 25).
Startup is process creation to the end of the load event of the first window still open, whichever
window is selected; it is `unmeasured` once that window reloaded or navigated. Memory is read on
this host only when the host's process with the app's main pid started with the app, so an app in
another pid namespace reports memory `unmeasured` instead of a stranger's numbers.

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
- **Phase.** `startup` reads `cold` unless it names a phase. A `memory` block that names none reads
  the run's `warm` rounds, else `live`, else `cold`: a run of fresh-profile launches
  (`--phases cold`) is gated on its cold rounds.
- **Startup is not launch-to-ready.** `maxFirstWindowMs` is process creation to the end of the
  first window's load event. Work the app does after that (opening a database, fetching data,
  starting a server) is not in it, so a wall-clock launch budget converted to it gets looser
  without saying so. Time that work in a workload, or keep it in its own gate.
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
  writes the run. `--check` gates it in the same command; `--phase` reads every metric from one
  measured phase, and a metric whose phase was not measured is `unmeasured`. On Linux CI run it
  under `xvfb-run`.
- `--workload <script.mjs>` replaces the idle window with your interaction. The module
  default-exports `async ({ dispatch, sessionId, phase }) => { ... }`, where `dispatch(tool, args)`
  calls any core Stagewright tool (plugin tools are not loaded) on the launched app. The workload
  runs with your privileges and eval enabled, so pass only a script you trust. One that has not
  finished after `--workload-timeout-ms` (default 120000) fails the command:

  ```js
  export default async ({ dispatch, sessionId }) => {
    await dispatch('electron_click', { sessionId, selector: '#new-sale' })
  }
  ```

- `--before-round <script.mjs>` prepares each round before its first launch. The module
  default-exports `async ({ round, profile }) => ({ env, args })`; the returned `env` and `args`
  are added to that round's launches. Use it to hand every launch its own copy of a fixture, so
  rounds that share state do not skew the median.
- `--skip-failed-rounds` reports a round whose launch or measurement failed and goes on. Pair it
  with `--min-samples N` on the check, so a median never rests on fewer than `N` launches:

  ```sh
  electron-stagewright-budget measure --main dist/main.js --budget perf-budget.json \
    --rounds 3 --phases cold --before-round fresh-fixture.mjs --skip-failed-rounds \
    --check --min-samples 2
  ```

- `bundle` measures the `bundle` entries (paths resolve from `--root`, default the budget file's
  directory) and gates them. It needs no Electron and no display.
- `check` compares run files to the budget. Several files (`check a.json b.json c.json`) are merged
  into one run first, and values are the median over the rounds of a phase. `--min-samples N`
  leaves a runtime metric with fewer than `N` measured rounds `unmeasured`. In code,
  `mergeRuns(runs)` and `checkRun(run, budget, { minSamples })` do the same, and `measureApp` takes
  `beforeRound` and `failedRounds: 'skip'`.
- `compare` prints a before/after table of two runs.
- `--no-tolerance` ignores `thresholdPercent`, so the limit itself gates. It does not turn warnings
  into failures: every verdict already fails the command. `--strict` is a deprecated alias that
  prints a warning. `--require-measurement` fails a budgeted metric the run did not measure;
  without it that metric is listed as `unmeasured`.
- `--json` prints the machine report instead of the table.

To run the CLI from a script, resolve it instead of guessing a path inside `dist/`:

```js
const cli = fileURLToPath(import.meta.resolve('@electron-stagewright/plugin-budget/cli'))
// or, from CommonJS: require.resolve('@electron-stagewright/plugin-budget/cli')
spawn(process.execPath, [cli, 'measure', '--main', 'dist/main.js', '--out', 'run.json'])
```

Exit codes: `0` within budget, `1` over budget **or nothing measured**, `2` usage error, unreadable
input, or any other error. A bundle entry that matches no file is `unmeasured`, never zero bytes,
and fails `bundle`. `measure` writes no run when no round produced a measurement.

The inspector Stagewright attaches is part of what `measure` measures, so calibrate budgets with
this tool. A packaged build whose fuses forbid inspection cannot be measured yet.

## Library

`@electron-stagewright/plugin-budget/check` holds the budget and run formats, `checkRun`, and the
report renderers. It loads neither core nor the plugin, so a gate that only checks runs without the
MCP SDK. The root export adds `measureApp`, `measureSession` and the plugin.

```ts
import { checkRun, loadBudget, loadRun } from '@electron-stagewright/plugin-budget/check'

const report = checkRun(await loadRun('run.json'), await loadBudget('perf-budget.json'))
if (!report.passed) console.error(report.results.filter((r) => r.status === 'fail'))
```
