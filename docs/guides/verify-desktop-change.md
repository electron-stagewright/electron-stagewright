# Verify a desktop change

A how-to for the check an agent repeats after every UI change to an Electron app: start a clean
session, get past first-run screens, act, assert, look for console errors, keep evidence, and stop.
Each step is an ordinary tool call the host sees and can approve. No tool runs the sequence for you
([ADR-026](../adr/026-workflow-composition.md)), so you can stop or change course between any two
steps.

The same recipe is served in-band as the MCP resource `stagewright://docs/verify-desktop-change`.

## Before you start

Load the plugins the recipe uses, with no eval flag: native-ui answers file dialogs, storage seeds
settings, and trace (optional) records the run.

```sh
electron-stagewright --plugin native-ui --plugin storage --plugin trace
```

Pick a new directory for each run's evidence, such as `/abs/evidence/run-42`, so screenshots and
traces from different runs never mix. Every path the tools take is absolute.

<!-- stagewright-resource:begin -->

## The recipe at a glance

Every step is an ordinary tool call; stop or change course between any two.

1. `electron_launch { main, env }` against a throwaway profile.
2. `storage_local_set { key, value }` for flags, language and theme, then
   `electron_reload { waitForSelector }`.
3. `electron_dialog_handler { action: "dismiss" }`; `electron_find` the telemetry or tour button
   (read `hints` when it matches nothing); `electron_click`.
4. `native_file_dialog_arm { responses }` before an import or export.
5. `electron_snapshot { format: "text" }` and `electron_console_logs { type: "error" }` as the
   baseline.
6. Act: `electron_click`, `electron_keyboard_type { text, requireEditable: true }`,
   `native_menu_invoke`, or `electron_set_window_size` (check `clamped`).
7. `electron_snapshot { format: "text", since: "last" }` to see what changed.
8. `electron_expect_*` on the result; `native_file_dialog_events` for dialogs.
9. `electron_console_logs { type: "error", since }` with the newest baseline timestamp.
10. `electron_expect_visible` on the changed element, then `electron_screenshot { path }` with a path
    no other capture uses.
11. `electron_stop`.

Each step, with example calls and the traps the tools report, is under _Step by step_ in
`docs/guides/verify-desktop-change.md`.

<!-- stagewright-resource:end -->

## Step by step

1. **Launch a clean session.** Point the app at a throwaway profile, the way your app supports it
   (an env var or a flag), so earlier runs cannot leak state.

   ```json
   electron_launch { "main": "/abs/app/main.js", "env": { "APP_PROFILE_DIR": "/abs/evidence/run-42/profile" } }
   ```

   Add `"instrumentNative": true` only when the app keeps its own reference to the dialog functions
   (`const { showOpenDialog } = dialog` at import): it installs the file-dialog hook before the
   app's main runs, by starting the app through a small wrapper main, so `process.argv[1]` points at
   that wrapper. Without it, arming installs the hook.

2. **Seed settings, then reload.** Feature flags, language and theme usually live in
   `localStorage`; values are strings, so encode objects as JSON. Reload instead of
   `location.reload()` in eval: it waits for the new page.

   ```json
   storage_local_set { "key": "featureFlags", "value": "{\"newPicker\":true}" }
   storage_local_set { "key": "language", "value": "es" }
   electron_reload { "waitForSelector": "#app" }
   ```

3. **Get past first-run screens.** Find the telemetry banner or the tour by role and name, not by
   selector. A find that matches nothing returns `hints` (close names, filtered matches, text that
   is not an accessible name) and `next_actions`. Answer `alert` / `confirm` dialogs up front.

   ```json
   electron_dialog_handler { "action": "dismiss" }
   electron_find { "role": "button", "name_contains": "Decline" }
   electron_click { "ref": 3 }
   ```

4. **Arm file dialogs** when the change touches import or export. Each open or save dialog takes
   the next answer; an empty queue cancels, so nothing waits on an OS picker.

   ```json
   native_file_dialog_arm { "responses": [{ "kind": "open", "paths": ["/abs/fixtures/dump.sql"] }, { "kind": "save", "path": "/abs/evidence/run-42/export.csv" }] }
   ```

