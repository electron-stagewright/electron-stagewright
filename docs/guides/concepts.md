# Concepts — how Electron Stagewright works, and why

This is the **explanation** layer of the docs: the model behind the tools, and the
reasoning behind it. If you want to _do_ something, start with the
[guides](./README.md); if you want the exact contract of a tool, see the generated
[tool reference](../../TOOL-REFERENCE.md). This page is for understanding _why_ the
server is shaped the way it is. The decisions referenced here are recorded as
[ADRs](../adr/README.md).

## The throughline: built for an agent, not a human

Most desktop-automation tools assume a human is watching: they throw stack traces,
return raw values, and expect you to read the screen between steps. Electron
Stagewright assumes the caller is an **LLM agent** that has to decide its next move
from the result alone — no screen, no prior context beyond what the tool returns.
Every design choice below follows from that. The principles are recorded in
[ADR-007](../adr/007-agent-native-ux-principles.md).

## The response envelope

Every tool returns a JSON object discriminated by `ok`. On success it carries
`ok: true` plus the tool's result fields; on failure it carries `ok: false` with a
**stable `code`**, a human-readable `error`, a `hint`, a `retryable` flag, an
HTTP-equivalent `http` status, and often `next_actions` (concrete tool calls to try
next) and `similar_refs` (candidates when a handle missed). A `_meta` block adds
`estimated_tokens` and `elapsed_ms`. See the
[root README](../../README.md#what-each-response-looks-like-the-agent-ux-detail) for
a worked example.

**Branch on `code`, never on the prose `error`.** The codes are a closed registry —
they do not change wording out from under you — so an agent can switch on them
reliably; the `error` string is for a human reading a log. This registry-plus-
envelope design is [ADR-006](../adr/006-error-code-registry.md). The point is that a
failure is _actionable_: the agent learns what went wrong (`code`), whether retrying
could help (`retryable`), and what to do instead (`next_actions`) without asking for
more context.

## Addressing elements: refs vs selectors

You can target an element two ways: a **ref** (a small integer handle from a
snapshot) or a **selector** (CSS or a role/name query). Prefer refs. A ref is
reconciled across snapshots by the element's fingerprint; if several elements share
the same fingerprint, they are paired in document order. Within one renderer session,
that means the same logical button keeps its ref across ordinary DOM re-renders when
its fingerprint and relative duplicate order stay stable. A renderer **reload** or
route change is the exception — it invalidates the stored ref map, so the server
forces a fresh snapshot and flags `renderer_reloaded`, the signal to re-read before
acting. Selectors are fine for stable, well-known elements, but a positional or
brittle selector breaks the moment the UI shifts. The snapshot schema, fingerprint
reconciliation, and the reload signal are
[ADR-005](../adr/005-snapshot-schema-v1.md).

## Snapshots and diffs

`electron_snapshot` returns an accessibility-tree view of the renderer — roles,
names, states, and refs — rather than raw HTML, because that is the level an agent
reasons at. Because a full tree is large, the server can return a **compact diff**
since the last snapshot (what changed) instead of the whole tree again, keeping the
agent's token budget under control. `electron_find` narrows to the element you mean
by role and name. Same decision record: [ADR-005](../adr/005-snapshot-schema-v1.md).

## Assertions that retry: the expect family

A naive check is a loop — read state, compare, wait, read again — and each turn of
that loop is a tool call and tokens. The `electron_expect_*` family collapses it into
one call: you state the condition you expect (text, value, visibility, count, URL,
state), and the server polls until it holds or the timeout elapses, returning a
single `matched: true` or an `EXPECTATION_FAILED` envelope. One call instead of a
read-compare-retry chain. The expectation codes live in the same registry,
[ADR-006](../adr/006-error-code-registry.md); for the how-to, see
[Assert UI state](./assert-ui-state.md).

## Sessions and transports

A **session** is one running app the server is driving; you get one from
`electron_launch` (start it), `electron_attach` (connect to a running one), or
`electron_inject` (a Node-Inspector handshake into an existing process), and you end
it with `electron_stop`. Each session is produced by a **transport** behind a single
`ITransport` interface, and each transport advertises its **capabilities** — whether
it can eval in the main process, intercept, control the clock, and so on — so a tool
whose capability the transport lacks fails honestly with a capability error
(`TRANSPORT_UNSUPPORTED` when the matrix rules it out, `NOT_IMPLEMENTED` when a
transport claims the capability but defers the body) rather than silently doing
nothing. The transport abstraction is
[ADR-003](../adr/003-transport-abstraction.md); see
[Launch, attach, or inject](./launch-or-attach.md) for choosing one.

## Eval and plugins: power, gated

Two pieces are deliberately kept behind explicit opt-ins:

- **Eval** (`electron_eval_main` / `electron_eval_renderer`) runs arbitrary
  JavaScript in the app. It is the escape hatch for flows no granular tool covers,
  and it is **default-deny**: the tools are not even registered without
  `--allow-eval`. The full trust model is in the
  [security model](./security-model.md) and
  [ADR-014](../adr/014-security-posture-and-threat-model.md).
- **Plugins** ship domain capabilities (traces, IPC capture, production validation)
  as separate packages loaded explicitly with `--plugin` — the core never auto-scans.
  The contract is [ADR-004](../adr/004-plugin-model.md); IPC capture, which reaches
  the main process through the eval seam, re-asserts the same `--allow-eval` gate
  ([ADR-010](../adr/010-ipc-plugin.md)).

## Glossary

- **Envelope** — the `{ ok, ... }` object every tool returns; branch on `code`, not `error`.
- **Code** — a stable, registry-defined failure identifier (e.g. `REF_NOT_FOUND`).
- **Ref** — an integer handle to an element, reconciled by fingerprint across snapshots (and document order for duplicate fingerprints); preferred over a selector.
- **Snapshot** — an accessibility-tree view of the renderer (roles, names, states, refs).
- **Diff** — the compact "what changed since last snapshot," returned to save tokens.
- **Session** — one running app the server is driving, identified by a `session_id`.
- **Transport** — the backend that produces a session (`PlaywrightElectronTransport`, `CDPTransport`, `InjectorTransport`) behind one `ITransport` interface, advertising its capabilities.
- **Eval gate** — the `--allow-eval` opt-in that must be set before any arbitrary-JS tool is registered.
- **Plugin** — a `@electron-stagewright/plugin-*` package loaded with `--plugin`, adding namespaced tools.
