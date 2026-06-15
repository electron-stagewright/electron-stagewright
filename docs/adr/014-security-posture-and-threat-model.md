# ADR-014: Security posture and threat model

Status: Accepted

## Context

Electron Stagewright drives real desktop applications, and with an eval opt-in
(`--allow-eval` or a target-specific variant) it runs arbitrary JavaScript inside
the app under test (main and/or renderer). That power is the point — it is the
escape hatch for flows no granular tool covers — but it means an operator deciding
whether to point an agent at the server needs to understand exactly what the server
can reach and what constrains it.

Those constraints already exist, but they were scattered across individual ADRs,
code comments, and a placeholder "in progress" note in `.github/SECURITY.md`. No
single document stated the trust model, enumerated the controls, or named the
residual risks. This ADR records the overall security posture as a decision and
anchors the published threat model; the detailed analysis lives in
[`../guides/security-model.md`](../guides/security-model.md).

## Decision

### 1. The server is a privileged local tool, not a sandbox

The server runs with the operator's OS privileges and can launch processes, read
files within its launch surface, and (under an eval opt-in) execute arbitrary code in
the target app. It does not sandbox the agent. The trust boundary is therefore the
agent host: **only a trusted agent host should be allowed to invoke the server.**
The default transport is stdio (a local child process), not a network listener,
which keeps that boundary local by construction.

### 2. Eval is the central risk and is default-deny

- `electron_eval_main` / `electron_eval_renderer` are not registered at all unless
  the eval policy permits their target; without that opt-in they never appear in
  `tools/list` and a call is a gated-tool error naming the needed flag.
- Every eval payload passes a keyword blocklist
  (`process.exit`, `require(`, `eval(`, `Function(`, `__proto__`, `child_process`)
  before the handler runs. This is **defence-in-depth, not a complete decision
  procedure** — it stops the obvious foot-guns, not a determined bypass.
- A stderr-only audit breadcrumb records each eval call (tool, target, session, code
  **length**, and a `code_hash` — never the payload).
- Eval results are size-capped before they reach the agent.
- A plugin that reaches `transport.evaluate('main')` directly (e.g. the IPC plugin)
  must re-assert the main eval opt-in at its own tool boundary (ADR-010).

### 3. The supporting controls

Capture/instrumentation is bounded by **explicit channel allowlists** (IPC) with
opt-in `redact` for captured payloads; launches are **confined** (`--app-root`
blocks `..` escape; runtime-altering env vars like `NODE_OPTIONS` / `LD_*` /
`DYLD_*` are refused); the protocol channel is kept clean (stdout is JSON-RPC only,
all diagnostics to stderr); a per-operation **timeout backstop** (ADR-011) prevents
a hung app from wedging the dispatch; untrusted-string lookups avoid prototype
pollution.

### 4. The threat model is published and kept honest

The canonical threat model is `docs/guides/security-model.md`; `.github/SECURITY.md`
summarises it and carries the reporting policy. A CI guard asserts the threat model
names every `--allow-eval`-gated tool, so a future eval-gated tool cannot ship
without a security-model entry.

### 5. Structural eval inspection is deferred, not done

AST inspection is recommended in the threat model but **not implemented here** — it
is a design change that needs deliberate input. Per-target authorization and the
content-hash audit are recorded in the status update below; the remaining posture is
the safe default (opt-in + blocklist + audit + cap) plus an honest statement of the
residual risk.

## Rationale

Eval cannot be removed without gutting the escape-hatch use case, and it cannot be
fully sandboxed without defeating its purpose (driving the real app). The
proportionate posture for a pre-1.0 **local** tool is: make the dangerous surface
opt-in and default-deny, add cheap defence-in-depth, keep diagnostics off the
protocol channel, make captured-data risk explicit with redaction hooks, and state
plainly that the operator owns the trust boundary. Publishing the model — including
the parts that are only defence-in-depth — is more useful than implying a stronger
guarantee than the code makes.

