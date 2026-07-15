# bench — agent-task benchmark harness

Quantifies the token-economy thesis (ADR-007): the same agent task done with the
primitive chain versus the `expect_*` family should differ measurably in round-trips and
tokens. The harness drives scenarios over the **real MCP protocol** (an `Client` over
stdio spawning the built `cli.js`, the same path a real agent host uses) against a tiny
bench app served only at an ephemeral `127.0.0.1` HTTP origin. The real origin is deliberate:
it lets Playwright's `storageState()` capture localStorage for the storage contrast without
opening the fixture to the network. Each scenario records tool-call count, summed estimated
tokens, wall-clock latency, and main-process memory.

## Run it

From the repository root:

```sh
pnpm install
pnpm build        # builds packages/core/dist/cli.js, which the harness spawns
pnpm bench --help  # list modes and options without launching Electron
pnpm bench        # human table to stderr, JSON report to stdout
pnpm bench --json report.json   # also write the JSON report to a file
pnpm bench:check  # same run, but exit non-zero on a deterministic-metric regression
STAGEWRIGHT_BENCH_PHASE_TIMEOUT_MS=45000 pnpm bench --json output/benchmark.json
pnpm manifest:check # verify the host-visible manifest budget baseline
pnpm manifest:report -- --json output/manifest.json # write manifest measurements
pnpm bench:profiles -- --json output/profile-benchmark.json # full vs essential tasks
```

or scoped: `pnpm --filter @electron-stagewright/bench bench`.

`pnpm bench > report.json` captures the machine report while the human table stays
visible (the table is on stderr). You need a desktop session (a display): each scenario
launches a real Electron window. A relative `--json` path resolves from the repository root,
including when pnpm runs the filtered bench package from its own directory.

## Manifest budgets and core profiles

`pnpm manifest:check` captures the actual `{ tools }` object returned by MCP `tools/list`, not the
richer internal documentation manifest. It reports Unicode characters, UTF-8 bytes, GPT-class BPE
tokens, canonical tool ordering, and the ten most expensive tools for full core, every named core
profile, each first-party plugin, and all first-party plugins together, with and without eval.

The committed baseline permits no unreviewed BPE growth over 3%. Update it only after reviewing the
change and supplying a reason:

```sh
pnpm --filter @electron-stagewright/bench manifest:update -- \
  --reason "Explain the schema or capability change"
```

`full` remains the compatibility default. `pnpm bench:profiles` drives twelve real Electron tasks
against `full` and the opt-in `essential` profile, reporting task success, calls, explicit retries,
manifest BPE, response BPE, and total BPE. A smaller profile is not eligible to become the default
until it reaches at least 95% of full's task success rate and saves material context.

## Scenarios

The scenarios come in same-task **contrasts**: each pair does the identical work, where
one side uses an agent-native primitive the other lacks. The delta is the saving — and it
isolates a specific token-economy lever.

Round-trip lever (saves tool calls):

- **verify-greeting-primitive** — verify a greeting with `get_text` → `wait_for_state` →
  `get_text` (the read-compare-reread chain a primitive-only agent uses).
- **verify-greeting-expect** — verify the same greeting with a single `expect_text`.

Token lever (saves payload tokens):

- **observe-change-rescan** — after an action, find what changed by re-scanning the FULL
  snapshot of a 24-item list (two large payloads).
- **observe-change-diff** — see the same change with `snapshot({ since: 'last' })`, which
  returns only the delta (one large payload + a tiny one). On a real, larger UI this lever
  dominates — re-scanning a big tree every turn is where naive drivers burn tokens.
- **assert-storage-snapshot** — assert one non-secret persisted fixture value by returning every
  localStorage entry at the loopback origin.
- **assert-storage-local-get** — assert that identical value via the renderer-eval-gated
  `storage_local_get` tool. The app deliberately seeds additional non-secret fixture state, so this
  compares a real complete-snapshot payload against a targeted key read rather than an empty `file://`
  snapshot.

Resilience:

- **error-recovery** — a read of a not-yet-loaded element returns `SELECTOR_NO_MATCH`; the
  scenario then recovers with `expect_visible` + a re-read. Measures the cost of a
  failed-then-recovered step, not just the happy path.

## A note on the size of the deltas

The greeting contrast is one verification, so its saving is modest by construction — it
demonstrates the _mechanism_. The token-economy thesis (ADR-007) compounds: every
verification in a long session saves those round-trips, and the snapshot-diff lever grows
with the size of the UI and the number of turns. The `observe-change` contrast is the
clearer headline because re-scanning a large tree on every turn is the dominant token cost
in real agent sessions. Read the deltas as _per-step_ mechanisms that multiply across a
session, not as a single session-wide figure.

## How to read the results

