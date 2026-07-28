# ADR-026: Workflow composition without hidden tool calls

- **Status:** Proposed
- **Date:** 2026-07-27

## Context

Repeated Electron automation flows invite a “macro” feature: one call could launch an app, inspect
it, interact, assert, and collect evidence. Fewer model turns can reduce latency and context use.
The word _macro_, however, hides three materially different designs:

1. a generic tool such as `run_macro({ command, args })` or `run_workflow({ steps })`;
2. a named server-side tool whose handler re-dispatches a fixed sequence of other tools;
3. a user-reviewed workflow artifact executed outside the model's interactive tool-selection loop.

The first design conflicts directly with ADR-007. Independent Electron MCP implementations moved
away from nested command selectors because granular top-level tools materially improved model tool
selection and argument accuracy. A generic step runner would reintroduce the same ambiguity under a
new name.

The second design is typed and discoverable, but it cannot currently preserve every authorization
and trace guarantee:

- `ToolContext.dispatch` does run nested calls through Stagewright's Zod validation,
  operation-type routing, eval policy, dispatch guards, observer funnel, and error envelopes.
- The MCP host still receives only the outer `tools/call`. It cannot apply its normal per-tool
  confirmation policy to a nested destructive or eval call. Tool annotations describe aggregate
  risk to the host, but the MCP specification defines them as advisory hints rather than an
  authorization contract.
- The trace observer records every completed dispatch. Nested calls complete before their parent
  composition, so a trace currently contains both the leaf calls and the outer call without causal
  metadata. Replaying that sequence cannot be both successful and exactly once: the headless runner
  would execute the leaf calls directly and then again through the parent, while in-server trace
  replay would hit the current re-dispatch depth limit when the replayed parent invokes its leaves.
- Raising the re-dispatch depth limit would permit longer compositions, but it would not solve
  hidden authorization or replay duplication.

The third design already has a concrete foundation: ADR-009's promoted replay specifications are
reviewable JSON, validate each fixed tool call through the dispatcher, preserve explicit
checkpoints, and run headlessly in CI. They are automation artifacts rather than model-selected
interactive macros.

MCP also distinguishes user-controlled prompts from model-controlled tools. A prompt or documented
recipe can guide an interactive sequence while leaving every underlying tool call visible to the
host. Experimental MCP tasks provide deferred execution and polling; they do not make nested tool
authorization visible and therefore do not resolve this decision.

## Decision

### 1. Do not add a generic macro or workflow-runner tool

Electron Stagewright will not ship a public tool whose input selects arbitrary commands, tool names,
or step arrays. In particular, no `electron_macro`, `run_macro`, or `run_workflow({ steps })`
surface will be registered.

This preserves the granular tool-selection contract and prevents one broadly approved tool from
becoming an unbounded proxy for the rest of the manifest.

### 2. Keep interactive composition host-visible

Interactive recipes remain sequences of ordinary top-level tool calls. They may be taught through
server instructions, resources, documentation, or a future MCP prompt surface, but the recipe
itself does not execute tools.

This means:

- the host sees and can authorize every action;
- each call keeps its own typed schema, annotation, progress, timeout, and error envelope;
- traces contain one record per action with no parent/child replay ambiguity;
- an agent can stop, inspect, or change course between steps.

Prompts are optional guidance, not a prerequisite for using the server. A future prompt addition
must be validated against at least two supported MCP hosts before public documentation depends on
it.

### 3. Keep deterministic automation in reviewed replay specifications

Repeatable unattended workflows continue to use `stagewright-replay` specifications and the
`electron-stagewright-replay` runner from ADR-009. The specification fixes tool names and
arguments in a reviewable artifact; execution sends every step through the normal dispatcher.

The first eligible composition enhancement is parameterization of replay specifications, not a
model-facing macro engine. It requires a separate ADR amendment and must satisfy all of these
constraints:

- parameters are declared and typed before execution;
- every supplied value is validated before the first tool dispatch;
- placeholders replace whole JSON values only — no expressions, string interpolation, or dynamic
  object keys;
- tool names and control flow remain fixed in the reviewed artifact;
- no loops, branches, parallel execution, result-to-argument scripting, or arbitrary code;
- sensitive parameters have an explicit redaction policy for reports and traces;
- unknown, missing, or unused parameters fail before any side effect;
- every step still goes through dispatcher validation, eval gating, guards, timeouts, progress,
  observers, and the normal success/error envelope.

