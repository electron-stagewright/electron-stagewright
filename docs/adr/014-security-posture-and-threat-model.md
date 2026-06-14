# ADR-014: Security posture and threat model

Status: Accepted

## Context

Electron Stagewright drives real desktop applications, and with the `--allow-eval`
opt-in it runs arbitrary JavaScript inside the app under test (main and renderer).
That power is the point — it is the escape hatch for flows no granular tool covers —
but it means an operator deciding whether to point an agent at the server needs to
understand exactly what the server can reach and what constrains it.

Those constraints already exist, but they were scattered across individual ADRs,
code comments, and a placeholder "in progress" note in `.github/SECURITY.md`. No
single document stated the trust model, enumerated the controls, or named the
residual risks. This ADR records the overall security posture as a decision and
anchors the published threat model; the detailed analysis lives in
[`../guides/security-model.md`](../guides/security-model.md).

## Decision

### 1. The server is a privileged local tool, not a sandbox

The server runs with the operator's OS privileges and can launch processes, read
files within its launch surface, and (under `--allow-eval`) execute arbitrary code
in the target app. It does not sandbox the agent. The trust boundary is therefore
the agent host: **only a trusted agent host should be allowed to invoke the
server.** The default transport is stdio (a local child process), not a network
listener, which keeps that boundary local by construction.

### 2. Eval is the central risk and is default-deny

- `electron_eval_main` / `electron_eval_renderer` are not registered at all unless
  the server was started with `--allow-eval`; without the flag they never appear in
  `tools/list` and a call is an unknown tool.
- Every eval payload passes a keyword blocklist
  (`process.exit`, `require(`, `eval(`, `Function(`, `__proto__`, `child_process`)
  before the handler runs. This is **defence-in-depth, not a complete decision
  procedure** — it stops the obvious foot-guns, not a determined bypass.
- A stderr-only audit breadcrumb records each eval call (tool, target, session, and
  the code **length** — never the payload).
- Eval results are size-capped before they reach the agent.
- A plugin that reaches `transport.evaluate('main')` directly (e.g. the IPC plugin)
  must re-assert the same `--allow-eval` gate at its own tool boundary (ADR-010).

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

### 5. Deeper eval hardening is deferred, not done

AST inspection, an authorization policy, and a richer audit log are recommended in
the threat model but **not implemented here** — they are a design change that needs
deliberate input. The current posture is the safe default (opt-in + blocklist +
audit + cap) plus an honest statement of the residual risk.

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

- ADR-010 (IPC plugin) — the eval-seam re-assertion of `--allow-eval` and the
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
