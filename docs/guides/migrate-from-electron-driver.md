# Migrate from electron-driver

A practical bridge for teams using electron-driver (v0.3.x) — what maps one-to-one, what changed
shape, and what exists here that has no counterpart there. The two servers share a lot of surface
vocabulary, so most flows port mechanically; the differences are concentrated in how elements are
addressed and how outcomes are verified.

## The conceptual shift

1. **Tool names are namespaced.** Every core tool carries the `electron_` prefix
   (`click` → `electron_click`); plugin tools carry their plugin's prefix (`trace_*`,
   `production_*`).
2. **Refs are first-class, not positional.** Both servers expose snapshot refs, but here a ref is
   a stable identity tagged onto the DOM (`data-sw-ref`) that survives re-renders; when one does
   go stale, the error carries `similar_refs` candidates and every read reports
   `renderer_reloaded` so wholesale invalidation is detectable. Flows that re-snapshot after every
   action to refresh ref numbers can stop doing that.
3. **Verification is a primitive, not a loop.** Where a flow would chain
   `get_text` → compare client-side → `wait` → re-read, one `electron_expect_*` call does the
   read + compare + retry server-side and returns `expected` vs `actual` on failure.
4. **Every response is a structured envelope.** `{ ok, code, retryable, next_actions }` replaces
   prose error strings; agents branch on the stable `code`.

## Tool mapping

### Lifecycle

| electron-driver | Electron Stagewright  | Notes                                                                                                                                                                             |
| --------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_app`     | `electron_launch`     | Adds preflight (absolute-path + entry checks before spawning), a renderer-ready wait (`readyTimeoutMs`), and registered failure codes (`SINGLE_INSTANCE_LOCK`, `LAUNCH_TIMEOUT`). |
| `stop_app`      | `electron_stop`       | Bounded graceful close that auto-escalates to SIGKILL on timeout and reports `escalated`.                                                                                         |
| —               | `electron_force_kill` | Straight SIGKILL, for a hung app.                                                                                                                                                 |
| `info`          | `electron_info`       | Adds Electron/Chromium/Node versions.                                                                                                                                             |

### Reading the UI

| electron-driver                                                                                                                 | Electron Stagewright                                                                                                                                                                                    | Notes                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`                                                                                                                      | `electron_snapshot`                                                                                                                                                                                     | Entries carry a full state envelope (`checked`, `disabled`, `expanded`, …). `since: "last"` returns deltas — re-scanning every turn is no longer the only option. |
| `accessibility_snapshot`                                                                                                        | `electron_snapshot`                                                                                                                                                                                     | One tool; the accessibility tree IS the snapshot.                                                                                                                 |
| `screenshot`                                                                                                                    | `electron_screenshot`                                                                                                                                                                                   | Adds element capture by ref/selector, window targeting, and `dir` / `--screenshot-dir` for stable artifact paths.                                                 |
| `cleanup_screenshots`                                                                                                           | —                                                                                                                                                                                                       | No counterpart: captures go where you point them (`dir`), so lifecycle is yours.                                                                                  |
| `exists` / `get_text` / `get_attribute` / `get_value` / `get_bbox` / `get_computed_style` / `elements_list` / `focused_element` | `electron_exists` / `electron_get_text` / `electron_get_attribute` / `electron_get_value` / `electron_get_bbox` / `electron_get_computed_style` / `electron_elements_list` / `electron_focused_element` | Same intents. `electron_get_text` falls back to the accessible label when text content is empty, so find-by-name → read chains hold on icon-only controls.        |

### Interaction