### 4. Ship no server-side macro set under the current protocol contract

The canonical launch-then-snapshot flow and failure-diagnostics flow are useful recipes, but current
evidence does not justify hiding their component calls from the host. They remain documented
sequences until the revisit gates below are met.

A future server-side composition is eligible only when all of the following are true:

1. The exact nested plan and its aggregate effects are visible to the host before execution, with
   an authorization mechanism stronger than advisory tool annotations.
2. Dispatch records carry causal identity and the trace/replay format proves that a composed flow
   executes exactly once.
3. A benchmark against the same granular sequence shows a material token or latency improvement
   without reducing task success or recovery quality.
4. The first set consists of a small number of statically named, statically typed workflows; it
   excludes eval and destructive operations.
5. Every workflow declares its leaf tools, failure policy, partial-effect behavior, timeout budget,
   and cleanup behavior in its public contract.

## Rationale

This decision separates two goals that are easy to conflate:

- **Teach an agent a reliable sequence.** Instructions, resources, prompts, and guides can do this
  while every call remains visible.
- **Execute a sequence as one privileged operation.** This needs an authorization and provenance
  contract that the current MCP call boundary and trace schema do not provide.

Reducing turns is valuable only if it does not weaken authorization, repeat effects during replay,
or recreate the nested-selector accuracy problem the project was designed to avoid. The existing
replay-spec path already handles unattended, reviewable automation; it is the safer place to evolve
parameterized composition when evidence requires it.

## Alternatives considered

- **One generic macro tool with a command or step discriminator** — rejected. It expands one
  approval into arbitrary behavior and repeats the empirically worse nested-command design.
- **A first-party workflow plugin with fixed composite tools** — deferred. Static names and schemas
  solve discoverability, but the host still cannot authorize nested actions independently and the
  current trace format cannot replay parent plus children safely.
- **Increase the dispatcher re-dispatch limit** — rejected as a standalone solution. It changes
  recursion capacity, not authorization or provenance.
- **Treat tool annotations as authorization** — rejected. MCP explicitly defines annotations as
  untrusted hints; enforcement belongs in the authorization/runtime boundary.
- **Use MCP tasks for macros** — rejected. Tasks address call-now/fetch-later execution, progress,
  and cancellation; they do not expose nested tool calls for host approval.
- **Parameterize promoted replay specifications immediately** — deferred to a focused amendment.
  The direction is compatible with this decision, but parameter typing, redaction, and
  fail-before-side-effect behavior need their own acceptance criteria and tests.

## Consequences

- The public interactive tool surface remains granular; there is no macro implementation to ship
  with this ADR.
- Users keep two explicit composition paths: host-visible interactive recipes and reviewed
  replay specifications for unattended automation.
- Stagewright does not claim that server-side validation is equivalent to MCP host authorization.
- Trace/replay causality becomes a prerequisite rather than an after-the-fact repair if
  server-side composition is reconsidered.
- Parameterized replay specifications remain a candidate improvement, not an implied commitment.

## Related decisions

- [ADR-007](./007-agent-native-ux-principles.md) — granular tools and turn-economy principles.
- [ADR-008](./008-server-and-tool-dispatcher.md) — the typed dispatch boundary.
- [ADR-009](./009-trace-artifact-and-dispatch-observer.md) — nested dispatch, trace, and replay.
- [ADR-014](./014-security-posture-and-threat-model.md) — authorization and eval trust boundary.
- [ADR-021](./021-tool-profiles-and-manifest-budgets.md) — tool-surface and manifest budgets.

## References

- [MCP server primitives](https://modelcontextprotocol.io/specification/2025-11-25/server/index) —
  prompts are user-controlled; tools are model-controlled.
- [MCP tool schema and annotations](https://modelcontextprotocol.io/specification/2025-11-25/schema) —
  annotations are advisory hints, not trusted enforcement.
- [MCP tool annotations as risk vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) —
  guarantees belong in authorization or runtime contracts.
- [MCP tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) —
  experimental deferred execution and polling semantics.
- [laststance Electron MCP migration](https://github.com/laststance/electron-mcp-server/blob/main/MIGRATION.md) —
  migration from a nested command tool to granular top-level tools.
