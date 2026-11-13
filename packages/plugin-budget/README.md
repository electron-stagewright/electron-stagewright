# @electron-stagewright/plugin-budget

Performance budgets for Electron apps: write the limits in one JSON file, measure a build, and fail
the pull request that goes over. This release ships the budget format, the pure comparison, the
bundle-size measurement, and the `electron-stagewright-budget` CLI. Live measurement of a running app
(startup, per-process memory, main-thread blocking, IPC latency) builds on the same run format.

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
electron-stagewright-budget bundle --budget perf-budget.json [--root <dir>] [--out run.json]
electron-stagewright-budget check run.json --budget perf-budget.json [--strict] [--require-measurement]
electron-stagewright-budget compare before.json after.json
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
and fails `bundle`.

## Library

```ts
import { checkRun, loadBudget, loadRun } from '@electron-stagewright/plugin-budget'

const report = checkRun(await loadRun('run.json'), await loadBudget('perf-budget.json'))
if (!report.passed) console.error(report.results.filter((r) => r.status === 'fail'))
```
