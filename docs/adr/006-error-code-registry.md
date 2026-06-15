# ADR-006: Error Code Registry and Agent-UX Response Envelope

- **Status**: Accepted
- **Date**: 2026-05-26
- **Deciders**: johnny4young

## Context

An MCP server exposes tool calls to AI agents. When a tool fails, the response shape governs whether the agent can recover or simply gives up. Surveying the prior art in the Electron-MCP space:

- **`mesomya/electron-driver` (v0.3.1)** ships ~39 tools but only ~4 distinct error codes (`NOT_RUNNING`, `ALREADY_RUNNING`, `FILE_NOT_FOUND`, `BAD_ARGUMENT`). Every other failure surfaces a generic `ERROR` with a human-readable string. Agents must parse prose to branch on failure modes.
- **`halilural/electron-mcp-server`** returns mixed shapes — sometimes `{ ok: false, message }`, sometimes a bare string, sometimes a thrown exception. Agents cannot rely on a stable contract.
- **`laststance/electron-mcp-server` (v2.0)** added structured codes in its v1→v2 split. Their source-level comment (paraphrased) captures the design rationale we adopt verbatim: callers MUST declare the operation type explicitly so eval routing fails closed — a missing field would otherwise route user-controlled JS through the command validator and skip the eval validator entirely.

The agent-end-user feedback round on 2026-05-26 (captured in [ADR-007](./007-agent-native-ux-principles.md)) made the design contract explicit:

- **Principle 1** — tool descriptions embed possible error codes inline so agents see them at tool-selection time.
- **Principle 2** — every response carries `_meta.estimated_tokens` so agents can budget in real time.
- **Principle 3** — error responses carry `hint`, `next_actions`, and `similar_refs` so the agent has a concrete recovery path without re-querying the world.
- **Principle 10** — machine-readable error semantics (stable codes, `retryable` boolean, HTTP-equivalent status) so agents branch on data, not prose.

ADR-006 is the implementation contract that makes those four principles concrete: a central, machine-readable error code registry plus a stable response envelope shape, threaded through a Zod-typed routing layer so the security-critical pieces fail closed by default.

## Decision

### 1. Central error code registry

Every error response from every Electron Stagewright tool MUST reference a code from a central registry exported from `@electron-stagewright/core`:

```ts
export const ERROR_CODES = {
  NOT_RUNNING: { http: 409, retryable: false, hint: 'Call launch first.' },
  REF_NOT_FOUND: { http: 404, retryable: false, hint: 'Call snapshot first.' },
  ELEMENT_NOT_VISIBLE: {
    http: 409,
    retryable: true,
    hint: 'Wait for the element to become visible.',
  },
  // ...
} as const satisfies Record<string, ErrorCodeDefinition>

export type ErrorCode = keyof typeof ERROR_CODES
```

Constraints baked into the design:

- **Codes are SCREAMING_SNAKE_CASE** — easy to grep, stable across versions, conventional for protocol-level identifiers.
- **Each code carries `retryable: boolean`** so agents implement retry policy without parsing prose. Time-sensitive failures (transport drops, timeouts) are retryable; state-sensitive failures (element disabled, missing ref) are not.
- **Each code carries `http: number`** — forward-looking for the eventual REST gateway, today an additional categorisation signal.
- **Each code carries `hint: string`** — the default human-readable suggestion. Tools may override per-call via the `message` argument of `makeError(code, opts)`.
- **New codes require an ADR amendment.** A Status Update block appended to this ADR documents the addition.
- **A mirror test enforces the invariant at build time.** Adding a `code: 'X'` literal to a source file without registering `X` causes `errors-mirror.test.ts` to fail.

### 2. Response envelope shape

Every tool returns one of two shapes, discriminated by `ok`:

