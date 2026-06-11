# ADR-008: MCP server, tool dispatcher, and tool-definition contract

- **Status**: Accepted
- **Date**: 2026-05-28
- **Deciders**: johnny4young
- **Note**: Public ADR. Committed artifacts may cite `ADR-008`; this file is the canonical design record.
- **Status note 2026-06-01**: server, dispatcher, lifecycle, interaction,
  read/wait/eval, observe, dialog, and expect tool families have landed. Plugin
  loading remains future work.

## Context

The project had, before this slice, a set of strong primitives — the transport
abstraction (ADR-003), the error code registry and response envelope (ADR-006),
the snapshot walker (ADR-005), and the agent-native UX principles (ADR-007) — but
nothing that turned them into a runnable MCP server. There was no dispatcher, no
session manager, no server entry point, and the package's `bin` pointed at a
`dist/cli.js` that did not exist. Several already-shipped modules referenced "the
dispatcher" as a known design (`errors/operation-type.ts`, `errors/envelope.ts`)
without that design being written down.

The tool slices (interaction tools, read/wait/eval tools, the ergonomic
primitives) and the plugin model all need a single, stable answer to:
_how is a tool defined, validated, routed, and executed, and how does a tool call
become a wire response?_ Inventing that ad-hoc per slice would produce an
accordion API.

## Decision

1. **A tool is a plain `ToolDefinition` object**: `{ name, title?, description,
inputSchema (Zod object), operationType, requiresEvalFlag?, handler }`. The
   `description` embeds the possible error codes inline (ADR-007 Principle 1).
   `operationType` is internal manifest metadata, declared on the definition and
   NEVER on the agent-facing input (ADR-006 design). `defineTool` infers the input
   shape so a handler's arguments are precisely typed at the definition site, and
   returns an erased `AnyToolDefinition` for uniform storage.

2. **A single `Dispatcher` owns the call lifecycle.** At registration it
   validates `operationType` against the closed `OperationTypeSchema`, so a
   mis-declared tool fails at boot rather than at an agent call. Per call it:
   parses the raw arguments against the tool's Zod schema (a failure becomes
   `BAD_ARGUMENT`, never a raw Zod throw); routes the payload through
   `routeByOperationType` (the eval keyword blocklist always applies here);
   invokes the handler inside a session-correlation context; returns the handler's
   envelope as-is; maps a thrown `StagewrightError` to its code and any other
   throw to `INTERNAL_ERROR`; and logs a warning when a dispatch exceeds the
   slow-op threshold. The dispatcher never throws.

3. **The eval opt-in flag gates tool _visibility_, not per-payload safety.** A tool
   declaring `requiresEvalFlag` is not registered (and never appears in
   `tools/list`) unless the server was started with the flag. The keyword
   blocklist still runs on every eval payload regardless of the flag.

4. **A `SessionManager` owns `sessionId → session` mapping** keyed by the
   transport-assigned session id (a stable, collision-free identifier — no second
   competing id is minted). It resolves "the only session" when one is live,
   raises `BAD_ARGUMENT` on ambiguity and `NOT_RUNNING` when none match, and tears
   sessions down idempotently.

5. **Session correlation flows through `AsyncLocalStorage`.** The dispatcher seeds
   an ambient context with the request's `sessionId`, and the envelope helpers read
   it to stamp `_meta.session_id` without threading the id through every signature.

6. **Logging is stderr-only.** Under the stdio transport, stdout carries the
   JSON-RPC protocol frames; anything else written there corrupts the stream. The
   logger writes exclusively to stderr.

7. **The MCP stdio server registers tools from the dispatcher manifest.**
   `createServer()` assembles the object graph; `connectStdio()` attaches the
   transport; `cli.ts` (the real `bin`) parses `--allow-eval`, starts the server,
   and disposes all sessions on SIGINT/SIGTERM so launched Electron apps are not
   orphaned. A `listManifest()` surface renders each tool's Zod schema to JSON
   Schema for offline documentation generation.

## Alternatives considered

| Alternative                                                    | Why rejected                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Register tools directly on `McpServer` with no dispatcher**  | The SDK validates input and serialises results, but it does not own operation-type routing, the error envelope, slow-op logging, or session correlation. Scattering those across every tool reproduces the per-slice accordion this ADR exists to prevent. |
| **One macro tool with an action selector**                     | ADR-007 already rejected this on the m13v selection-accuracy evidence; granular tools each carry their own schema and description.                                                                                                                         |
| **Mint a server-side sessionId distinct from the transport's** | Redundant — the transport already returns a stable unique id. A second id invites divergence and a positional-handle bug class.                                                                                                                            |
| **Defer the server framework and ship only tool functions**    | The dogfooding goal and the broken `bin` both require a runnable server; deferring leaves the package non-executable.                                                                                                                                      |

## Consequences

- Every later tool slice (interaction, read/wait/eval, ergonomic primitives) and
  the plugin model register `ToolDefinition`s with this dispatcher; they inherit
  validation, routing, envelopes, and logging for free.
- The eval tools land by setting `requiresEvalFlag` and `operationType: 'eval'`;
  no dispatcher or CLI change is needed (the seam ships here).
- `_meta.session_id` is populated when the request carries `sessionId`; the
  single-session default case may omit it (a follow-up can resolve the ambient id
  after session resolution if richer correlation is wanted).
- This decision is revisitable only by amendment (a new ADR or a Status Update
  block here).