Two of the four metrics are **deterministic** and the ones worth tracking for regressions:

- **tool calls** — the number of MCP round-trips the agent task took. Stable run to run.
- **estimated tokens** — the summed `_meta.estimated_tokens` of every response. Stable
  (it is a function of the response payloads, via the char/4 heuristic in core).

Two are **environment-dependent** — reported as observed, never asserted:

- **latency** — client-side wall-clock per call, summed. Varies with machine load, the
  Electron build, and the display.
- **memory** — the Electron main process's RSS, sampled once after the scenario via
  `electron_eval_main` (so the harness starts the server with `--allow-eval`). A coarse
  point sample, not a peak or a leak measurement.

## Regression thresholds

`src/thresholds.ts` holds a spec over the two deterministic metrics: each scenario's exact
tool-call count, and each contrast's minimum saving (tool calls saved, and a token-saving
**floor**). The runner always reports the threshold result; `--check` (or `pnpm bench:check`)
makes a regression exit non-zero, so the run can gate a release:

```sh
pnpm bench:check   # exits 1 if a tool-call count drifts or a saving collapses below its floor
```

Savings are floors, not exact targets — a better run never trips, and the token floor sits a
margin below the observed baseline so normal jitter does not false-trip while a real collapse
does. `checkThresholds` is a pure function, so it also runs as a fast unit test in `pnpm test`
(no Electron). A separate Linux/Xvfb diagnostic job runs the first-party harness without `--check`,
records a bounded connect/launch/scenario/memory/stop timeline for every scenario, and uploads the
JSON report without blocking a pull request. `--check` remains the real-run guard for a reviewed
local or release validation after the diagnostic evidence has proved stable.

When the bench app or a response shape legitimately changes, re-baseline with
`pnpm bench --update-thresholds`: it prints a fresh spec derived from the current run (to stderr,
alongside the table — this mode writes no JSON report to stdout) for you to paste into
`DEFAULT_THRESHOLDS`. In a normal run the machine JSON report carries the threshold outcome under
`thresholds` (`{ passed, violations }`), versioned by `schema_version`.

## Reproducible competitive comparison

`pnpm bench --compare --json artifacts/comparison.json` runs the same two observable UI tasks against
the built Stagewright server and the lockfile-pinned `electron-driver@0.3.1` adapter. Each target
launches the same fixture entry point directly through Playwright/Electron; neither receives a CDP
port, a privileged sidecar, or setup unavailable to the other.

The shared tasks use primitive type/click/wait/read interactions and one exact-text success oracle per
task. A row passes only when the expected visible text matches exactly, so both targets are held to the
same semantic outcome rather than merely completing a click.

The default protocol is two discarded warmups followed by ten retained fresh-process runs. It records
per task and target:

- calls, retries, failed calls, request-argument BPE, and response BPE;
- `tools/list` characters/BPE and cold spawn + initialize + manifest latency;
- median, nearest-rank p95, min, and max for every retained numeric measure;
- every raw warmup and retained row (including failures), plus fixture/harness SHA-256s, checkout
  commit/dirty state, host environment, executable command and entry SHA-256, pinned package
  provenance, explicit child-environment names (never values), and a target's self-reported server
  version when it differs from its package version.

Use a short run only as a local smoke:

```sh
pnpm bench --compare --compare-warmup 0 --compare-iterations 1
```

That artifact is explicitly labelled `exploratory`. A `reviewable` local artifact requires at least ten
retained successful runs and one warmup; it still is **not** a published performance claim. Publish or
repeat a comparison only from a saved artifact that names the fixture, environment, target version, npm
tarball hash, and source commit. Do not substitute an arbitrary executable at the command line: add a
pinned adapter with its provenance and shared oracle instead.

## Scope and limitations

- **First-party CI diagnostics are non-blocking.** A Linux/Xvfb job runs `pnpm bench` with a bounded
  phase timeout and uploads its JSON report. It does not run `--check` or a competitor command, so
  observed startup failures remain evidence to fix rather than a pull-request veto.
- **Competitive results are local evidence, not release copy.** The repository ships a pinned
  `electron-driver@0.3.1` adapter and test coverage for the protocol, but no numeric claim or checked-in
  benchmark result. Run it on demand, inspect the JSON artifact, and reproduce it before communicating
  a conclusion.
- **Regression thresholds enforce the deterministic metrics only** (tool-call counts +
  contrast savings) — see above. Latency and memory are never asserted. Enforcement against a
  real run is deliberate (`pnpm bench:check`); the diagnostic CI run reports those thresholds without
  enforcing them, and the pure checker runs in CI via `pnpm test`.
- The estimated-token figure uses core's char/4 heuristic, not a model tokenizer; treat
  it as a comparable proxy across scenarios, not an absolute token cost.