```ts
interface ErrorResponse {
  readonly ok: false
  readonly error: string // human-readable; may change between releases
  readonly code: ErrorCode // stable; agents branch on this
  readonly hint: string // registry default, possibly overridden
  readonly next_actions?: readonly string[]
  readonly similar_refs?: readonly SimilarRef[]
  readonly details?: Record<string, unknown> // structured diagnostics
  readonly retryable: boolean // mirrored from registry
  readonly http: number // mirrored from registry
  readonly _meta: ResponseMeta
}

type SuccessResponse<T extends object> = T & {
  readonly ok: true
  readonly _meta: ResponseMeta
}

interface ResponseMeta {
  readonly estimated_tokens: number // char/4 heuristic v1; tiktoken-grade lands with the benchmark suite
  readonly elapsed_ms: number
  readonly session_id?: string // wired by the dispatcher once session lifecycle lands
}
```

The envelope is computed in-process before the MCP transport serialises it; the transport layer is responsible only for the protocol-specific wire format.

### 3. Operation-type discriminator (internal manifest metadata)

Every tool declares its operation type as a Zod-validated field on its **internal manifest entry**, NOT as part of the agent-facing input schema. ADR-007 commits to granular per-action tools (`electron_click`, `electron_eval_main`, …), so the dispatcher already knows the operation type from the tool name; the agent never sees, declares, or passes this field.

```ts
export const OperationTypeSchema = z.enum([
  'command', // state-changing: click, type, key, drag, scroll
  'query', // state-reading non-eval: get_text, get_value, get_attribute, exists
  'eval', // arbitrary JS evaluation: eval_main, eval_renderer
  'screenshot', // image capture
  'logs', // console / network / IPC log retrieval
  'window_info', // structural inspection
])

interface ToolDefinition {
  readonly name: string
  readonly inputSchema: z.ZodTypeAny // agent-facing — does NOT include operationType
  readonly operationType: OperationType // internal metadata
  readonly handler: ToolHandler
}
```

The dispatcher reads each tool's declared type from the manifest at boot time and routes the payload through one of two validators:

- `operationType: 'eval'` → `validateEvalContent` (DANGEROUS_EVAL_KEYWORDS blocklist; AST inspection lands with the forthcoming threat-model ADR).
- Everything else → `validateCommandContent` (lighter input-shape checks).

The "fails closed" property is preserved, but enforced at **registration time** rather than per-call: a tool whose manifest entry lacks an operationType — or declares an invalid one — fails `OperationTypeSchema.parse(toolDef.operationType)` and refuses to register. The server cannot start with a mis-classified tool, so no agent input can ever reach a validator without a declared type behind it.

### Why not surface the discriminator to the agent

A previous draft of this ADR required the agent to include `operationType` in every tool call. That design was reverted because it contradicts ADR-007 Principle 1 (granular tools beat macro-tool selectors): asking the agent to mirror metadata the dispatcher already owns (a) introduces a class of avoidable agent errors (typos, hallucinated values), (b) burns tokens per call for redundant information, and (c) makes the fails-closed contract theatrical — a confused agent could declare `'command'` for an eval tool and bypass the blocklist entirely. Boot-time manifest validation is strictly safer and cheaper.

### 4. Zod-driven schema pipeline

Every tool's input schema is defined in Zod (`zod ^3.23.0` runtime dep on the core package). The same Zod schema:

1. Validates the incoming payload at request time.
2. Drives TypeScript type inference at compile time via `z.infer<typeof Schema>`.
3. Converts to MCP JSON Schema via `zod-to-json-schema` (devDep) at server initialisation time, so the `tools/list` response the agent sees agrees with what the server validates.

Single source of truth for the three surfaces; drift becomes a compile error rather than a runtime mystery.

### 5. Plugin error code namespacing

Core ships only un-namespaced codes (`NOT_RUNNING`, `REF_NOT_FOUND`, …). Plugins register their own codes via the plugin loader API (`registerPluginErrorCodes` through the ADR-004 plugin loader contract). Plugin codes surface as `production.NOTARIZATION_FAILED` so agents can tell which plugin produced the failure without parsing the message.

The mirror test now scans plugin packages too: every `makePluginError('<ns>.<KEY>', …)` literal must name a key declared by that package's `errorCodes` manifest object.

## Rationale

### Why a central registry, not per-tool codes

