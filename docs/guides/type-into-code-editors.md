# Type into code editors (Monaco / EditContext)

Typing into a code editor is the one interaction where the obvious approach silently fails. A code
editor — Monaco (including its EditContext mode), CodeMirror, or a plain `contenteditable` region —
renders its text in a `<div>` and keeps a separate hidden input for keystrokes, so typing the way you
type into a form field either does nothing or leaves debris. This guide shows the reliable path and
the editor-specific gotchas, all using tools that already ship.

## Why plain typing fails

If you aim `electron_type` at the editor's hidden `<textarea>`, two things go wrong:

- **Modern EditContext editors ignore it.** Recent Monaco reads input through an `EditContext`, not the
  textarea, so the keystrokes never reach the model. The server detects that the content did not change
  and returns `TYPE_NO_EFFECT` instead of a false `ok` — so the agent is not stranded believing text
  landed when it did not.
- **Auto-pairing corrupts the text.** Real keystrokes trigger the editor's auto-closing of quotes and
  brackets (typing `(` inserts `()`), so source typed character by character gains debris — for example
  a stray trailing `}')`.

```json
electron_type { "selector": ".monaco-editor textarea", "text": "const x = 1" }
```

```json
{
  "ok": false,
  "code": "TYPE_NO_EFFECT",
  "retryable": false,
  "hint": "Typing changed nothing — the target ignored the input (e.g. a code editor's hidden textarea). Use electron_type_into_editor on the editor's content area."
}
```

## The reliable path: `electron_type_into_editor`

Target the editor's **content area** (not the hidden textarea). The server clicks it to focus the
editor, then types the text into the now-focused editor as real keystrokes:

```json
electron_type_into_editor { "selector": ".monaco-editor .view-lines", "text": "const x = 1" }
```

```json
{ "ok": true, "target": ".monaco-editor .view-lines", "typed": 11, "replaced": false }
```

Address the editor by `ref` (from a snapshot) or `selector`. Common content-area selectors:

- Monaco — `.monaco-editor .view-lines`
- CodeMirror 6 — `.cm-content`
- a plain editable region — its `contenteditable` element

## Replace or clear the whole editor

Pass `replace: true` to replace the editor's entire contents. After the focusing click it selects all
(platform-aware `Meta+A` / `Control+A`) and types over the selection — no second click that would
collapse the selection:

```json
electron_type_into_editor { "selector": ".monaco-editor .view-lines", "text": "// new file\nexport const x = 1\n", "replace": true }
```

With **empty text** and `replace: true`, it clears the editor (select-all + Delete):

```json
electron_type_into_editor { "selector": ".monaco-editor .view-lines", "text": "", "replace": true }
```

## The auto-pairing caveat

Even on the reliable path, real keystrokes still pass through the editor's auto-pairing. If you type a
fragment with an unmatched opener, the editor closes it for you and your text ends up with extra
characters. Two ways to avoid debris:

- **Type pairing-safe fragments** — text whose brackets and quotes are already balanced, so auto-pairing
  has nothing to add.
- **Use `replace: true` with the full intended contents** — replacing the whole buffer sidesteps
  incremental auto-pairing for the common "set the file to exactly this" case. This is the safer default
  for anything non-trivial.

## Waiting for the editor

A code editor's input element is often **visually hidden**, so a `visible` wait never resolves. Wait for
the editor to be **attached** to the DOM instead:

```json
electron_wait_for_selector { "selector": ".monaco-editor", "state": "attached" }
```

## Verify the text landed

`electron_type_into_editor` already fails loud (`TYPE_NO_EFFECT`) when nothing changed. To assert the
final content, read the rendered editor text back — the model text lives in the content DOM, not a form
`value`, so use the text tools on the content area:

```json
electron_get_text { "selector": ".monaco-editor .view-lines" }
electron_expect_text { "selector": ".monaco-editor .view-lines", "contains": "export const x = 1" }
```

## Where next

- [`examples/code-editor-shape`](../../examples/code-editor-shape/README.md) — a bundled editor-shaped
  app and the scenario that drives it.
- [Assert UI state](./assert-ui-state.md) — the `expect_*` family and waits in depth.
- [Getting started](./getting-started.md) — the end-to-end driving loop.
- [`TOOL-REFERENCE.md`](../../TOOL-REFERENCE.md) — the full `electron_type_into_editor` contract
  (parameters, return shape, error codes).