| electron-driver                                                                       | Electron Stagewright                                                                                                                        | Notes                                                                                                                                                                |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `click` / `hover` / `drag`                                                            | `electron_click` / `electron_hover` / `electron_drag`                                                                                       | Same semantics.                                                                                                                                                      |
| `type`                                                                                | `electron_type`                                                                                                                             | Sets the value (one input event).                                                                                                                                    |
| `keyboard_type`                                                                       | `electron_keyboard_type`                                                                                                                    | Real keystrokes. A swallowed keystroke (modern code editors ignoring their hidden textarea) is detected and reported as `TYPE_NO_EFFECT` instead of a false success. |
| —                                                                                     | `electron_type_into_editor`                                                                                                                 | The editor recovery as a tool: click the content area, type into the active element; `replace: true` replaces the whole contents.                                    |
| `press`                                                                               | `electron_key`                                                                                                                              | Single chord.                                                                                                                                                        |
| `press_sequence`                                                                      | `electron_press_sequence`                                                                                                                   | Same.                                                                                                                                                                |
| `clear_input` / `select_option` / `check` / `uncheck` / `scroll` / `scroll_into_view` | `electron_clear_input` / `electron_select_option` / `electron_check` / `electron_uncheck` / `electron_scroll` / `electron_scroll_into_view` | Same intents.                                                                                                                                                        |
| `drop_file`                                                                           | `electron_drop_file`                                                                                                                        | Rebuilds real `File` objects in the renderer and reports `default_prevented`, so "no drop handler ran" is visible.                                                   |
| `set_input_files`                                                                     | `electron_set_files`                                                                                                                        | Same intent, with size/count validation.                                                                                                                             |

### Waiting and verification

| electron-driver               | Electron Stagewright                                                                                                                                                                 | Notes                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `wait`                        | `electron_wait`                                                                                                                                                                      | Last resort, unchanged.                                                                                                    |
| `wait_for_selector`           | `electron_wait_for_selector`                                                                                                                                                         | Adds explicit `attached` / `hidden` / `detached` states (use `attached` for offscreen editor inputs).                      |
| `wait_for`                    | `electron_wait_for_state` / `electron_wait_for_event`                                                                                                                                | Split into two precise tools: composite element state, or a renderer event.                                                |
| _(client-side compare loops)_ | `electron_expect_text` / `electron_expect_value` / `electron_expect_visible` / `electron_expect_count` / `electron_expect_state` / `electron_expect_url` / `electron_assert_pattern` | The biggest porting win: each replaces a multi-round-trip loop with one polled call that fails with `expected` + `actual`. |

### Windows, dialogs, evaluation, console

| electron-driver                  | Electron Stagewright                               | Notes                                                                                                                                               |
| -------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `windows_list` / `switch_window` | `electron_windows_list` / `electron_switch_window` | Same.                                                                                                                                               |
| `dialog_handler`                 | `electron_dialog_handler`                          | Adds per-type overrides, `oneShot`, and an event log of every dialog handled.                                                                       |
| `eval_renderer` / `eval_main`    | `electron_eval_renderer` / `electron_eval_main`    | Same escape hatch — but registered only when the eval policy permits that target, so arbitrary-JS execution is an operator decision, not a default. |
| `console_logs`                   | `electron_console_logs`                            | Adds level/regex/time filters at read time and an `overflowed` count, so dropped entries are visible.                                               |

### No counterpart in electron-driver

- `electron_find` — role + accessible-name lookup; no CSS required.
- `electron_attach` / `electron_inject` / `electron_discover_running` / `electron_detach` —
  sessions against already-running apps (CDP attach, no-flag inspector injection, port scanning,
  detach-without-kill). See [Launch, attach, or inject](./launch-or-attach.md).
- Plugins: session tracing + replay + token budgets (`trace_*`), packaged-app production
  validation (`production_validate`), IPC capture/invoke/stub.

## A porting checklist

1. Rename calls per the tables (mechanical; mostly the `electron_` prefix).
2. Replace every read-compare-retry loop with the matching `electron_expect_*` call.
3. Delete defensive re-snapshots taken only to refresh refs; rely on `renderer_reloaded` and
   `similar_refs` instead, and use `since: "last"` where you do re-read.
4. If your flows used `eval_*`, start the server with the narrowest eval target that covers the
   flow (`--allow-eval=renderer`, `--allow-eval=main`, or bare `--allow-eval` for both) — and check
   whether a purpose-built tool (e.g. `electron_find`, `electron_expect_state`) now covers the
   reason the eval existed.
5. Route error handling through `code` + `retryable` instead of message matching.

---

_Design background: the envelope and error registry are ADR-006; refs and snapshot diffs are
ADR-005; the agent-native principles that drive the expect-family design are ADR-007; transports
for attach/inject are ADR-003. The model behind all of this, explained in one place:
[Concepts](./concepts.md)._
