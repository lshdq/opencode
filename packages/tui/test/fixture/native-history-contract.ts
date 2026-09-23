import type { TextareaRenderable } from "@opentui/core"

// Expectations are from OpenTUI v0.5.10's Zig checkpoints, NOT the binder.
// See src/component/prompt/原生撤销契约.md before changing these values.
export type NativeHistoryCase = {
  name: string
  tail?: string
  empty?: boolean
  at?: number | "start" | "end" | { row: number; col: number }
  select?: (input: TextareaRenderable, prefix: number) => void
  act: (input: TextareaRenderable, prefix: number) => void
  steps: number
  reset?: "native" | "clear" | "history"
}

export const nativeHistoryCases: NativeHistoryCase[] = [
  { name: "insertChar empty", act: (r) => r.editBuffer.insertChar(""), steps: 0 },
  { name: "insertChar ascii", act: (r) => r.editBuffer.insertChar("x"), steps: 1 },
  { name: "insertChar control", act: (r) => r.editBuffer.insertChar("\u0001"), steps: 1 },
  { name: "insertText empty", act: (r) => r.editBuffer.insertText(""), steps: 0 },
  { name: "insertText multiline", act: (r) => r.editBuffer.insertText("x\n中\ny"), steps: 1 },
  { name: "insertText zero-width", act: (r) => r.editBuffer.insertText("\u0301"), steps: 1 },
  { name: "forward EOF", act: (r) => r.editBuffer.deleteChar(), steps: 1 },
  { name: "forward empty", empty: true, act: (r) => r.editBuffer.deleteChar(), steps: 1 },
  { name: "forward repeated EOF", act: (r) => { r.editBuffer.deleteChar(); r.editBuffer.deleteChar(); r.editBuffer.deleteChar() }, steps: 3 },
  { name: "forward character", tail: "xy", at: 0, act: (r) => r.editBuffer.deleteChar(), steps: 2 },
  { name: "forward newline", tail: "\nx", at: 0, act: (r) => r.editBuffer.deleteChar(), steps: 2 },
  { name: "forward empty line", tail: "\n\nx", at: { row: 1, col: 0 }, act: (r) => r.editBuffer.deleteChar(), steps: 2 },
  { name: "forward wide interior", tail: "中x", at: 1, act: (r) => r.editBuffer.deleteChar(), steps: 2 },
  { name: "forward emoji interior", tail: "👩‍💻x", at: 1, act: (r) => r.editBuffer.deleteChar(), steps: 2 },
  { name: "forward tab interior", tail: "\tx", at: 1, act: (r) => r.editBuffer.deleteChar(), steps: 2 },
  { name: "forward leading combining", tail: "\u0301x", at: 0, act: (r) => r.editBuffer.deleteChar(), steps: 1 },
  { name: "forward leading control", tail: "\u0001x", at: 0, act: (r) => r.editBuffer.deleteChar(), steps: 1 },
  { name: "forward virtual mark", at: "start", act: (r) => r.editBuffer.deleteChar(), steps: 1 },
  { name: "forward buffer with selection", at: "start", select: (r) => r.editorView.setSelection(0, 1), act: (r) => r.editBuffer.deleteChar(), steps: 2 },
  { name: "backspace BOF", at: "start", act: (r) => r.editBuffer.deleteCharBackward(), steps: 0 },
  { name: "backspace empty", empty: true, act: (r) => r.editBuffer.deleteCharBackward(), steps: 0 },
  { name: "backspace character", tail: "xy", act: (r) => r.editBuffer.deleteCharBackward(), steps: 1 },
  { name: "backspace newline", tail: "\nx", at: { row: 1, col: 0 }, act: (r) => r.editBuffer.deleteCharBackward(), steps: 1 },
  { name: "backspace wide interior", tail: "中x", at: 1, act: (r) => r.editBuffer.deleteCharBackward(), steps: 1 },
  { name: "backspace control boundary", tail: "A\u0001B", at: 1, act: (r) => r.editBuffer.deleteCharBackward(), steps: 0 },
  { name: "backspace virtual mark", at: -1, act: (r) => r.editBuffer.deleteCharBackward(), steps: 1 },
  { name: "backspace buffer with selection", select: (r) => r.editorView.setSelection(0, 1), act: (r) => r.editBuffer.deleteCharBackward(), steps: 1 },
  { name: "newline populated", act: (r) => r.editBuffer.newLine(), steps: 1 },
  { name: "newline empty", empty: true, act: (r) => r.editBuffer.newLine(), steps: 1 },
  { name: "deleteLine empty", empty: true, act: (r) => r.editBuffer.deleteLine(), steps: 0 },
  { name: "deleteLine populated", act: (r) => r.editBuffer.deleteLine(), steps: 1 },
  { name: "deleteLine trailing empty", tail: "\n", act: (r) => r.editBuffer.deleteLine(), steps: 1 },
  { name: "deleteLine middle empty", tail: "\n\nx", at: { row: 1, col: 0 }, act: (r) => r.editBuffer.deleteLine(), steps: 1 },
  { name: "deleteLine first of multiple", tail: "\nx", at: "start", act: (r) => r.editBuffer.deleteLine(), steps: 1 },
  { name: "range equal", act: (r) => r.editBuffer.deleteRange(0, 0, 0, 0), steps: 0 },
  { name: "range equal invalid", act: (r) => r.editBuffer.deleteRange(99, 99, 99, 99), steps: 0 },
  { name: "range unequal invalid", act: (r) => r.editBuffer.deleteRange(99, 0, 100, 0), steps: 1 },
  { name: "range fractional equal after u32", act: (r) => r.editBuffer.deleteRange(0.1, 1.1, 0.9, 1.9), steps: 0 },
  { name: "range normal", tail: "xy", act: (r, p) => r.editBuffer.deleteRange(0, p, 0, p + 1), steps: 1 },
  { name: "range reversed", tail: "xy", act: (r, p) => r.editBuffer.deleteRange(0, p + 1, 0, p), steps: 1 },
  { name: "range wide interior", tail: "中x", act: (r, p) => r.editBuffer.deleteRange(0, p + 1, 0, p + 2), steps: 1 },
  { name: "selection absent", act: (r) => { r.editorView.resetSelection(); r.editorView.deleteSelectedText() }, steps: 0 },
  { name: "selection collapsed", select: (r) => r.editorView.setSelection(0, 0), act: (r) => r.editorView.deleteSelectedText(), steps: 0 },
  { name: "selection normal", tail: "xy", select: (r, p) => r.editorView.setSelection(p, p + 1), act: (r) => r.editorView.deleteSelectedText(), steps: 1 },
  { name: "selection reversed", tail: "xy", select: (r, p) => r.editorView.setSelection(p + 1, p), act: (r) => r.editorView.deleteSelectedText(), steps: 1 },
  { name: "selection out of range", select: (r) => r.editorView.setSelection(999, 1000), act: (r) => r.editorView.deleteSelectedText(), steps: 0 },
  { name: "replaceText same", act: (r) => r.editBuffer.replaceText(r.plainText), steps: 1 },
  { name: "replaceText empty", act: (r) => r.editBuffer.replaceText(""), steps: 1 },
  { name: "replaceTextOwned same", act: (r) => r.editBuffer.replaceTextOwned(r.plainText), steps: 1 },
  { name: "replaceTextOwned empty", act: (r) => r.editBuffer.replaceTextOwned(""), steps: 1 },
  { name: "setText same", act: (r) => r.editBuffer.setText(r.plainText), steps: 0, reset: "native" },
  { name: "setTextOwned same", act: (r) => r.editBuffer.setTextOwned(r.plainText), steps: 0, reset: "native" },
  { name: "clear", act: (r) => r.editBuffer.clear(), steps: 0, reset: "clear" },
  { name: "clearHistory", act: (r) => r.editBuffer.clearHistory(), steps: 0, reset: "history" },
]

export function prepareNativeHistoryCase(input: TextareaRenderable, item: NativeHistoryCase, prefix: number) {
  input.clearSelection()
  if (item.at === "start") input.editBuffer.setCursor(0, 0)
  else if (typeof item.at === "number") input.editBuffer.setCursor(0, prefix + item.at)
  else if (typeof item.at === "object") input.editBuffer.setCursor(item.at.row, item.at.col)
  else input.gotoBufferEnd()
  item.select?.(input, prefix)
}
