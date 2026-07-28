# ADR-021: Tool profiles and manifest budgets

- **Status**: Accepted
- **Date**: 2026-07-10
- **Deciders**: johnny4young

## Context

Electron Stagewright deliberately exposes granular tools: each has its own schema,
description, error vocabulary, and agent-native recovery hints. That improves selection and
reduces multi-step client logic, but the initial MCP `tools/list` payload is now a material
part of an agent's context cost. The full safe core surface is 52 tools / 17,606 BPE tokens;
the explicitly loaded first-party plugin surface with eval is 110 tools / 31,035 BPE tokens.

The previous default was one unqualified core list. Consumers that need a focused test-driving
surface had no supported way to reduce that list, and a future tool or description change could
increase host context without a measured review. The dispatcher also preserved registration order,
which made the MCP result dependent on assembly details rather than a canonical contract.

The measurement must describe what an MCP host actually receives. The dispatcher's offline
documentation manifest contains operation-type and eval metadata that are intentionally absent
from `tools/list`, so it cannot stand in for the host payload.

## Decision

1. **Core profiles are explicit.** The public server API and CLI accept `essential`, `testing`,
   `debug`, and `full`. `full` remains the default and is exactly the complete non-eval core
   surface, preserving existing installations. The named sets live in
   `packages/core/src/tools/profiles.ts`; they are reviewed as lists of stable tool names, never
   inferred from descriptions or operation types.

2. **Profiles are limited to default core tools.** Eval tools remain governed by the existing
   per-target `--allow-eval` policy and compose with every profile. Plugins remain explicitly
   selected through `--plugin`; their tools and `electron_plugins` remain visible regardless of
   the selected core profile. `createServer({ tools })` is an advanced caller-supplied surface and
   is mutually exclusive with `toolProfile`, preventing a silently ignored selection.

3. **MCP ordering is canonical.** `Dispatcher.list()`, its documentation manifest, and its MCP
   `tools/list` response are sorted lexicographically by tool name. This guarantees a stable
   host-visible order without claiming client-side caching behavior beyond that determinism.

4. **Manifest budgets use the host-visible payload.** The private benchmark package starts a real
   in-memory MCP client/server pair and serializes the parsed `{ tools }` result. It records
   Unicode code points, UTF-8 bytes, GPT-class BPE tokens, canonical names, and the ten largest
   individual tools. The BPE figure is a public tokenizer proxy, not a claim about a host's private
   tokenizer.

5. **A baseline is an explicit change-control gate.** The committed manifest baseline covers the
   full core safe/eval modes, every named core profile, every first-party plugin safe/eval mode,
   and all first-party plugins together. BPE growth over 3% fails `pnpm manifest:check`; changing
   the baseline requires `--update-manifest-baseline --reason <why>`. Descriptions are not shortened
   merely to meet a budget.

6. **The default is evidence-gated.** The real profile benchmark runs at least twelve equivalent
   Electron tasks and reports success, calls, explicit retries, manifest cost, response cost, and
   total BPE. `full` remains the default until `essential` reaches at least 95% of its success rate
   and demonstrates a material token improvement.

## Alternatives considered

| Alternative                                     | Why rejected                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| One universal per-tool character cap            | Schemas and error guidance have different legitimate costs; it would optimize an arbitrary local number rather than agent success.          |
| Hide plugins inside core profiles               | Plugins are an explicit operator decision under ADR-004. Coupling them to profiles would make a selected capability disappear unexpectedly. |
| Measure the dispatcher's documentation manifest | It contains fields hosts do not receive, so its token number would overstate a different payload.                                           |
| Make `essential` the new default immediately    | It would be a breaking discovery change without task-success evidence.                                                                      |
| Compress descriptions in this change            | There is no evidence yet that a shorter description preserves selection and recovery quality.                                               |

## Consequences

- Operators can choose a smaller core manifest without changing eval authorization or plugin loading.
- An excluded known core tool returns an actionable restart hint naming a profile that contains it;
  eval-gated tools continue to return their more specific authorization hint.
- New or changed tools now receive a measured manifest review in addition to the existing schema and
  documentation guards.
- The private benchmark package owns `gpt-tokenizer`; `@electron-stagewright/core` gains no runtime
  tokenizer dependency.
- A future proposal to change the default profile, alter profile membership materially, or shorten
  descriptions must amend this record with benchmark evidence.

## Status update (2026-07-28): Screenshot evidence in `testing`

Consumer dogfooding exposed a semantic gap: the profile intended for test authoring omitted
`electron_screenshot`, even when the operator configured `--screenshot-dir` specifically to retain
test evidence. The `testing` profile now includes the existing screenshot tool. `essential` remains
the smaller interaction/assertion surface, while `debug` and `full` continue to include screenshot
capture as before.

The host-visible manifest runner measured exactly two changed variants:

| Variant        | Tools | BPE before | BPE after | Delta                                        |
| -------------- | ----: | ---------: | --------: | -------------------------------------------- |
| `testing-safe` | 48→49 |     16,084 |    16,733 | +649 BPE (+4.0%), adds `electron_screenshot` |
| `testing-eval` | 50→51 |     16,716 |    17,365 | +649 BPE (+3.9%), adds `electron_screenshot` |

No other manifest variant changed. The increase is accepted because it supplies directly requested
test evidence rather than description growth, and the baseline records the reason as
`Testing now includes screenshot evidence capture after consumer dogfooding.` This does not change
the `full` compatibility default, eval authorization, plugin loading, or screenshot behavior.

Regenerating the complete baseline also reconciled lower `plugin-production-safe`,
`plugin-production-eval`, `all-safe`, and `all-eval` measurements already present in the merged
source after the production-validation CLI work. Those variants did not change between this
slice's before/after measurements; retaining their older inflated values would have weakened the
future growth gate.

## References

- [ADR-004](./004-plugin-model.md) — explicitly loaded plugin model.
- [ADR-007](./007-agent-native-ux-principles.md) — agent-facing tool ergonomics and token economy.
- [ADR-008](./008-server-and-tool-dispatcher.md) — dispatcher and MCP tool contract.
