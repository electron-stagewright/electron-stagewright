# bench — agent-task benchmark harness

Quantifies the token-economy thesis (ADR-007): the same agent task done with the
primitive chain versus the `expect_*` family should differ measurably in round-trips and
tokens. The harness drives scenarios over the **real MCP protocol** (an `Client` over
stdio spawning the built `cli.js`, the same path a real agent host uses) against a tiny
bench app, and records per scenario: tool-call count, summed estimated tokens, wall-clock
latency, and main-process memory.

## Run it

From the repository root:

```sh
pnpm install
pnpm build        # builds packages/core/dist/cli.js, which the harness spawns
pnpm bench        # human table to stderr, JSON report to stdout
pnpm bench --json report.json   # also write the JSON report to a file
```

or scoped: `pnpm --filter @electron-stagewright/bench bench`.

`pnpm bench > report.json` captures the machine report while the human table stays
visible (the table is on stderr). You need a desktop session (a display): each scenario
launches a real Electron window.

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

## Scope and limitations

- **Local only.** Like the other real-Electron smokes in this repo, the benchmark runs on
  demand on a machine with a display; it is not wired into CI.
- **No competitor comparison yet.** Comparing against other Electron MCP servers is
  intentionally deferred — it needs those servers installed and a fair shared task.
- **No regression thresholds yet.** The JSON report is versioned (`schema_version`) and
  stamped with the environment so a later pass can assert thresholds on the deterministic
  metrics; this slice establishes the baseline harness, not the gate.
- The estimated-token figure uses core's char/4 heuristic, not a model tokenizer; treat
  it as a comparable proxy across scenarios, not an absolute token cost.
