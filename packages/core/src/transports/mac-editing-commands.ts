/**
 * macOS editing commands for synthesized key events.
 *
 * On macOS, Chromium turns key chords into editing actions through the native
 * `NSResponder` key bindings and the app menu, neither of which sees a key event
 * synthesized with `Input.dispatchKeyEvent`. The renderer only performs the
 * action when the event carries the command names in `commands`, so without
 * this table Meta+A, Meta+C/V/X, Meta+Z, Alt+Backspace and friends do nothing
 * in a text field over CDP.
 *
 * The table mirrors the one Playwright's Chromium driver uses, limited to the
 * keys the CDP chord parser emits. `insert*` commands are left out: text
 * insertion travels in the event's `text`, and adding them would insert twice.
 *
 * @module
 */

/** Keyed by `[Shift+][Control+][Alt+][Meta+]<code>`, in that modifier order. */
const MAC_EDITING_COMMANDS: Readonly<Record<string, string | readonly string[]>> = {
  Backspace: 'deleteBackward',
  Escape: 'cancelOperation',
  ArrowUp: 'moveUp',
  ArrowDown: 'moveDown',
  ArrowLeft: 'moveLeft',
  ArrowRight: 'moveRight',
  Delete: 'deleteForward',
  Home: 'scrollToBeginningOfDocument',
  End: 'scrollToEndOfDocument',
  PageUp: 'scrollPageUp',
  PageDown: 'scrollPageDown',
  'Shift+Backspace': 'deleteBackward',
  'Shift+Escape': 'cancelOperation',
  'Shift+ArrowUp': 'moveUpAndModifySelection',
  'Shift+ArrowDown': 'moveDownAndModifySelection',
  'Shift+ArrowLeft': 'moveLeftAndModifySelection',
  'Shift+ArrowRight': 'moveRightAndModifySelection',
  'Shift+Delete': 'deleteForward',
  'Shift+Home': 'moveToBeginningOfDocumentAndModifySelection',
  'Shift+End': 'moveToEndOfDocumentAndModifySelection',
  'Shift+PageUp': 'pageUpAndModifySelection',
  'Shift+PageDown': 'pageDownAndModifySelection',
  'Control+Tab': 'selectNextKeyView',
  'Control+KeyA': 'moveToBeginningOfParagraph',
  'Control+KeyB': 'moveBackward',
  'Control+KeyD': 'deleteForward',
  'Control+KeyE': 'moveToEndOfParagraph',
  'Control+KeyF': 'moveForward',
  'Control+KeyH': 'deleteBackward',
  'Control+KeyK': 'deleteToEndOfParagraph',
  'Control+KeyL': 'centerSelectionInVisibleArea',
  'Control+KeyN': 'moveDown',
  'Control+KeyO': 'moveBackward',
  'Control+KeyP': 'moveUp',
  'Control+KeyT': 'transpose',
  'Control+KeyV': 'pageDown',
  'Control+KeyY': 'yank',
  'Control+Backspace': 'deleteBackwardByDecomposingPreviousCharacter',
  'Control+ArrowUp': 'scrollPageUp',
  'Control+ArrowDown': 'scrollPageDown',
  'Control+ArrowLeft': 'moveToLeftEndOfLine',
  'Control+ArrowRight': 'moveToRightEndOfLine',
  'Shift+Control+Tab': 'selectPreviousKeyView',
  'Shift+Control+KeyA': 'moveToBeginningOfParagraphAndModifySelection',
  'Shift+Control+KeyB': 'moveBackwardAndModifySelection',
  'Shift+Control+KeyE': 'moveToEndOfParagraphAndModifySelection',
  'Shift+Control+KeyF': 'moveForwardAndModifySelection',
  'Shift+Control+KeyN': 'moveDownAndModifySelection',
  'Shift+Control+KeyP': 'moveUpAndModifySelection',
  'Shift+Control+KeyV': 'pageDownAndModifySelection',
  'Shift+Control+Backspace': 'deleteBackwardByDecomposingPreviousCharacter',
  'Shift+Control+ArrowUp': 'scrollPageUp',
  'Shift+Control+ArrowDown': 'scrollPageDown',
  'Shift+Control+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection',
  'Shift+Control+ArrowRight': 'moveToRightEndOfLineAndModifySelection',
  'Alt+Backspace': 'deleteWordBackward',
  'Alt+Escape': 'complete',
  'Alt+ArrowUp': ['moveBackward', 'moveToBeginningOfParagraph'],
  'Alt+ArrowDown': ['moveForward', 'moveToEndOfParagraph'],
  'Alt+ArrowLeft': 'moveWordLeft',
  'Alt+ArrowRight': 'moveWordRight',
  'Alt+Delete': 'deleteWordForward',
  'Alt+PageUp': 'pageUp',
  'Alt+PageDown': 'pageDown',
  'Shift+Alt+Backspace': 'deleteWordBackward',
  'Shift+Alt+Escape': 'complete',
  'Shift+Alt+ArrowUp': 'moveParagraphBackwardAndModifySelection',
  'Shift+Alt+ArrowDown': 'moveParagraphForwardAndModifySelection',
  'Shift+Alt+ArrowLeft': 'moveWordLeftAndModifySelection',
  'Shift+Alt+ArrowRight': 'moveWordRightAndModifySelection',
  'Shift+Alt+Delete': 'deleteWordForward',
  'Shift+Alt+PageUp': 'pageUp',
  'Shift+Alt+PageDown': 'pageDown',
  'Control+Alt+KeyB': 'moveWordBackward',
  'Control+Alt+KeyF': 'moveWordForward',
  'Control+Alt+Backspace': 'deleteWordBackward',
  'Shift+Control+Alt+KeyB': 'moveWordBackwardAndModifySelection',
  'Shift+Control+Alt+KeyF': 'moveWordForwardAndModifySelection',
  'Shift+Control+Alt+Backspace': 'deleteWordBackward',
  'Meta+Backspace': 'deleteToBeginningOfLine',
  'Meta+ArrowUp': 'moveToBeginningOfDocument',
  'Meta+ArrowDown': 'moveToEndOfDocument',
  'Meta+ArrowLeft': 'moveToLeftEndOfLine',
  'Meta+ArrowRight': 'moveToRightEndOfLine',
  'Shift+Meta+Backspace': 'deleteToBeginningOfLine',
  'Shift+Meta+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection',
  'Shift+Meta+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
  'Shift+Meta+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection',
  'Shift+Meta+ArrowRight': 'moveToRightEndOfLineAndModifySelection',
  'Meta+KeyA': 'selectAll',
  'Meta+KeyC': 'copy',
  'Meta+KeyX': 'cut',
  'Meta+KeyV': 'paste',
  'Meta+KeyZ': 'undo',
  'Shift+Meta+KeyZ': 'redo',
}

/** CDP modifier bits in the table's key order. */
const MODIFIER_ORDER: readonly (readonly [number, string])[] = [
  [8, 'Shift'],
  [2, 'Control'],
  [1, 'Alt'],
  [4, 'Meta'],
]

/** Chromium editing commands for a key `code` and CDP modifier mask, or `[]` when none apply. */
export function macEditingCommands(code: string, modifiers: number): readonly string[] {
  if (code === '') return []
  const parts = MODIFIER_ORDER.filter(([bit]) => (modifiers & bit) !== 0).map(([, name]) => name)
  const commands = MAC_EDITING_COMMANDS[[...parts, code].join('+')]
  if (commands === undefined) return []
  return typeof commands === 'string' ? [commands] : commands
}
