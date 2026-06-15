# Security model and threat model

This page is the canonical threat model for the Electron Stagewright MCP server. It
states what the server can touch, who it trusts, what stops misuse, and what risk
remains. If you are deciding whether to point an agent at the server, read this
first. The posture summarised here is recorded as a decision in
[ADR-014](../adr/014-security-posture-and-threat-model.md); to report a
vulnerability see [SECURITY.md](../../.github/SECURITY.md).

## The one-line model

The server is a **privileged local tool**, not a sandbox. It runs with your OS
privileges, drives a real desktop app, and — when you enable the `--allow-eval`
policy — runs arbitrary JavaScript inside that app. Treat it the way you would treat
a shell: only let a **trusted agent host** invoke it. The default transport is stdio
(a local child process), so the trust boundary stays local unless you deliberately
put a network in front of it.

## Assets

What an attacker would want, in rough order of value:

- **The host machine.** The server can launch processes and read files within its
  launch surface, with the operator's privileges.
- **The target app's runtime.** Under the `--allow-eval` policy, arbitrary main- and/or
  renderer-process code; without it, the granular tools still drive the app (click,
  type, navigate).
- **Captured data.** Screenshots, console logs, and session traces can contain
  secrets the app displayed; IPC capture can record channel payloads.
- **Code-signing identity.** The `production_validate` tool reads signed `.app`
  bundles and their updater feeds, and may return bounded evidence such as a
  signing authority in its local tool result.

## Trust boundaries

1. **Agent host → server.** The agent supplies every tool input. Inputs are treated
   as untrusted and possibly hostile (a hallucinating or prompt-injected agent).
2. **Server → target app.** The server drives the app and, under eval, runs code in
   it. The app is assumed at least semi-trusted (it is the thing under test).
3. **Server → host filesystem.** Launch paths, screenshot output, and trace
   artifacts touch disk.

## Threat actors

- **A misbehaving agent** — hallucinated or prompt-injected tool calls. The primary
  actor the controls below target.
- **A malicious app under test** — could try to abuse the driving channel. Out of
  primary scope (you chose to test it), but the server avoids handing it the protocol
  channel or unbounded waits.
- **A local reader of artifacts** — anyone who can read the trace/screenshot output
  directory.

## Controls (threats × mitigations)

| Threat                                                                  | Control                                                                                                                                                                                                                                                                                                                               | Residual                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Arbitrary code execution via eval                                       | `electron_eval_main` / `electron_eval_renderer` are **unregistered unless `--allow-eval` permits their target** (per-target least privilege — `--allow-eval=renderer` grants only the renderer); payloads pass a keyword blocklist; calls are audited to stderr (length + a content hash, never the payload); results are size-capped | The blocklist is defence-in-depth, **bypassable** by a determined payload — see below  |
| A plugin running main-process code behind the operator's back           | Any plugin using the eval seam (`transport.evaluate('main')`) **re-asserts the main eval opt-in** (`--allow-eval=main`, or bare `--allow-eval`) at its own tool boundary; today that covers `ipc_capture_start`, `ipc_captured`, `ipc_capture_stop`, `ipc_invoke`, and `ipc_stub` ([ADR-010](../adr/010-ipc-plugin.md))               | —                                                                                      |
| Over-broad IPC capture / injection                                      | `ipc_capture_start` requires an **explicit channel allowlist**; `ipc_stub` is allowlist-bound; `ipc_invoke` has an optional allowlist; `redact` drops named fields                                                                                                                                                                    | Capture defaults are not redacted unless configured                                    |
| Path traversal / arbitrary process launch                               | `--app-root` confines `main` / `executablePath` / `cwd` and blocks `..` escape; runtime-altering env vars (`NODE_OPTIONS`, `LD_*`, `DYLD_*`, …) are **refused**                                                                                                                                                                       | Without `--app-root`, launch paths are unconstrained (local-tool model)                |
| Protocol-channel corruption                                             | **stdout is JSON-RPC only**; all diagnostics go to stderr, enforced by a CI gate                                                                                                                                                                                                                                                      | —                                                                                      |
| Denial of service via a hung app                                        | A per-operation **timeout backstop** ([ADR-011](../adr/011-operation-timeout.md)) abandons a non-settling handler and returns a retryable error                                                                                                                                                                                       | The abandoned op dies with the session                                                 |
| Secret exfiltration via captured data and artifacts                     | Trace and IPC captures support `redact` for structured argument/payload fields; screenshots and trace artifacts are written only where the operator points them                                                                                                                                                                       | Screenshots, console output, tool results, and unredacted payloads can contain secrets |
| Prototype-pollution via untrusted string lookups                        | Lookups keyed by tool input guard against inherited `Object.prototype` members                                                                                                                                                                                                                                                        | —                                                                                      |
| Catastrophic-backtracking regex (ReDoS) in `expect`/`assert` predicates | Predicate flags are validated as defence-in-depth                                                                                                                                                                                                                                                                                     | Not a complete decision procedure                                                      |

