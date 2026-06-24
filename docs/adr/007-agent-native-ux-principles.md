# ADR-007: Agent-native UX principles

- **Status**: Proposed
- **Date**: 2026-05-26
- **Deciders**: johnny4young

## Context

The dominant pattern across Electron MCP servers (and most MCP servers generally) is **"human API wrapped in MCP transport"**: the tools, return shapes, and error messages mirror the underlying SDK (Playwright, CDP, Puppeteer) with minimal adaptation. AI agents are expected to perform reasoning, comparisons, and recovery using primitives designed for human callers.

This works, but it's expensive. Empirical data:

- **m13v measurements** (cited by `laststance/electron-mcp-server` in their v2.0 release notes): LLM tool selection error rate dropped from ~20% to <3% when a single nested macro tool was split into ~40 individual top-level tools. Tool ergonomics directly drive agent accuracy.
- **Microsoft `@playwright/cli` benchmark** (Playwright team, late 2025): a typical browser automation task consumed ~114k tokens via MCP versus ~27k via CLI-as-skill — a 4× reduction. The 4× came from removing round-trips that exist because of MCP-call-shape overhead, not because the underlying browser operations are different.

Both data points converge on the same conclusion: **the API shape matters more than the underlying SDK**. Token economy comes from removing unnecessary round-trips, not from making each call faster.

This ADR captures the principles Electron Stagewright commits to when designing every tool, response, and error. They distinguish this project from "another Electron MCP" — they are the design contract.

The principles came from an explicit feedback round on 2026-05-26 with an AI agent acting as end-user. Each principle below records (1) the principle, (2) the cost if we skip it, (3) the benefit if we adopt it, (4) a concrete example.

## Decision

We commit to ten design principles for every tool and response shipped by Electron Stagewright. These constraints apply to the core, every plugin, and every example.

### Principle 1: Tool descriptions embed error codes inline

**The principle**: every tool's MCP `description` field documents, in addition to the purpose and arguments, the **possible error codes the tool can return** and whether each is retryable.

