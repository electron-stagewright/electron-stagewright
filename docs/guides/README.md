# Electron Stagewright guides

Public documentation for driving Electron apps over the Model Context Protocol. Start where your
situation matches:

| You are…                                                         | Read                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| New here and want a working session in minutes                   | [Getting started](./getting-started.md)                           |
| Wiring the server into Claude Desktop, Cursor, or another client | [Connect your MCP client](./connect-your-mcp-client.md)           |
| Deciding how to get a session against YOUR app                   | [Launch, attach, or inject](./launch-or-attach.md)                |
| Writing assertions an agent can act on                           | [Assert UI state](./assert-ui-state.md)                           |
| Driving a code editor (Monaco, CodeMirror, EditContext)          | [Type into code editors](./type-into-code-editors.md)             |
| Debugging a flow — screenshots, console, dialogs, session traces | [Capture diagnostics](./capture-diagnostics.md)                   |
| Coming from electron-driver                                      | [Migrate from electron-driver](./migrate-from-electron-driver.md) |
| Deciding whether and how to expose the server                    | [Security model](./security-model.md)                             |
| Trying to understand how it works, and why                       | [Concepts](./concepts.md)                                         |

## The four kinds of docs here

These docs follow the [Diátaxis](https://diataxis.fr) split, so you can tell at a glance what a page
is _for_:

- **Tutorial** — learning-oriented. [Getting started](./getting-started.md) walks a first session
  end to end.
- **How-to** — task-oriented. [Connect your MCP client](./connect-your-mcp-client.md),
  [Launch, attach, or inject](./launch-or-attach.md), [Assert UI state](./assert-ui-state.md),
  [Type into code editors](./type-into-code-editors.md),
  [Capture diagnostics](./capture-diagnostics.md), and
  [Migrate from electron-driver](./migrate-from-electron-driver.md) each solve one job.
- **Explanation** — understanding-oriented. [Concepts](./concepts.md) explains the agent-native
  model and why the server is shaped the way it is; the [Security model](./security-model.md)
  explains the trust boundaries.
- **Reference** — information-oriented. [`TOOL-REFERENCE.md`](../../TOOL-REFERENCE.md) lists every
  tool (parameters, return shapes, error codes) generated from the live manifest, and the
  [Architecture Decision Records](../adr/README.md) record why each decision was made.

## Conventions the guides assume

Every tool returns a JSON envelope discriminated by `ok`. On failure, branch on the stable `code`
(never the prose), check `retryable`, and look at `next_actions` for the recommended recovery:

```json
{
  "ok": false,
  "code": "SELECTOR_NO_MATCH",
  "error": "\"#missing\" matched no element.",
  "retryable": false,
  "next_actions": ["electron_snapshot()", "electron_find({ role, name_contains })"]
}
```

Sessions thread through every call: `electron_launch` / `electron_attach` / `electron_inject`
return a `session_id`; pass it to subsequent calls (it may be omitted while exactly one session is
live) and end the session with `electron_stop`.
