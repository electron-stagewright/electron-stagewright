# Electron Stagewright guides

Task-oriented documentation for driving Electron apps over the Model Context Protocol. Start
where your situation matches:

| You are…                                                         | Read                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| New here and want a working session in minutes                   | [Getting started](./getting-started.md)                           |
| Deciding how to get a session against YOUR app                   | [Launch, attach, or inject](./launch-or-attach.md)                |
| Writing assertions an agent can act on                           | [Assert UI state](./assert-ui-state.md)                           |
| Debugging a flow — screenshots, console, dialogs, session traces | [Capture diagnostics](./capture-diagnostics.md)                   |
| Coming from electron-driver                                      | [Migrate from electron-driver](./migrate-from-electron-driver.md) |
| Deciding whether and how to expose the server                    | [Security model](./security-model.md)                             |

Reference material:

- [`TOOL-REFERENCE.md`](../../TOOL-REFERENCE.md) — every tool, generated from the live manifest
  (parameters, return shapes, error codes). The guides cite tools by name; this is where the full
  contracts live.
- [Architecture Decision Records](../adr/README.md) — why the server is designed the way it is.
  Each guide ends with pointers to the decisions behind the behaviour it documents.

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