**Cost if skipped**: agents select tools by description alone (LLMs don't see implementation). When a tool fails with code `ELEMENT_DISABLED`, the agent must already know what that code means. If the code is opaque, the agent attempts a retry that's guaranteed to fail (the button is still disabled) and burns tokens on a recovery cycle.

**Benefit if adopted**: agents construct retry policy at tool-selection time. They know `ELEMENT_NOT_VISIBLE` is retryable (so wait + retry makes sense) and `ELEMENT_DISABLED` isn't (so they need to address state first).

**Example**:

```jsonc
// Not this:
{
  "name": "electron_click",
  "description": "Click an element. Pass selector or ref."
}

// This:
{
  "name": "electron_click",
  "description": "Click an element by ref (from snapshot) or selector. Returns: { ok: true, ref, settled: boolean }. Errors: ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED (not retryable — call expect_state to verify, or address the disabled state via app-level interaction), REF_NOT_FOUND (call snapshot first), SELECTOR_NO_MATCH"
}
```

### Principle 2: Every response carries `_meta.estimated_tokens`

**The principle**: every success and error response includes `_meta.estimated_tokens` — the estimated cost (in target-model tokens) of the response payload itself.

**Cost if skipped**: agents cannot budget. They learn they've blown their context window only after running out. They have no way to choose, in real time, between "do another snapshot" (large response) and "snapshot diff" (small response).

**Benefit if adopted**: agents make budget-aware choices mid-session. At 80% budget consumed, an agent can switch from full snapshots to diffs, from screenshots to text-only reads, from `get_*` chains to `expect_*` primitives. **Token economy becomes a first-class agent decision instead of a discovered failure.**

**Example**:

```jsonc
{
  "ok": true,
  "ref": 3,
  "settled": true,
  "_meta": {
    "estimated_tokens": 47,
    "elapsed_ms": 142,
    "session_id": "pw-...",
  },
}
```

### Principle 3: Errors carry hints + next_actions + similar_refs

**The principle**: every error response includes a `hint` (suggested fix from the central registry), a `next_actions` list (concrete tool calls the agent might try), and (when relevant) a `similar_refs` list (alternative elements that look like what the agent probably meant).

**Cost if skipped**: when an error occurs, the agent has to (a) parse the error message to decide if it's recoverable, (b) ask for additional context to understand the current state, (c) construct a recovery plan from scratch. Each of these is at least one tool call. Total cost: 2-3 additional turns per error.

**Benefit if adopted**: agents recover in one turn. The error response already contains the information they would have asked for.

**Example**:

```jsonc
{
  "ok": false,
  "error": "ref 7 not found in current snapshot",
  "code": "REF_NOT_FOUND",
  "hint": "The DOM may have rerendered since the last snapshot was taken.",
  "next_actions": ["snapshot()", "wait_for_state({ ref: 5, state: 'visible' })"],
  "similar_refs": [
    { "ref": 9, "role": "button", "name": "Submit" },
    { "ref": 12, "role": "button", "name": "Cancel" },
  ],
  "retryable": false,
  "http": 404,
  "_meta": { "estimated_tokens": 89, "elapsed_ms": 23 },
}
```

### Principle 4: `get_state` returns the full state envelope in one call

**The principle**: state-reading tools return a complete state envelope per call, not partial. For an element, that's `{ visible, enabled, checked, focused, disabled, aria_expanded, aria_busy, aria_invalid, readonly, required }` — every attribute relevant to deciding "is this element interactable" in one call.

**Cost if skipped**: agents asking "is this button clickable" today do 3-4 calls: `get_attribute({ name: 'disabled' })`, `get_state({ name: 'visible' })`, etc. Each call costs round-trip overhead. 4 calls ≈ 75% of token cost is overhead, not signal.

**Benefit if adopted**: one call returns the full state. Agent decides. -75% round-trip cost.

**Example**:

```jsonc
electron_get_state({ ref: 5 })
// → {
//   "visible": true,
//   "enabled": false,
//   "disabled": true,
//   "focused": false,
//   "checked": null,
//   "aria_expanded": null,
//   "aria_busy": false,
//   "aria_invalid": false,
//   "readonly": false,
//   "required": true,
//   "_meta": { "estimated_tokens": 84 }
// }
```

### Principle 5: `wait_for_state` accepts composite predicates

**The principle**: wait tools accept a state object predicate evaluated atomically server-side, not just a single attribute.

**Cost if skipped**: agents waiting for "button visible AND enabled AND not focused" today chain three sequential waits: `wait_for_visible` → `wait_for_enabled` → `wait_for_state({ focused: false })`. Three round-trips + race condition risk (the button could go invisible between calls 1 and 2).

**Benefit if adopted**: one call replaces three. Server evaluates the composite predicate atomically; no race window.

**Example**:

```jsonc
electron_wait_for_state({
  ref: 5,
  state: { visible: true, enabled: true, focused: false },
  timeoutMs: 5000
})
// → { ok: true, settled_at_ms: 327, _meta: { estimated_tokens: 32 } }
```

### Principle 6: Snapshots flag `recently_changed` elements

**The principle**: between consecutive snapshots, the snapshot walker flags elements whose state, text, or position changed since the previous snapshot. Agents can attention-focus on the diff instead of reprocessing unchanged content.

**Cost if skipped**: every snapshot is processed fresh by the agent. After typing one character, the agent re-reads a thousand-element accessibility tree to understand which ref changed. Token waste linear in tree size, per turn.

**Benefit if adopted**: agents see `recently_changed: true` flags and focus reasoning on what differs. For long sessions with many small interactions, this saves substantial context.

**Example**:

```
electron_snapshot()
[1] heading "Welcome"
[2] textbox "Email"  recently_changed=true  value="user@example.com"
[3] textbox "Password"  value="••••••••"
[4] button "Sign in"  enabled=true  recently_changed=true  // was disabled before
```

Without the flag: agent re-reads all four elements. With the flag: agent reasons "the button became enabled, I can click".

### Principle 7: Snapshot diffs are a parameter, not a separate tool

**The principle**: `snapshot({ since: 'last' })` returns only deltas since the last snapshot. Server keeps the last snapshot per session internally. No separate `snapshot_diff` tool exists.

**Cost if skipped (two-tool design)**: agents must remember two related-but-different APIs. They sometimes use the wrong one (calling `snapshot` when they meant `snapshot_diff` or vice versa). The MCP `tools/list` is one tool longer for no architectural reason.

**Benefit if adopted (one-tool parameterized)**: fewer APIs to remember. Less cognitive load for agents. The decision "full snapshot vs diff" becomes a parameter choice within one familiar API.

**Example**:

```
electron_snapshot()                  // full snapshot
electron_snapshot({ since: 'last' }) // diff since last snapshot (returns added, removed, changed refs only)
```

### Principle 8: `expect_*` primitives replace read-compare-retry chains

**The principle**: assertions ship as composable primitives — `expect_text`, `expect_visible`, `expect_state`, `expect_count`, `expect_url` — that include a built-in retry-on-mismatch with configurable timeout. Agents declare expectations, server handles the loop.

**Cost if skipped**: an agent verifying "the heading text is 'Welcome back'" today does: `get_text({ ref })` → compare in reasoning → if mismatch, poll → repeat. 5+ turns per assertion. Per session with many assertions, this dominates token cost.

**Benefit if adopted**: one call per assertion. Server handles retry. -80% turn cost on assertion-heavy flows.

**Example**:

```jsonc
// 5+ turn chain:
electron_get_text({ ref: 4 })
// agent compares manually
// if mismatch, electron_wait(...)
// electron_get_text({ ref: 4 }) again
// repeat

// 1 turn:
electron_expect_text({ ref: 4, equals: "Welcome back", timeoutMs: 3000 })
// → { ok: true, matched: true, _meta: { ... } }
```

### Principle 9: `find` queries the accessibility tree semantically

**The principle**: a `find` tool returns matching refs by accessibility role + name + state predicate, without CSS selectors. The "natural" way an agent describes an element.

**Cost if skipped**: agents need to know CSS selector syntax. They also need to know the app's class names, which they often guess wrong. When the guess fails, the recovery is to take a snapshot, scan for the right element, then either click by ref (good) or construct a selector (still error-prone).

**Benefit if adopted**: agents express intent declaratively. `find({ role: 'button', name_contains: 'Submit', visible: true })` is closer to how humans describe what they want.

**Example**:

```jsonc
electron_find({ role: 'button', name_contains: 'Submit', visible: true, enabled: true })
// → { matches: [{ ref: 9, name: "Submit form", bbox: {...} }], count: 1 }

// vs. CSS selector dance:
// electron_snapshot()  → search for a button with text including "Submit"
// electron_find_elements({ selector: 'button' }) → filter manually
// electron_get_text on each → match
```

### Principle 10: Tool responses are hot-reload-aware

**The principle**: when the renderer process reloads (e.g., Vite hot-module-reload), snapshot-producing tools report it explicitly. `electron_snapshot` and `electron_find` return a top-level `renderer_reloaded` flag, and the snapshot metadata keeps `renderer_reloaded_since_last_snapshot` for downstream reasoning. Agents know cached refs may need refreshing before blindly continuing.

**Cost if skipped**: agents click ref 5, get REF_NOT_FOUND, ask why, get prose, take new snapshot, retry. 3 turns to recover from one HMR reload. On Vite-driven apps (common in modern Electron stacks), this happens dozens of times per session.

**Benefit if adopted**: agents see the reload signal, refresh snapshot proactively, and avoid silent staleness.

**Example**:

```jsonc
// After Vite HMR fires:
electron_snapshot()
// → {
//   "ok": true,
//   "kind": "full",
//   "renderer_reloaded": true,
//   "snapshot": {
//     "meta": {
//       "renderer_reloaded_since_last_snapshot": true
//     }
//   }
// }
```

Combined with Principle 3 (next_actions and similar refs on stale/missing refs),
the agent recovers in one turn.

## Alternatives considered

| Alternative                                                     | Why rejected                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"Just wrap Playwright's API"** (the dominant pattern)         | Discards 4× token economy gains demonstrated by `@playwright/cli` skill experiment. Discards the 20% → 3% accuracy gain demonstrated by m13v measurements + laststance's v1→v2 split. Falls behind the state of the art.                                                      |
| **Adopt principles selectively (e.g., principles 1-3 only)**    | Each principle compounds with the others. Principle 8 (`expect_*`) without Principle 3 (rich error envelope) leaves agents without context when `expect` fails. Half-adoption sacrifices most of the win.                                                                     |
| **Build a thinner layer over `laststance/electron-mcp-server`** | Their architecture choices are sound for their goal (comprehensive coverage + security-configurable). Layering on top means inheriting decisions that don't match our agent-native goal. Better to start from the principles.                                                 |
| **Wait for MCP spec to standardize agent-UX patterns**          | The MCP spec as of late 2025 (donated to Linux Foundation, MCP 2025-11-25 spec) focuses on transport + tool registration, not response ergonomics. The community will set the de-facto agent-UX patterns by which servers ship them first. We aim to be one of those servers. |

## Consequences

- Every tool in the core and every plugin **must** follow all ten principles. PR review enforces.
- The error code registry (ADR-006) is the foundation of Principles 1, 3, and 10.
- The snapshot schema (ADR-005) is the foundation of Principles 6, 7, 9.
- The `expect_*` family is the foundation of Principle 8.
- These principles do **not** apply to the eval surface (`eval_main`, `eval_renderer`) — those are escape hatches by design. Their security profile is governed by ADR-006 and the forthcoming threat-model ADR, not by this ADR.
- These principles are revisitable but only via amendment (a new ADR or a Status Update block here). Casual deviations in PRs are blocked at review.

## References

- Customer-discovery research — empirical citation of m13v measurements (LLM tool selection 20% → 3%) and the laststance v1→v2 split.
- Audit of laststance/electron-mcp-server — independent validation of the granular-tools approach.
- Audit of mesomya/electron-driver — the 26 findings that motivated several of these principles.
- [ADR-005](./005-snapshot-schema-v1.md) — Principle 6, 7, 9.
- [ADR-006](./006-error-code-registry.md) — Principle 1, 3, 10.
- [Playwright `@playwright/cli` skill experiment](https://scrolltest.com/playwright-mcp-llm-architecture-ai-augmented-test-automation/) — 4× token-economy data.
