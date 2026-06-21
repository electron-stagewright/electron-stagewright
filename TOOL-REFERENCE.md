# Tool reference

> Generated from the dispatcher manifest — do not edit by hand. Run `pnpm docs:tools` to regenerate.

The server exposes 53 tools across 7 operation types. Tools marked with a "Requires `--allow-eval…`" label register only when the eval policy permits that target.

## Contents

- [Command tools](#command-tools) (23)
- [Dialog tools](#dialog-tools) (1)
- [Eval tools](#eval-tools) (2)
- [Logs tools](#logs-tools) (1)
- [Query tools](#query-tools) (24)
- [Screenshot tools](#screenshot-tools) (1)
- [Window_info tools](#window_info-tools) (1)

## Command tools

### `electron_attach`

**Attach to running Electron app**

Attach to an already-running Electron app exposing a CDP debug endpoint (use electron_discover_running to find one, or start the app with --remote-debugging-port). Provide port (+ optional loopback host) or a loopback cdpUrl; pid alone is not attachable over CDP but, when supplied alongside, lets stop escalate to SIGKILL. The CDP transport supports eval/read/observe and core interaction surfaces against the attached app. Returns: { ok, session_id, transport, windows }. Errors: TRANSPORT_UNSUPPORTED (no attach-capable transport), CDP_DISCONNECTED (endpoint unreachable or dropped; retryable), CDP_TIMEOUT (handshake/method timeout; retryable), BAD_ARGUMENT (missing target selector or non-loopback endpoint).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `port` | integer | no | CDP port; the endpoint is resolved from /json/version. |
| `host` | string | no | Loopback host for port-based attach. Defaults to localhost. |
| `cdpUrl` | string | no | Full CDP WebSocket URL on a loopback host. |
| `pid` | integer | no | Process id of the running app. |
| `timeoutMs` | integer | no | Max wait for the attach handshake. |

### `electron_check`

**Check a checkbox or radio**

Check the checkbox/radio identified by ref or selector (no-op if already checked). Options: force, timeoutMs. Returns: { ok, session_id, target, checked: true }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_clear_input`

**Clear an input**

Clear the value of the input/textarea identified by ref or selector (sets it to empty). Options: force, timeoutMs. Returns: { ok, session_id, target, cleared }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_click`

**Click an element**

Click the element identified by ref (from a snapshot) or selector. Options: button (left|right|middle, default left), clickCount (2 = double-click), force (bypass actionability), timeoutMs. Returns: { ok, session_id, target }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (no such element — re-snapshot; not retryable, carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED (not retryable), NOT_RUNNING, BAD_ARGUMENT (ref+selector both/neither).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `button` | string | no | Mouse button. Default left. |
| `clickCount` | integer | no | Number of clicks (2 for a double-click). Default 1. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_detach`

**Detach from Electron app**

Disconnect from an app without stopping it. Not yet supported by any transport (detaching from a launched app is indistinguishable from stopping it today). Returns TRANSPORT_UNSUPPORTED; use electron_stop to end the session. Errors: TRANSPORT_UNSUPPORTED (not retryable), NOT_RUNNING (no such session), BAD_ARGUMENT (multiple sessions).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_drag`

**Drag one element onto another**

Drag the source element (ref or selector) onto the target element (targetRef or targetSelector), using the real mouse API. Options: force, timeoutMs. Returns: { ok, session_id, source, target }. Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), NOT_RUNNING, BAD_ARGUMENT (a side missing or both ref+selector given).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `targetRef` | integer | no | Drop-target ref. Provide targetRef OR targetSelector. |
| `targetSelector` | string | no | Drop-target CSS/text selector. Provide targetRef OR targetSelector. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_drop_file`

**Drop files onto an element**

Simulate dropping OS files onto the element identified by ref or selector. Web DataTransfer mode: reads each path on the host running the server, rebuilds the files in the renderer, and dispatches dragenter/dragover/drop with a real DataTransfer — engaging standard web drop handlers. Paths must be ABSOLUTE (max 10 files, 5242880 bytes each). default_prevented reports whether a drop handler engaged (called preventDefault); false usually means the target has no web drop handler. Apps that resolve dropped files to native OS paths need an app-specific IPC convention this tool does not simulate. Options: mimeType, timeoutMs. Returns: { ok, session_id, target, files, default_prevented }. Errors: ABSOLUTE_PATH_REQUIRED, FILE_NOT_FOUND, BAD_ARGUMENT (too many/large files, or ref+selector both), SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), NOT_RUNNING.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `paths` | string[] | yes | Absolute file paths to drop. |
| `mimeType` | string | no | MIME type override applied to every file (defaults to extension-based). |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_force_kill`

**Force-kill Electron app**

Forcefully kill a session (SIGKILL) and release it — the escape hatch when stop hangs. Pass sessionId to target a specific session. Returns: { ok, session_id, killed: true }. Errors: NOT_RUNNING (no such session; not retryable), BAD_ARGUMENT (multiple sessions live — pass sessionId).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_hover`

**Hover an element**

Hover the element identified by ref or selector (e.g. to reveal a tooltip or menu). Options: force, timeoutMs. Returns: { ok, session_id, target }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), NOT_RUNNING, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_inject`

**Inject into running Electron app**

Attach to a running Electron process that was NOT started with a debug flag, by injecting the Node inspector. Provide pid. Returns: { ok, session_id, transport, windows }. Errors: INJECT_FAILED (handshake failed or inspector belongs to another process; retryable — try electron_attach when the app already exposes a debug endpoint), TRANSPORT_UNSUPPORTED, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pid` | integer | yes | Process id of the running Electron app. |
| `timeoutMs` | integer | no | Max wait for the inspector handshake. |

### `electron_key`

**Press a key or chord**

Press a key or chord (e.g. 'Enter', 'Control+A', 'ArrowDown'). Focuses ref/selector first when given; otherwise presses against the active element. For editors, click the visible content area first; reserve force:true for offscreen inputs that truly accept focus. Options: force, timeoutMs. Returns: { ok, session_id, key }. Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), NOT_RUNNING, BAD_ARGUMENT (ref+selector both).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `key` | string | yes | Key or chord, e.g. 'Enter' or 'Control+A'. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_keyboard_type`

**Type text as real keystrokes**

Type text as real per-character keystrokes (fires keydown/keypress/input/keyup per char), unlike electron_type which sets the value directly. Focuses ref/selector first when given; otherwise types into the active element. For a code editor (Monaco / EditContext), the reliable path is electron_type_into_editor (it clicks the editor content area, e.g. '.monaco-editor .view-lines', then types into the focused editor) — do NOT target the hidden textarea, which modern editors ignore. force:true focuses an offscreen/aria-hidden input but a swallowed keystroke returns TYPE_NO_EFFECT. Options: force, timeoutMs. Returns: { ok, session_id, typed }. Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), TYPE_NO_EFFECT (typing changed nothing — use electron_type_into_editor), NOT_RUNNING, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `text` | string | yes | The text to type, character by character. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_launch`

**Launch Electron app**

Launch an Electron app and start a driving session. Provide main (absolute path to the main-process entry) or executablePath. Returns: { ok, session_id, transport, windows, renderer_ready }. Waits (up to readyTimeoutMs, default 5000) for the renderer DOM to finish its initial render, so a snapshot/find right after launch sees a populated app; renderer_ready:false means it was not confirmed in time (the session is still usable — retry the read, or wait_for_selector on an expected element). By default refuses a second launch while a session is live (pass allowMultiple: true to override). Errors: ALREADY_RUNNING (a session is live, or the concurrent-session cap is reached — stop one or pass allowMultiple; not retryable), ABSOLUTE_PATH_REQUIRED / FILE_NOT_FOUND (preflight; not retryable), BAD_ARGUMENT (neither main nor executablePath given; a runtime-altering env var like NODE_OPTIONS; instrumentNative without main; or, when the server set --app-root, a main/executablePath/cwd outside that root), SINGLE_INSTANCE_LOCK (another app instance holds the lock; not retryable), LAUNCH_TIMEOUT (first window did not appear; retryable), TRANSPORT_UNSUPPORTED (no launch-capable transport).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `main` | string | no | Absolute path to the app main-process JS entry. Required unless executablePath is given. |
| `executablePath` | string | no | Absolute path to an Electron/app binary. Defaults to the bundled Electron. |
| `args` | string[] | no | Extra CLI args appended after the entry. |
| `env` | object | no | Environment variables for the spawned process. |
| `cwd` | string | no | Working directory for the spawned process. |
| `timeoutMs` | integer | no | Max wait for the first window. |
| `readyTimeoutMs` | integer | no | Max wait (ms) for the renderer DOM to finish its initial render before returning. Default 5000; 0 returns immediately with renderer_ready reflecting the instantaneous state. |
| `allowMultiple` | boolean | no | Allow launching when a session already exists. Default false (single instance). |
| `instrumentNative` | boolean | no | Wrap the app main entry with a fixed hook installed before it runs, so native UI created at startup (the system Tray) is readable and invokable (required for native_trays / native_tray_invoke). Off by default; runs no agent code. Requires main; executablePath-only launches cannot be instrumented. Launch transport only. |

### `electron_press_sequence`

**Press a sequence of keys**

Press each key in `keys`, in order (e.g. ['Control+A', 'Delete', 'Enter']). Focuses ref/selector first when given. For editors, click the visible content area first; reserve force:true for offscreen inputs that truly accept focus. Options: force, timeoutMs. Returns: { ok, session_id, keys }. Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), NOT_RUNNING, BAD_ARGUMENT (empty keys or ref+selector both).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `keys` | string[] | yes | Ordered keys/chords to press. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_scroll`

**Scroll the page or an element into view**

Scroll: with ref/selector, centre that element into view; otherwise dispatch a wheel delta (dx/dy). Options: timeoutMs. Returns: { ok, session_id, target } (into-view) or { ok, session_id, dx, dy } (wheel). Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (no element matched the selector; carries similar_refs), NOT_RUNNING, BAD_ARGUMENT (ref+selector both).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `dx` | number | no | Horizontal wheel delta in CSS px (used when no ref/selector). |
| `dy` | number | no | Vertical wheel delta in CSS px (used when no ref/selector). |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_scroll_into_view`

**Scroll an element into view**

Centre the element identified by ref or selector into the viewport. Options: timeoutMs. Returns: { ok, session_id, target }. Errors: SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), NOT_RUNNING, BAD_ARGUMENT (ref+selector both/neither).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_select_option`

**Select option(s) in a dropdown**

Select option(s) by value in the <select> identified by ref or selector. Options: force, timeoutMs. Returns: { ok, session_id, target, selected } (selected = the values actually chosen). Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `values` | string[] | yes | Option values to select. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_set_files`

**Set files on a file input**

Set the files of the <input type=file> identified by ref or selector. Paths must be ABSOLUTE and exist on the host running the server (max 20 files, 52428800 bytes each). Options: timeoutMs. Returns: { ok, session_id, target, files }. Errors: ABSOLUTE_PATH_REQUIRED (relative path; not retryable), FILE_NOT_FOUND (missing path), BAD_ARGUMENT (too many/large files, or ref+selector both), SELECTOR_NO_MATCH / REF_NOT_FOUND (carries similar_refs), NOT_RUNNING.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `paths` | string[] | yes | Absolute file paths to attach. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_stop`

**Stop Electron app**

Gracefully stop a session and release it. If the app ignores the close within timeoutMs (default 10s) the stop auto-escalates to SIGKILL, so the process is always reaped and never left orphaned; the response reports escalated: true when that happened. Pass sessionId to target a specific session. Returns: { ok, session_id, stopped: true, escalated }. Errors: NOT_RUNNING (no such session; not retryable), BAD_ARGUMENT (multiple sessions live — pass sessionId).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |
| `timeoutMs` | integer | no | Graceful-close budget in ms before escalating to SIGKILL. Defaults to 10000. |

### `electron_switch_window`

**Switch active Electron window**

Select the active window by precedence targetId > windowTitle > index > default. Selecting the already-active window is a no-op success; switching to a different window is not yet supported by any transport. Returns: { ok, session_id, active } on success. Errors: REF_NOT_FOUND (no window matched; not retryable), TRANSPORT_UNSUPPORTED (cannot switch to a non-default window yet; not retryable), NOT_RUNNING, BAD_ARGUMENT (multiple sessions).

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `targetId` | string | no | Transport window id (highest precedence). |
| `windowTitle` | string | no | Exact window title (second precedence). |
| `index` | integer | no | 0-based window index (third precedence). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_type`

**Type text into an input**

Set the value of the input/textarea identified by ref or selector (fires an input event). For a code editor (Monaco / EditContext, CodeMirror) use electron_type_into_editor — setting .value on an editor host does not update its model. Options: force, timeoutMs. Returns: { ok, session_id, target }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED, TYPE_NO_EFFECT (value did not change — wrong target), NOT_RUNNING, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `text` | string | yes | The text to set as the element value. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_type_into_editor`

**Type into a code editor**

Type into a code editor (Monaco / EditContext, CodeMirror, contenteditable) the reliable way: click the editor's content area identified by ref or selector (e.g. '.monaco-editor .view-lines'), then type the text into the now-focused editor as real keystrokes. Use this instead of typing into an editor's hidden textarea, which modern EditContext editors ignore (returns TYPE_NO_EFFECT). Pass replace:true to REPLACE the editor contents: after the focusing click it selects all (Meta/Control+A, platform-aware) and types over the selection — no second click that would collapse the selection; with empty text it clears the editor (select-all + Delete). Editor auto-pairing caveat: real keystrokes trigger auto-closing of quotes/brackets, so typed source can gain debris like a trailing }') — type pairing-safe fragments, or use replace:true and include the full intended contents. Returns: { ok, session_id, target, typed, replaced }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), TYPE_NO_EFFECT, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `text` | string | yes | The text to type into the focused editor. |
| `replace` | boolean | no | Select all before typing, replacing the editor contents instead of appending. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_uncheck`

**Uncheck a checkbox**

Uncheck the checkbox identified by ref or selector (no-op if already unchecked). Options: force, timeoutMs. Returns: { ok, session_id, target, checked: false }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), ELEMENT_NOT_VISIBLE (retryable), ELEMENT_DISABLED, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `command`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `force` | boolean | no | Bypass actionability checks (visibility/enabled/stable). Default false. |
| `timeoutMs` | integer | no | Actionability budget in ms (default 5000, clamped to 30000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

## Dialog tools

### `electron_dialog_handler`

**Handle native dialogs**

Arm the auto-responder for native JS dialogs (alert/confirm/prompt/beforeunload) and read which dialogs fired. Dialogs block the renderer, so the policy is applied automatically the instant one appears. Arming args (all optional): action (accept|dismiss — the default for every dialog), perType (per-kind overrides, e.g. {"confirm":"accept","beforeunload":"dismiss"}, falls back to action), promptText (text submitted to prompt() when it is accepted), oneShot (apply to exactly the next dialog, then revert to dismiss). With NO arming args the call is inspect-only and leaves the policy unchanged. Read args (all optional): type (one or more kinds to include), since (epoch ms), limit (max events, default 50, max 200 — most recent kept), clear (flush the whole buffer after reading). Until armed, the default policy is dismiss, so dialogs never hang the app. Returns: { ok, session_id, policy, entries: [{ type, message, action, defaultValue?, promptText?, timestamp, windowId? }], count, overflowed }. overflowed counts dropped events across the whole buffer, not just the returned (type/since/limit-filtered) subset. Errors: NOT_RUNNING, BAD_ARGUMENT (promptText without an accepting prompt policy, or oneShot without a policy to arm).

- Operation: `dialog`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | no | Default response for every dialog. Omit (with no perType) for an inspect-only call. |
| `perType` | object | no | Per-kind response overrides; a kind not listed falls back to action. |
| `promptText` | string | no | Text submitted to prompt() dialogs when they are accepted. |
| `oneShot` | boolean | no | Apply the policy to exactly the next dialog, then revert to dismiss. |
| `type` | union | no | Dialog kind(s) to include when reading, e.g. "confirm" or ["confirm","prompt"]. |
| `since` | integer | no | Only events with timestamp >= this (epoch ms). |
| `limit` | integer | no | Max events to return (default 50, max 200); keeps the most recent. |
| `clear` | boolean | no | Flush the entire dialog buffer after reading (not just the returned subset). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

## Eval tools

### `electron_eval_main`

**Evaluate JS in the main process**

Evaluate JavaScript in the main process and return the returned/awaited value; the code receives a JSON `arg`. Only available when the eval policy permits the main target (start the server with --allow-eval, or --allow-eval=main); otherwise this tool is not registered. The code passes a keyword blocklist and a structural (AST) check before running, and large or non-JSON results are serialised/truncated. Returns: { ok, session_id, result, truncated?, result_serialized?, result_chars? }. Errors: EVAL_BLOCKED_KEYWORD / EVAL_BLOCKED_CONSTRUCT (blocked keyword or construct; not retryable), EVAL_SYNTAX_ERROR, EVAL_RUNTIME_ERROR, EVAL_TIMEOUT (retryable), TRANSPORT_UNSUPPORTED (transport cannot eval here), NOT_RUNNING, BAD_ARGUMENT (multiple sessions).

- Operation: `eval` · Requires `--allow-eval=main`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | yes | JavaScript to evaluate in the main process. Receives the JSON `arg`. |
| `arg` | any | no | JSON value passed to the code as `arg`. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_eval_renderer`

**Evaluate JS in the focused renderer**

Evaluate JavaScript in the focused renderer and return the returned/awaited value; the code receives a JSON `arg`. Only available when the eval policy permits the renderer target (start the server with --allow-eval, or --allow-eval=renderer); otherwise this tool is not registered. The code passes a keyword blocklist and a structural (AST) check before running, and large or non-JSON results are serialised/truncated. Returns: { ok, session_id, result, truncated?, result_serialized?, result_chars? }. Errors: EVAL_BLOCKED_KEYWORD / EVAL_BLOCKED_CONSTRUCT (blocked keyword or construct; not retryable), EVAL_SYNTAX_ERROR, EVAL_RUNTIME_ERROR, EVAL_TIMEOUT (retryable), TRANSPORT_UNSUPPORTED (transport cannot eval here), NOT_RUNNING, BAD_ARGUMENT (multiple sessions).

- Operation: `eval` · Requires `--allow-eval=renderer`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `code` | string | yes | JavaScript to evaluate in the focused renderer. Receives the JSON `arg`. |
| `arg` | any | no | JSON value passed to the code as `arg`. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

## Logs tools

### `electron_console_logs`

**Read console logs**

Read the captured renderer console output for the session, newest-relevant entries last. Filters (all optional, ANDed): type (one or more of log/info/warning/error/debug/...), match (a regular expression the text must match), since (epoch ms — only entries at/after it), limit (max entries, default 200, max 1000 — the most recent are kept). Returns: { ok, session_id, entries: [{ type, text, timestamp, windowId?, location? }], count, overflowed }. overflowed is the number of older entries the buffer dropped. Errors: NOT_RUNNING, BAD_ARGUMENT (invalid regex, or multiple sessions).

- Operation: `logs`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | union | no | Console level(s) to include, e.g. "error" or ["warning", "error"]. |
| `match` | string | no | Regular expression the entry text must match. |
| `since` | integer | no | Only entries with timestamp >= this (epoch ms). |
| `limit` | integer | no | Max entries to return (default 200, max 1000); keeps the most recent. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

## Query tools

### `electron_assert_pattern`

**Assert a text or attribute pattern**

Validate, in a single check (no polling), that an element's text or a named attribute matches a pattern. Target by ref or selector. With `attribute` set, reads that attribute; otherwise reads the element's trimmed text. Provide exactly one of: equals, contains, matches_regex. Optional flags (any of i, m, s, u) apply to matches_regex; g and y are rejected as stateful. Returns: { ok, session_id, matched, actual }. Errors: EXPECTATION_FAILED (element found but its value did not match the pattern — details carry expected + actual; a missing attribute reads as actual: null), SELECTOR_NO_MATCH (no element matched — this is one-shot, so a missing element is a precondition failure, not a retry; carries similar_refs), REF_NOT_FOUND (stale ref), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (no/multiple predicates, invalid regex or flags, or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `attribute` | string | no | Attribute name to read (e.g. "value", "aria-label"). Omit to read text. |
| `equals` | string | no | The value must equal this exactly. |
| `contains` | string | no | The value must contain this substring. |
| `matches_regex` | string | no | The value must match this JavaScript regular expression. |
| `flags` | string | no | Optional regex flags (any of i, m, s, u) applied to the regex predicate; g and y are rejected as stateful. Only valid alongside a regex predicate. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_discover_running`

**Discover running Electron apps**

Scan the conventional CDP debug ports (9222-9225 by default) for already-running, debuggable Electron apps on loopback only. No session required. Returns: { ok, targets, count, scanned } where each target is { targetId, port, appName, pid } and scanned reports { host, ports, elapsed_ms } so an empty result is unambiguous. Errors: BAD_ARGUMENT (non-loopback host, invalid port list, or timeout outside bounds). A failed probe is simply "no target on that port".

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ports` | integer[] | no | Ports to scan. Defaults to 9222-9225. Max 64. |
| `host` | string | no | Loopback host to scan. Defaults to 127.0.0.1. |
| `timeoutMs` | integer | no | Per-port timeout in ms. Defaults to 300. Max 5000. |

### `electron_elements_list`

**List elements matching a selector**

Return every element matching a CSS selector as { ref, role, name, bbox }, capped at `limit` (default 50, max 200). When more matched than returned,  `truncated` is the number dropped and `count` is the true total. Returns: { ok, session_id, matches, count, truncated }. Errors: TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, limit, or multiple sessions).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `selector` | string | yes | CSS selector to match (e.g. "button", "[role=tab]"). |
| `limit` | integer | no | Max matches to return (default 50, max 200). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_exists`

**Check whether an element exists**

Return whether the element identified by ref or selector is present in the DOM. A no-match is a normal result (exists: false), NOT an error — so an agent can poll for appearance/disappearance. Returns: { ok, session_id, exists }. Errors: TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_expect_count`

**Expect a match count**

Assert how many elements match, polling until the count satisfies the predicate or timeoutMs elapses. Target EITHER by selector (counts querySelectorAll; visible:true counts visible only, visible:false counts hidden only) OR by accessibility role/name filters (role, name_contains, name_exact, visible, enabled, interactive). Provide at least one of equals, min, max. Returns: { ok, session_id, matched, actual }. Errors: EXPECTATION_FAILED (count predicate not met within timeoutMs — details carry expected + actual; retryable), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (no count predicate, or selector mixed with role filters).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `selector` | string | no | CSS selector to count. Omit to count by role/name. |
| `role` | string | no | Accessibility role to match (role mode). |
| `name_contains` | string | no | Substring the accessible name must contain (role mode). |
| `name_exact` | string | no | Exact accessible name to match (role mode). |
| `visible` | boolean | no | Count only visible (or hidden) matches. |
| `enabled` | boolean | no | Restrict to enabled (or disabled) matches (role mode). |
| `interactive` | boolean | no | Restrict to interactive matches (role mode). |
| `equals` | integer | no | The match count must equal this. |
| `min` | integer | no | The match count must be >= this. |
| `max` | integer | no | The match count must be <= this. |
| `timeoutMs` | integer | no | Max poll time in ms before EXPECTATION_FAILED (default 5000, clamped to 60000). 0 = check once. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_expect_state`

**Expect an element state**

Assert the element identified by ref or selector matches the given state flags (any of visible, enabled, disabled, checked, selected, expanded, pressed, focused, readonly, required, invalid, busy), evaluated atomically and polled until they hold or timeoutMs elapses. Returns: { ok, session_id, matched, state }. Errors: EXPECTATION_FAILED (state not reached within timeoutMs — details carry expected + the last observed actual state; retryable), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, no state flags, or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `state` | object | yes |  |
| `timeoutMs` | integer | no | Max poll time in ms before EXPECTATION_FAILED (default 5000, clamped to 60000). 0 = check once. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_expect_text`

**Expect element text**

Assert the text of the element identified by ref or selector matches a predicate, polling until it holds or timeoutMs elapses. Provide exactly one of: equals, contains, regex, not_equals, not_contains. Optional flags (any of i, m, s, u) apply to regex; g and y are rejected as stateful. Returns: { ok, session_id, matched, actual }. Errors: EXPECTATION_FAILED (predicate not met within timeoutMs — details carry expected + actual; retryable), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (no/multiple predicates, invalid regex or flags, or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `equals` | string | no | The text must equal this exactly. |
| `contains` | string | no | The text must contain this substring. |
| `regex` | string | no | The text must match this JavaScript regular expression. |
| `not_equals` | string | no | The text must NOT equal this. |
| `not_contains` | string | no | The text must NOT contain this substring. |
| `flags` | string | no | Optional regex flags (any of i, m, s, u) applied to the regex predicate; g and y are rejected as stateful. Only valid alongside a regex predicate. |
| `timeoutMs` | integer | no | Max poll time in ms before EXPECTATION_FAILED (default 5000, clamped to 60000). 0 = check once. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_expect_url`

**Expect the window URL**

Assert the active window's URL (location.href) satisfies a predicate, polling until it does or timeoutMs elapses. Provide exactly one of: contains (substring) or matches (JavaScript regex). Optional flags (any of i, m, s, u) apply to matches; g and y are rejected as stateful. Returns: { ok, session_id, matched, actual }. Errors: EXPECTATION_FAILED (URL did not match within timeoutMs — details carry expected + actual; retryable), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (no/both predicates, or invalid regex or flags).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `contains` | string | no | The URL must contain this substring. |
| `matches` | string | no | The URL must match this JavaScript regular expression. |
| `flags` | string | no | Optional regex flags (any of i, m, s, u) applied to the regex predicate; g and y are rejected as stateful. Only valid alongside a regex predicate. |
| `timeoutMs` | integer | no | Max poll time in ms before EXPECTATION_FAILED (default 5000, clamped to 60000). 0 = check once. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_expect_value`

**Expect form control value**

Assert the value of the element identified by ref or selector matches a predicate, polling until it holds or timeoutMs elapses. Provide exactly one of: equals, contains, regex, not_equals, not_contains. Optional flags (any of i, m, s, u) apply to regex; g and y are rejected as stateful. Returns: { ok, session_id, matched, actual }. Errors: EXPECTATION_FAILED (predicate not met within timeoutMs — details carry expected + actual; retryable), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (no/multiple predicates, invalid regex or flags, or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `equals` | string | no | The text must equal this exactly. |
| `contains` | string | no | The text must contain this substring. |
| `regex` | string | no | The text must match this JavaScript regular expression. |
| `not_equals` | string | no | The text must NOT equal this. |
| `not_contains` | string | no | The text must NOT contain this substring. |
| `flags` | string | no | Optional regex flags (any of i, m, s, u) applied to the regex predicate; g and y are rejected as stateful. Only valid alongside a regex predicate. |
| `timeoutMs` | integer | no | Max poll time in ms before EXPECTATION_FAILED (default 5000, clamped to 60000). 0 = check once. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_expect_visible`

**Expect an element visible**

Assert the element identified by ref or selector is visible, polling until it is or timeoutMs elapses. Visible means attached, laid out, and not visibility:hidden. Returns: { ok, session_id, matched }. Errors: EXPECTATION_FAILED (not visible within timeoutMs; retryable), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `timeoutMs` | integer | no | Max poll time in ms before EXPECTATION_FAILED (default 5000, clamped to 60000). 0 = check once. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_find`

**Find elements by role and name**

Find elements in the renderer by accessibility role + name + state — no CSS selectors. Filters: role (exact), name_contains, name_exact, visible, enabled, interactive. Returns: { ok, matches: [{ ref, role, name, bbox }], count, renderer_reloaded }. A ref may be null for non-interactive landmarks. Errors: NOT_RUNNING (no session — call electron_launch first; not retryable), BAD_ARGUMENT (multiple sessions live — pass sessionId).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |
| `role` | string | no | Accessibility role to match exactly (e.g. "button"). |
| `name_contains` | string | no | Substring the accessible name must contain. |
| `name_exact` | string | no | Exact accessible name to match. |
| `visible` | boolean | no | Restrict to visible (or hidden) elements. |
| `enabled` | boolean | no | Restrict to enabled (or disabled) elements. |
| `interactive` | boolean | no | Restrict to interactive (or non-interactive) elements. |

### `electron_focused_element`

**Get the focused element**

Return the element that currently has focus as { ref, role, name }, or focused: null when nothing (or only the body) is focused. Useful after a Tab press or to confirm focus moved. Returns: { ok, session_id, focused }. Errors: TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (multiple sessions).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_get_attribute`

**Get an element attribute**

Return the value of attribute `name` on the element identified by ref or selector (null when the attribute is absent — that is not an error). Returns: { ok, session_id, value }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `name` | string | yes | Attribute name, e.g. "href" or "aria-label". |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_get_bbox`

**Get an element’s bounding box**

Return the bounding box (CSS pixels) of the element identified by ref or selector. Returns: { ok, session_id, bbox: { x, y, w, h } }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_get_computed_style`

**Get computed CSS properties**

Return the computed value of each requested CSS property (kebab-case, e.g. "background-color") for the element identified by ref or selector (max 50 properties). Only the requested properties are returned, never the full declaration. Returns: { ok, session_id, style: { <prop>: <value> } }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `properties` | string[] | yes | CSS properties to read, kebab-case (e.g. ["display", "background-color"]). Max 50. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_get_state`

**Get an element’s full state**

Return the full state envelope of the element identified by ref or selector: { visible, enabled, disabled, checked, selected, expanded, pressed, focused, readonly, required, invalid, busy } plus its role and name. One call answers "is this clickable / checked / focused". Returns: { ok, session_id, ref, role, name, state }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_get_text`

**Get an element’s text**

Return the text of the element identified by ref or selector: its trimmed textContent, or — when that is empty — the accessible label that electron_find matches on (aria-labelledby/aria-label, native labels, alt, title, placeholder), so a find-by-name then get_text chain works on labelled controls. Returns: { ok, session_id, text }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (no such element; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_get_value`

**Get a form control’s value**

Return the .value of the input/textarea/select identified by ref or selector (null if the element has no value). Returns: { ok, session_id, value }. Errors: REF_NOT_FOUND / SELECTOR_NO_MATCH (carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT.

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_info`

**Electron app info**

Report the running Electron app environment: runtime versions (electron/node/chrome/v8), app name/version/paths, packaged flag, code-signature status (verified for packaged macOS apps; "unknown" for unpackaged/dev apps, "unsupported" off macOS), the active transport, and its capability matrix. Pass sessionId to target a specific session when several are running. Returns: { ok, session_id, transport, versions, app, signature, capabilities }. Errors: NOT_RUNNING (no session — call electron_launch first; not retryable), BAD_ARGUMENT (multiple sessions live — pass sessionId; not retryable).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_snapshot`

**Snapshot renderer accessibility tree**

Capture the renderer accessibility tree: interactive elements (and landmarks) with role, name, state, bbox, and a stable ref. Pass since:"last" for only what changed since the previous snapshot (added/removed/changed + ref_map), interactiveOnly to drop landmarks, maxEntries to cap. Diffs default to a compact encoding (changed fields only; diffFormat:"full" restores complete prev/curr entries) and accept budgetTokens for server-side truncation that keeps interactive entries first. Each response carries renderer_reloaded so stale refs are detectable (P10). Refs are tagged on the DOM (data-sw-ref) so later interaction tools can act by ref. Closed shadow roots are opaque unless the app opts in: push each root onto window.__stagewright_closedShadowRoots at attachShadow time (or implement window.__stagewright_inspectShadow); their entries carry state.shadow_closed: true. Returns: { ok, kind: "full" | "diff", snapshot?, diff?, diff_format?, renderer_reloaded, truncated }. Errors: NOT_RUNNING (no session — call electron_launch first; not retryable), BAD_ARGUMENT (multiple sessions live — pass sessionId).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |
| `since` | string | no | Return only the delta since the previous snapshot for this session. |
| `interactiveOnly` | boolean | no | Return only interactive elements (drops landmarks) to save tokens. |
| `maxEntries` | integer | no | Cap the number of entries returned. Defaults to 2000. |
| `diffFormat` | string | no | Encoding for since:'last' diffs. 'compact' (default) carries only the changed fields per entry; 'full' carries complete prev/curr entries. |
| `budgetTokens` | integer | no | Server-side token cap for a since:'last' diff payload. Lowest-value entries (non-interactive removed/changed first) are dropped until the estimate fits; _meta.truncated_entries reports how many were omitted. |

### `electron_wait`

**Wait a fixed duration**

Pause for ms milliseconds (clamped to 60000). Prefer electron_wait_for_state or electron_wait_for_selector — a fixed wait is slower and more brittle than waiting on a condition. Returns: { ok, session_id, waited_ms }. Errors: NOT_RUNNING (no session), BAD_ARGUMENT (multiple sessions).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ms` | integer | yes | Milliseconds to wait (clamped to the max). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_wait_for_event`

**Wait for a DOM event**

Wait until a named DOM event (e.g. "transitionend", "load", a custom event) fires on the element identified by ref or selector — or on document when neither is given. Returns: { ok, session_id, fired, event }. Errors: WAIT_TIMEOUT (event did not fire within timeoutMs; retryable), SELECTOR_NO_MATCH (target element not present), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, or ref+selector both).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `eventName` | string | yes | DOM event name to wait for, e.g. "transitionend". |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `timeoutMs` | integer | no | Max wait in ms (default 5000, clamped to 60000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_wait_for_selector`

**Wait for a selector state**

Wait until the element identified by ref or selector reaches state: attached (in the DOM), visible (laid out + not visibility:hidden), hidden (absent or not visible), or detached (removed). Default state: visible. For an intentionally offscreen / aria-hidden element (e.g. a code editor's hidden textarea like Monaco), wait for state:'attached' — state:'visible' will time out because the element is never laid out. Returns: { ok, session_id, matched, state }. Errors: WAIT_TIMEOUT (condition not met within timeoutMs; retryable — for offscreen editor inputs use state:'attached'), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `state` | string | yes | Target state to wait for. Default visible. |
| `timeoutMs` | integer | no | Max wait in ms (default 5000, clamped to 60000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

### `electron_wait_for_state`

**Wait for an element state**

Wait until the element identified by ref or selector matches the given state flags (any of visible, enabled, disabled, checked, selected, expanded, pressed, focused, readonly, required, invalid, busy), evaluated atomically. Returns: { ok, session_id, matched, state }. Errors: WAIT_TIMEOUT (state not reached within timeoutMs — details.last_state shows the last observed state; retryable), REF_NOT_FOUND (stale ref; carries similar_refs), TRANSPORT_UNSUPPORTED, NOT_RUNNING, BAD_ARGUMENT (invalid selector, no state flags, or ref+selector both/neither).

- Operation: `query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `state` | object | yes |  |
| `timeoutMs` | integer | no | Max wait in ms (default 5000, clamped to 60000). |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

## Screenshot tools

### `electron_screenshot`

**Capture a screenshot**

Capture a screenshot to an image file and return its path (the image is written on the server host; the bytes are NOT returned inline). With ref/selector, captures just that element; otherwise the targeted window (windowId > windowTitle > windowIndex, default the active window) with optional fullPage or clip. Options: format (png|jpeg), quality (jpeg), path (absolute file) or dir (absolute directory, generated filename). With neither, writes to the server --screenshot-dir if configured, else the OS temp dir — pass dir or set --screenshot-dir for a stable, retrievable artifact location. Returns: { ok, session_id, path, bytes, format, width?, height? } (path is the absolute file written). Errors: ABSOLUTE_PATH_REQUIRED (relative path), REF_NOT_FOUND (no such window), SELECTOR_NO_MATCH (element not found), NOT_RUNNING, BAD_ARGUMENT (invalid selector/options).

- Operation: `screenshot`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `ref` | integer | no | Element ref from a snapshot (resolves to [data-sw-ref="N"]). Provide ref OR selector. |
| `selector` | string | no | CSS selector. Provide ref OR selector, not both. |
| `fullPage` | boolean | no | Capture the full scrollable page (window capture only). |
| `clip` | object | no | Explicit capture rectangle in CSS pixels (window capture only). |
| `format` | string | yes | Image format. Default png. |
| `quality` | integer | no | JPEG quality 0-100 (jpeg only). |
| `path` | string | no | Absolute output file path. Takes precedence over dir / the server default. |
| `dir` | string | no | Absolute output DIRECTORY; the filename is generated. Use this (or the server --screenshot-dir default) for a stable, per-session artifact location instead of the OS temp dir. Mutually exclusive with path. |
| `windowId` | string | no | Target window transport id (highest precedence). |
| `windowTitle` | string | no | Target window by exact title. |
| `windowIndex` | integer | no | Target window by 0-based index. |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |

## Window_info tools

### `electron_windows_list`

**List Electron windows**

List the app windows with their id, index, title, url, and visibility. Pass sessionId to target a specific session. Returns: { ok, session_id, windows, count }. Errors: NOT_RUNNING (no such session; not retryable), BAD_ARGUMENT (multiple sessions — pass sessionId).

- Operation: `window_info`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | string | no | Target session id. Omit when a single session is running. |