A tool-local code namespace is the path of least resistance — every tool author invents codes as failures surface. The cost is that two tools end up with `ELEMENT_NOT_VISIBLE` and `ELEMENT_INVISIBLE` for the same failure, and agents have to learn both. A central registry forces the design conversation up front and produces a small, memorable set of codes the agent learns once.

### Why a mirror test, not a lint rule

ESLint custom rules require AST-aware authoring and add a maintenance surface (the rule itself needs tests, can have false positives, and must travel through the ESLint plugin lifecycle when TypeScript upgrades). A vitest mirror test is a single file that reads the source and asserts an invariant — the failure mode is a clear test name pointing at the unregistered code. Cheaper to maintain, easier to extend to plugins.

### Why char/4 token estimation for v1

Char/4 is the standard back-of-envelope estimate that works within ~10-20% on English prose for GPT-class and Claude-class tokenizers. It avoids pulling tiktoken or `@anthropic-ai/tokenizer` as a runtime dep (both add ~5-10 MB to the install footprint). Benchmark-only reporting uses a model-accurate tokenizer in the bench package; the server-side `estimateTokens(payload)` signature remains dependency-free and heuristic.

### Why the eval validator stub ships in this slice

Two reasons:

1. **The routing CONTRACT is the security surface, not the validator body.** Once `routeByOperationType` exists and is the single entry point, the first tool implementation can fill in `validateEvalContent`'s body without re-litigating where the seam lives. The seam's existence is what makes the system fail-closed.
2. **Even the v1 minimal blocklist has value.** It blocks the obvious foot-guns (`process.exit`, `require(`, `Function(`, `__proto__`, `child_process`) before an eval payload reaches the transport. The eval tools require an eval-policy opt-in (`--allow-eval` or a target-specific variant); ADR-014 tracks the remaining AST-inspection hardening.

### Why Zod, not a hand-rolled validator

Zod is already pulled transitively by `@modelcontextprotocol/sdk`. Pinning it as a direct runtime dependency (`^4.x` in the current package) clarifies the version contract. Hand-rolling validators duplicates effort that Zod handles better, and `z.infer` gives TypeScript types from the schema for free.

## Alternatives considered

| Alternative                                                  | Why rejected                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-tool error code namespaces**                           | Two tools end up with synonymous codes for the same failure; agents have to learn both. Central registry forces the design conversation up front.                                                                                                                                         |
| **HTTP status codes only, no string codes**                  | HTTP codes are too coarse (404 covers REF_NOT_FOUND, SELECTOR_NO_MATCH, FILE_NOT_FOUND). Agents need finer-grained branching than 5 status families allow.                                                                                                                                |
| **String error codes without `retryable` boolean**           | Agents have to maintain their own table of "is this code retryable" — the table drifts, the agent gets it wrong, retry storms happen. Inlining `retryable` in the response is one bit of metadata that eliminates an entire class of agent bugs.                                          |
| **ESLint rule instead of a mirror test**                     | More maintenance surface (rule itself needs tests, can have false positives, travels through the ESLint plugin lifecycle). The mirror test is one file with a clear failure message.                                                                                                      |
| **TypeScript Compiler API for the mirror v1**                | Strictly more precise than regex, but ~80 LOC of code for a 1-2-file scan today. Regex is good enough until the lifecycle tools land roughly fifteen tool implementations; the upgrade path is captured in the project's internal follow-up backlog for re-evaluation then.               |
| **tiktoken for runtime `estimateTokens`**                    | Adds 5-10 MB to the install. Char/4 is within 10-20% on English prose, which is sufficient for server budget heuristics. Benchmark-only token accounting can use a precise tokenizer without adding runtime weight.                                                                       |
| **Make `operationType` optional with a server-side default** | Defeats the purpose. The fail-closed property comes from the field being required AND undefined-by-default failing the validation step. An optional field with a default routes through the looser validator silently when callers omit it — the exact failure mode this design prevents. |
| **Lift the envelope shape into Zod schemas**                 | Increases boilerplate without runtime payoff. The envelope is constructed by the dispatcher, never deserialised from untrusted input. Type-level interfaces are sufficient.                                                                                                               |

