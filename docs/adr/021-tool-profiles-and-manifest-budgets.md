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

## Status update (2026-07-28): Server failure breadcrumb description

The `electron_status` description now names its bounded server-level failure breadcrumb and
privacy exclusions. Because `electron_status` belongs to every core profile and every plugin
composition, all 28 measured variants gain the same 107 characters and 25 BPE with no tool-count
change. The relative increase ranges from 0.07% on `all-eval` to 0.25% on `essential-safe`, well
below the 3% regression threshold.

The increase is accepted because it teaches the host-visible contract needed to interpret
`server.started_at` and `server.last_error`; omitting those fields from the manifest would force
agents to discover them by trial. The baseline records the reason as
`Document server-level failure breadcrumbs in electron_status.` Exact before/after measurements
remain available in the ignored review artifacts.

## References

- [ADR-004](./004-plugin-model.md) — explicitly loaded plugin model.
- [ADR-007](./007-agent-native-ux-principles.md) — agent-facing tool ergonomics and token economy.
- [ADR-008](./008-server-and-tool-dispatcher.md) — dispatcher and MCP tool contract.

## Status update (2026-10-03): evidence output schemas

Four existing evidence-producing tools now advertise validated success/error output schemas and
optional portable-resource metadata. Tool names, counts and profile membership are unchanged.
The reviewed baseline records this intentional discovery cost without changing the 3% growth gate:

| Variant               | Previous BPE | New BPE | Growth |
| --------------------- | -----------: | ------: | -----: |
| Core safe             |       18,645 |  19,108 |  2.48% |
| Trace plugin safe     |       20,787 |  22,613 |  8.78% |
| All plugins safe      |       30,023 |  31,849 |  6.08% |
| All plugins with eval |       34,374 |  36,200 |  5.31% |

The essential profile is unchanged. The reason recorded by `manifest:update` identifies the
schemas and portable evidence explicitly. This does not authorize adding schemas speculatively to
the entire catalog; subsequent adoption remains subject to measurement and the existing gate.

## Status update (2026-10-22): focus-aware keyboard input

The keyboard tools gain `waitForFocusMs` and `requireEditable` and return `focused`. A first draft
also gave the three tools output schemas; measured, each cost about 1,270 characters because the
schema wraps the full response envelope, roughly three quarters of the growth. These are not
evidence tools, so in line with the 2026-10-03 update the schemas were dropped and `focused` is
documented in each description's `Returns` instead.

Together with the error-code and navigation changes since the last baseline, the essential
profiles cross the 3% gate, so the baseline is moved with an explicit reason (the gate is
unchanged). From this point each change that grows the manifest records its own reason.

| Variant               | Previous BPE | New BPE | Growth |
| --------------------- | -----------: | ------: | -----: |
| Core safe             |       19,108 |  19,624 |  2.70% |
| Essential safe        |        9,852 |  10,160 |  3.13% |
| Essential with eval   |       10,484 |  10,861 |  3.60% |
| Testing safe          |       17,221 |  17,737 |  3.00% |
| All plugins safe      |       31,849 |  32,365 |  1.62% |
| All plugins with eval |       36,200 |  36,722 |  1.44% |

## Status update (2026-10-22): screenshot freshness fields

`electron_screenshot`, an evidence tool with an output schema since 2026-10-03, gains
`waitForFrame` (default true, about 17 ms per capture on the launch and CDP transports) and
`settleMs`, and returns `content_sha256`, `same_as_previous`, `overwrote` and `frame_waited`. The
growth stays within the 3% gate of the baseline set for the keyboard tools, so it does not move.

## Status update (2026-10-22): `electron_reload`

`electron_reload` joins the `testing` and `debug` profiles next to the window tools, and `full`
through the catalog. It replaces `location.reload()` in eval, which needed the eval flag and left
the agent guessing how long to wait. `essential` is unchanged.

## Status update (2026-10-22): `electron_set_window_size`

`electron_set_window_size` joins the `testing` and `debug` profiles next to the window tools, and
`full` through the catalog. It replaces `BrowserWindow.setSize` through eval and reports the size
the window really got, since an app minimum size clamps requests silently. `essential` is
unchanged.

## Status update (2026-10-29): recipe coverage in the instructions

The server instructions point every agent at `stagewright://docs/verify-desktop-change`, whose
steps use the native-ui and storage plugins and core tools outside `essential` and `testing`. An
agent on a narrower surface had no sign of this, and fell back to scripts outside the MCP. The
server now reads the tool names from the generated recipe, and when any is unregistered it appends
one sentence to the instructions, the recipe resource and `stagewright://manifest/profile`. That
sentence names the missing tools, the smallest profile that has the missing core tools, and the
`--plugin` short names. It does not change profile membership or plugin loading, and `tools/list`
is unchanged, so no manifest variant moves.
