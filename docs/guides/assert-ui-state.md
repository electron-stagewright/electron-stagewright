# Assert UI state

How to verify what an app shows — in single calls an agent can branch on, instead of fragile
read-compare-retry loops.

## Address elements: refs first, selectors when you know the DOM

A snapshot (`electron_snapshot`) assigns every interactive element a numbered `ref`, tagged onto
the DOM as `data-sw-ref="N"` and stable across re-renders of the same element. `electron_find`
resolves role + accessible name to a ref without any DOM knowledge:

```json
electron_find { "role": "button", "name_contains": "Save" }
```

Most element-targeted assertion and interaction tools accept `ref` OR `selector` (never both);
count and URL assertions are exceptions because they target a query or a window rather than one
element. Prefer refs in agent flows: they survive markup refactors that break CSS selectors, and
when one does go stale the error carries recovery data instead of a dead end:

- `REF_NOT_FOUND` includes `similar_refs` — current elements that resemble the one you meant.
- Every snapshot and find response carries `renderer_reloaded`; when `true`, the renderer
  reloaded since your last read and ALL refs are suspect — take a fresh snapshot.

## The expect\_\* family — read + compare + retry in one round-trip

Each `expect_*` tool polls server-side until its predicate holds or `timeoutMs` (default 5000 ms,
`0` = check once) expires:

| Tool                      | Asserts                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `electron_expect_text`    | Element text: `equals` / `contains` / `regex` / `not_equals` / `not_contains` |
| `electron_expect_value`   | Form control value                                                            |
| `electron_expect_visible` | Visibility (or `visible: false` for absence)                                  |
| `electron_expect_count`   | How many elements match a selector / role+name query                          |
| `electron_expect_state`   | A composite state object (`checked`, `disabled`, `focused`, …)                |
| `electron_expect_url`     | The renderer URL                                                              |
| `electron_assert_pattern` | One-shot regex over text — no polling, for "is it already so"                 |

```json
electron_expect_text { "selector": "#status", "regex": "^Hello, .+!", "flags": "i" }
```

Regex predicates accept the `i`, `m`, `s`, `u` flags; the stateful `g` and `y` are rejected with
`BAD_ARGUMENT` rather than producing call-order-dependent results.

On failure the envelope is designed for the agent's next decision: `EXPECTATION_FAILED` is
**retryable** and its `details` carry `expected` AND `actual`, so the agent knows whether to wait
longer, fix its input, or report a real regression — without an extra read.

## The wait\_\* family — synchronise, then act

| Tool                         | Waits for                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `electron_wait_for_selector` | An element to be `attached` / `visible` / `hidden` / `detached`                           |
| `electron_wait_for_state`    | A composite state object on one element                                                   |
| `electron_wait_for_event`    | A named DOM event (`transitionend`, `load`, a custom event) on an element or the document |
| `electron_wait`              | A fixed pause — last resort                                                               |

One sharp edge: intentionally offscreen or `aria-hidden` elements (a code editor's hidden
textarea, for instance) are never "visible" — wait for `state: "attached"` instead, or the wait
times out by design. The expiry is `WAIT_TIMEOUT` (retryable), and `wait_for_state` reports the
last state it observed so the agent sees how close it got. Typing into that editor has its own
reliable path — see [Type into code editors](./type-into-code-editors.md).

## Watching change: snapshot diffs

After an action, you rarely need the whole tree again:

```json
electron_snapshot { "since": "last" }
```

The response is the delta — `added`, `removed`, and `changed` entries plus a `ref_map` — in a
compact encoding that carries only the fields that actually changed (pass
`diffFormat: "full"` for complete before/after entries, and `budgetTokens` to hard-cap the
payload; the server drops lowest-value entries first and reports how many under
`_meta.truncated_entries`). Over a multi-turn session this is the difference between re-reading
thousands of tokens per turn and reading tens.

## Putting it together

A robust act-then-verify beat looks like:

1. `electron_find` → ref.
2. Act (`electron_click { ref }`).
3. `electron_expect_text` / `electron_expect_state` with a bounded `timeoutMs`.
4. On `EXPECTATION_FAILED`: inspect `actual`; on `REF_NOT_FOUND`: use `similar_refs` or re-find;
   on `renderer_reloaded: true`: fresh snapshot, then retry once.

---

_Design background: stable refs and the snapshot/diff schema are ADR-005; failure envelopes,
retryability, and `EXPECTATION_FAILED` semantics are ADR-006; the single-round-trip assertion
principle is ADR-007. The model behind refs, snapshots, and retrying assertions:
[Concepts](./concepts.md)._