## Consequences

- **Every new error code is an ADR-006 amendment.** A Status Update block at the bottom of this ADR captures additions; the mirror test enforces that nothing slips into source without being registered.
- **Tool descriptions must embed possible error codes** (per ADR-007 Principle 1). The dispatcher's `tools/list` response includes the inline error-code documentation in each tool's description field.
- **The envelope shape is stable; additions are non-breaking.** Adding a new field to `_meta` or a new optional field to `ErrorResponse` is permitted. Removing or renaming a field is a breaking change requiring an ADR amendment.
- **`estimated_tokens` is an estimate, not a measurement.** The v1 char/4 heuristic is documented as such. Agents that budget on exact token counts will need to revisit when the benchmark suite lands a tokenizer-accurate implementation; their existing logic remains correct (the field name and contract do not change).
- **Plugin error codes are namespaced with a `pluginName.` prefix.** The concrete registration API lands with the plugin loader; core never owns plugin codes.
- **The eval validator is minimal today.** Eval tools are already hidden unless the eval policy permits their target, and visible eval payloads still pass the keyword blocklist. Real validation beyond that (AST inspection) belongs in ADR-014. The routing seam is in place; the validator body is the part that grows.
- **The format gate is now blocking.** `pnpm format:check` joined `pnpm verify` as part of this slice; the umbrella now runs lint + typecheck + test + build + format:check.

## Related decisions

- [ADR-001](./001-naming-and-license.md) — Naming and License. ADR-006 ships under the same MIT terms; no contributor agreement required for adding codes.
- [ADR-002](./002-runtime-and-language.md) — Runtime and Language Choice. The registry leans on ADR-002's strict-plus TypeScript profile: `noUncheckedIndexedAccess` means `ERROR_CODES[code]` returns a narrowed type when `code` is `ErrorCode`, no `T | undefined`; `exactOptionalPropertyTypes` shapes the `MakeErrorOptions` ergonomics.
- [ADR-007](./007-agent-native-ux-principles.md) — Agent-native UX principles. Principles 1, 2, 3, and 10 are direct dependencies of this ADR. ADR-006 is the implementation; ADR-007 is the rationale.
- [ADR-003](./003-transport-abstraction.md) — Transport abstraction. Returns registered codes (`TRANSPORT_UNSUPPORTED`, `CDP_DISCONNECTED`, `INJECT_FAILED`) from transport failures and stubs.
- [ADR-004](./004-plugin-model.md) — Plugin model. Defines plugin-code registration and namespacing.
- [ADR-014](./014-security-posture-and-threat-model.md) — Security posture and threat model. Records the eval trust boundary, per-target eval authorization, content-hash audit, and remaining AST-inspection hardening.

## References