5. **Take a baseline** in the compact text format, and read the console errors already there
   (from startup or first-run screens) so step 9 only shows new ones.

   ```json
   electron_snapshot { "format": "text" }
   electron_console_logs { "type": "error" }
   ```

6. **Act.** Click, type, invoke a menu item, or resize the window for a layout check. Typing
   without a target reports where the keys went; `requireEditable` fails instead of typing into
   nothing. A resize reports `clamped` when the app's minimum size won.

   ```json
   electron_click { "selector": "#import" }
   electron_keyboard_type { "text": "orders", "requireEditable": true, "waitForFocusMs": 2000 }
   native_menu_invoke { "path": ["File", "Export"] }
   electron_set_window_size { "width": 1280, "height": 720 }
   ```

7. **See what changed** since the baseline.

   ```json
   electron_snapshot { "format": "text", "since": "last" }
   ```

8. **Assert.** The `expect_*` tools retry until the state holds or the timeout ends. Check the file
   dialogs too: each event names the options the app passed and the answer it got.

   ```json
   electron_expect_text { "selector": "#status", "contains": "Exported" }
   native_file_dialog_events {}
   ```

9. **Check the console** for errors raised by the change: pass the `timestamp` of the newest
   baseline entry plus one as `since` (omit it when the baseline had none).

   ```json
   electron_console_logs { "type": "error", "since": 1761235200001 }
   ```

10. **Keep evidence.** Assert the changed element is visible first, then capture to a path no other
    capture uses. The screenshot waits for a fresh frame; `same_as_previous: true` means the
    window did not change since the last capture of it.

    ```json
    electron_expect_visible { "selector": "#export-summary" }
    electron_screenshot { "path": "/abs/evidence/run-42/03-export-done.png" }
    ```

11. **Stop** the session, which closes the app.

    ```json
    electron_stop {}
    ```

## Traps the tools now report

| Symptom                                              | What to use                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `require(` refused in `electron_eval_main`           | The error's hint: the electron module is `electronApp` (`arguments[0]`); prefer the tools in this guide |
| `RENDERER_NAVIGATED` while a page reloads            | Retry after it; use `electron_reload` rather than `location.reload()`                                   |
| Typed text that reached nothing                      | `focused` in the result, or `requireEditable` for `NO_FOCUSED_EDITABLE`                                 |
| Two captures that look the same                      | `waitForFrame` (default), `content_sha256`, `same_as_previous`                                          |
| `electron_find` matches nothing                      | `hints` and `next_actions` in the result                                                                |
| A window smaller than the app allows                 | `clamped`, `clamped_by` and `min_size` from `electron_set_window_size`                                  |
| An open or save dialog the agent cannot click        | `native_file_dialog_arm`, then `native_file_dialog_events`                                              |
| Settings that only apply after a restart of the page | `storage_local_set`, then `electron_reload`                                                             |
| A capture overwrote an earlier one                   | A unique `path` per capture; the result reports `overwrote`                                             |

## Record the run

With the trace plugin loaded, wrap the recipe in `trace_start` / `trace_stop`. The trace holds every
call above with its arguments and result, including the queued dialog answers and, once
`native_file_dialog_events` is read, the answers given. `trace_view` renders it to one HTML file;
see [Capture diagnostics](./capture-diagnostics.md).

```json
trace_start { "dir": "/abs/evidence/run-42" }
trace_stop {}
```

## Run it unattended

To repeat the check in CI, promote a recorded trace to a reviewed replay spec with `trace_promote`
and run it with `electron-stagewright-replay` (see
[Run a promoted spec in CI](./capture-diagnostics.md#run-a-promoted-spec-in-ci)). A spec fixes its
arguments today. Parameterizing it, so one spec covers each language or theme, is the planned next
step in [ADR-026](../adr/026-workflow-composition.md) and needs its own ADR amendment first.