## Alternatives considered

- **Sandbox eval (a restricted VM / allowlisted globals)** — rejected; the tool's
  job is to run real code in the real app, and a sandbox that could be driven
  usefully would be nearly as powerful as no sandbox.
- **Remove the eval tools entirely** — rejected; they are the documented escape
  hatch, already gated and opt-in.
- **Ship a complete static analyzer for eval payloads now** — deferred; a sound
  analyzer is a real design effort, and over-claiming a weak one is worse than an
  honest blocklist + recommendation.

## Consequences

- A single published threat model + a `SECURITY.md` summary; operators can make an
  informed deploy decision.
- The eval keyword blocklist is bypassable by construction; this is documented, not
  hidden, and the hardening path is recorded as future work.
- New `--allow-eval`-gated tools must be added to the security model (enforced by a
  CI guard), so the model cannot silently rot.
- The "privileged local tool" framing is now explicit: exposing the server to an
  untrusted agent host, or over a network transport, is out of the supported model
  until that hardening lands.

## Related decisions

- ADR-010 (IPC plugin) — the eval-seam re-assertion of the main eval opt-in and the
  channel-allowlist model.
- ADR-011 (operation-timeout backstop) — the hung-app control.
- ADR-006 (error code registry) — `EVAL_BLOCKED_KEYWORD` and the stable-code envelope.
- ADR-007 (agent-native UX principles) — error transparency the security surfaces rely on.
- ADR-002 (runtime and language) — the Node/ESM baseline the controls run on.

## References

- `docs/guides/security-model.md` — the full threat model (assets, boundaries,
  threats × mitigations, residual risks).
- `.github/SECURITY.md` — reporting policy + high-level summary.
- `packages/core/src/tools/eval/eval.ts` — the eval tools (gate, audit, result cap).
- `packages/core/src/errors/operation-type.ts` — the eval keyword blocklist.
- `packages/core/src/tools/lifecycle/launch.ts` — `--app-root` confinement + denied env keys.

## Status Update — 2026-06-14

The first hardening increment from §5 has shipped: **per-target eval authorization** and
a **content-hash audit**. AST inspection remains the single deferred item.

- **Per-target authorization.** `--allow-eval` is no longer one binary switch — it takes
  optional targets: bare `--allow-eval` (both), `--allow-eval=main`, `--allow-eval=renderer`,
  or `--allow-eval=main,renderer`. Each eval tool registers only when its target is permitted
  (default-deny-by-absence, unchanged). Main-process eval (full Node/Electron) and renderer
  eval (the web page) have very different blast radii, so an operator can now grant least
  privilege: a renderer-only automation never exposes the main-process surface. This
  implements the "authorization policy (per-tool or per-channel)" item §5 deferred. The
  gated-tool error names the exact flag needed (`--allow-eval=renderer`), so a blocked call
  is recoverable rather than mistaken for a typo.
- **The plugin eval gate is per-target.** A plugin reaching `transport.evaluate('main')`
  directly (the IPC plugin) gates on `ctx.allowEval`, which now means "main eval permitted",
  so main-process instrumentation is correctly denied under a renderer-only policy (ADR-010).
- **Content-hash audit.** The stderr eval breadcrumb gains a stable `code_hash` (FNV-1a over
  the payload), and a blocked `EVAL_BLOCKED_KEYWORD` error carries the same hash — so an
  operator can correlate a repeated or rejected payload across the logs without the payload
  itself ever being recorded. This is the "richer audit log" item from §5.
- **Still deferred:** AST/structural inspection of eval payloads. The keyword blocklist
  remains a deliberately weak seatbelt (string obfuscation defeats it); a sound analyzer is a
  separate design effort, and §5's rationale — an honest blocklist beats an over-claimed weak
  analyzer — stands. The trust boundary (a trusted local agent host) is unchanged.