- `packages/core/src/errors/registry.ts` — the registry itself.
- `packages/core/src/errors/envelope.ts` — `ErrorResponse`, `SuccessResponse`, `makeError`, `makeSuccess`, `estimateTokens`, `getSessionId`.
- `packages/core/src/errors/operation-type.ts` — the discriminator, the validator stubs, the routing entry point.
- `packages/core/tests/errors-mirror.test.ts` — the build-time enforcement.
- [Zod documentation](https://zod.dev/).
- [zod-to-json-schema](https://github.com/StefanTerdell/zod-to-json-schema).

## Status Update (2026-05-29) — added `WAIT_TIMEOUT`

The wait tools introduce a first-class "the awaited condition did not hold within the budget" outcome. Added one code to the registry:

- **`WAIT_TIMEOUT`** — `http: 408`, `retryable: true`, hint: raise `timeoutMs` or recheck the condition. Returned by the wait tools when a bounded renderer poll expires; `wait_for_state` additionally carries the last observed state under `details.last_state` so the agent sees which flag never matched. Retryable because the condition may hold on a later attempt. The mirror test (`errors-mirror.test.ts`) registers the code transitively — it is referenced as `code: 'WAIT_TIMEOUT'` in `tools/wait/poll.ts`.

## Status Update (2026-06-02) — plugin codes realised; `ErrorResponse.code` widened

ADR-004 (Plugin model) implements the plugin-code design anticipated in §5. Two consequences for this ADR:

- The decision-section `ErrorResponse` snippet shows `readonly code: ErrorCode`. The implemented type is now `readonly code: ResponseCode`, where `ResponseCode = ErrorCode | (string & {})` — core codes keep their literal autocomplete while namespaced plugin codes (`<plugin>.CODE`) are also valid. No exhaustive `switch` over `code` exists, so the widening is non-breaking. Core `ERROR_CODES` and the `ErrorCode` union are unchanged.
- `registerPluginCodes` is realised as `registerPluginErrorCodes(namespace, codes)` plus `lookupErrorCodeDefinition` / `unregisterPluginErrorCodes` in `errors/registry.ts`. Plugin codes live in a runtime map separate from the closed `ERROR_CODES` union (which cannot be extended at runtime); the envelope builder resolves a code's metadata from either source, and `makePluginError('<plugin>.CODE', …)` builds the envelope. The mirror test stays core-only: it scans `packages/core/src`, where no plugin-code literals appear (plugin codes are registered at runtime, in plugin packages or test fixtures).

## Status Update (2026-06-04) — added `TYPE_NO_EFFECT`

Typing into a code editor (Monaco / EditContext, CodeMirror) routinely targets the editor's hidden host element, which modern editors ignore — the keystrokes are swallowed and the editor model is unchanged. Previously the transport reported success regardless, so an agent saw `ok` while nothing had been typed. Added one code to the registry:

- **`TYPE_NO_EFFECT`** — `http: 422`, `retryable: false`, hint: the target ignored the input (e.g. a code editor's hidden textarea); click the editor's content area, then type into the active element with no selector. Raised by `PlaywrightElectronTransport` after `fill` / `typeText` when an editable-content effect check (read the target's `value` || `textContent` before and after, with a short settle for asynchronous editors) shows the content neither changed nor already equals the typed text. `handleTargetFailure` attaches `next_actions` pointing at the click-then-type-active recovery, and the new `electron_type_into_editor` tool performs that recovery directly. Not retryable: the same selector will keep being ignored, so a blind retry is wasted; the fix is a different target. The check errs toward not throwing (empty text, or an unreadable signature, skips it) to avoid false rejections of typing that actually worked. The mirror test registers the code transitively — it is referenced as `code: 'TYPE_NO_EFFECT'` in `transports/playwright-electron.ts`.

## Status Update (2026-06-10) — added `CDP_TIMEOUT`; mirror test upgraded to a TypeScript AST scan

The CDP transport implementation (ADR-003 Status Update of the same date) introduces a bounded per-method protocol call. Added one code to the registry:

- **`CDP_TIMEOUT`** — `http: 408`, `retryable: true`, hint: the CDP method did not respond within its timeout; the target may be busy or hung. Returned by the CDP connection pool when a method call's response frame does not arrive within the per-method budget (distinct from `CDP_DISCONNECTED`, which means the socket itself is gone), and by the connect path when the WebSocket handshake exceeds its budget. Retryable because a busy target can answer a later attempt. The graceful-stop path branches on it: a `Browser.close` that times out (rather than disconnecting) is what triggers SIGKILL escalation.

Separately, the mirror test crossed the upgrade threshold the Alternatives table anticipated: with the lifecycle, interaction, wait, and plugin tool families all referencing codes, the regex v1 was replaced by a TypeScript AST traversal (`ts.createSourceFile` + a syntax walk; no type checker). Comments and prose are now invisible to the scan (no false positives from docstrings), `new StagewrightError('X', …)` / `makeError('X', …)` first arguments are covered alongside `code: 'X'` property assignments, and — superseding the 2026-06-02 note that the mirror stayed core-only — `packages/plugin-*` sources are scanned too: every `makePluginError('<ns>.<KEY>', …)` literal must name a KEY declared in that package's `errorCodes` manifest. `typescript` was already a devDependency, so the upgrade adds no install weight.