## The eval blocklist, precisely

The blocklist scans eval source for: `process.exit`, `require(`, `eval(`,
`Function(`, `__proto__`, `child_process`. It is intentionally **minimal** — it
catches the obvious foot-guns that should stay blocked even when the eval tools are
visible. It is **not** a sound analyzer: string obfuscation, encoding, or indirect
access defeats it. The real control is the `--allow-eval` opt-in plus the
"privileged local tool" trust boundary; the blocklist is a seatbelt, not a wall.

**The gate is per-target.** `--allow-eval` accepts targets: bare `--allow-eval`
enables both, while `--allow-eval=main` or `--allow-eval=renderer` enable only one.
Each eval tool registers only when its target is permitted, so a renderer-only
automation never exposes the main-process surface (full Node/Electron). A plugin that
reaches the main process through the eval seam (IPC capture) is gated on the main
target too, so it is unavailable under a renderer-only policy.

**Every eval is audited.** A stderr breadcrumb records each call — tool, target,
session, code length, and a `code_hash` (an FNV-1a of the payload, never the payload
itself). A blocked `EVAL_BLOCKED_KEYWORD` error carries the same `code_hash`, so a
rejected payload can be correlated with the logs without ever being recorded.

## Residual risks and recommendations

- **AST inspection is the open hardening item.** The per-target authorization policy
  and the content-hash audit have shipped; structural (AST) inspection of eval payloads
  has not. A sound analyzer is a separate design effort, and an honest blocklist beats
  an over-claimed weak one — so the keyword blocklist stays a seatbelt, not a wall.
- **Do not expose the server to an untrusted agent host**, and do not put a network
  transport in front of it, until that hardening lands. The supported model is a
  local stdio child process driven by a host you trust.
- **Configure `redact`** for structured trace arguments and IPC payload fields
  that can carry credentials, tokens, or PII before capturing. It is not a
  screenshot, console-output, or arbitrary-result scrubber. See
  [Capture diagnostics](./capture-diagnostics.md).
- **Set `--app-root`** when launching untrusted or agent-chosen app paths, to confine
  the launch surface.

## Deploying safely — checklist

- Run the server as a local stdio child of a trusted host. Do not expose it on a
  network.
- Leave `--allow-eval` **off** unless a flow genuinely needs it; prefer the granular
  tools. When you do need it, grant the **narrowest target**: `--allow-eval=renderer`
  for page-state flows, and `--allow-eval=main` only when a flow truly needs Node-level
  access in the app's main process.
- Set `--app-root` to the project you are testing.
- Configure `redact` for sensitive channels/traces; write artifacts to a directory
  you control.
- Treat the agent's tool inputs as untrusted — the server does, but your host should
  not relay inputs from an untrusted source.

The full per-tool contracts (including which tools require `--allow-eval`) are in the
generated [TOOL-REFERENCE.md](../../TOOL-REFERENCE.md).
