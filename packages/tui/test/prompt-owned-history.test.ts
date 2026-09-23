import { expect, test } from "bun:test"
import { EditBuffer, resolveRenderLib, TextareaRenderable, type ExtmarksController, type WidthMethod } from "@opentui/core"
import { createTestRenderer, setRendererCapabilities } from "@opentui/core/testing"
import { bindPromptUndo, PROMPT_UNDO_BYTES, PROMPT_UNDO_LIMIT } from "../src/component/prompt/undo"

async function fixture(text = "abcdefghij\nx\nabcdefghij", width = 80, widthMethod: WidthMethod = "unicode") {
  const app = await createTestRenderer({ width, height: 10, useThread: false })
  setRendererCapabilities(app.renderer, { unicode: widthMethod })
  expect(app.renderer.widthMethod).toBe(widthMethod)
  const input = new TextareaRenderable(app.renderer, { id: "owned-history", initialValue: text, width, height: 8 })
  app.renderer.root.add(input)
  input.focus()
  const metadata = { payload: "before" }
  const dispose = bindPromptUndo(input, () => ({ ...metadata }), (snapshot) => { metadata.payload = snapshot.payload })
  await app.renderOnce()
  return { ...app, input, metadata, [Symbol.dispose]() { dispose(); app.renderer.destroy() } }
}

test.each([false, true])("owned undo restores caret and vertical desired column (visual=%s)", async (visual) => {
  using app = await fixture()
  const buffer = app.input.editBuffer
  buffer.setCursor(0, 8)
  const down = () => visual ? app.input.editorView.moveDownVisual() : buffer.moveCursorDown()
  down()
  expect(buffer.getCursorPosition()).toMatchObject({ row: 1, col: 1 })
  buffer.insertText("!")
  buffer.undo()
  expect(buffer.getCursorPosition()).toMatchObject({ row: 1, col: 1 })
  down()
  expect(buffer.getCursorPosition()).toMatchObject({ row: 2, col: 8 })
  buffer.redo()
  expect(app.input.plainText).toBe("abcdefghij\nx!\nabcdefghij")
  expect(buffer.getCursorPosition()).toMatchObject({ row: 1, col: 2 })
})

test.each([false, true])("explicit cursor reposition breaks a vertical run (visual=%s)", async (visual) => {
  using app = await fixture()
  const buffer = app.input.editBuffer
  buffer.setCursor(0, 8)
  if (visual) app.input.editorView.moveDownVisual()
  else buffer.moveCursorDown()
  // Even repositioning at the same coordinates resets native desired-column.
  buffer.setCursor(1, 1)
  buffer.insertText("!")
  buffer.undo()
  if (visual) app.input.editorView.moveDownVisual()
  else buffer.moveCursorDown()
  expect(buffer.getCursorPosition()).toMatchObject({ row: 2, col: 1 })
})

test("soft-wrapped vertical navigation retains the visual desired column through undo", async () => {
  using app = await fixture("abcdefghijabcdefghij\nx\nabcdefghijabcdefghij", 10)
  app.input.editBuffer.setCursor(0, 18)
  app.input.editorView.moveDownVisual()
  expect(app.input.logicalCursor).toMatchObject({ row: 1, col: 1 })
  app.input.insertText("!")
  app.input.undo()
  expect(app.input.logicalCursor).toMatchObject({ row: 1, col: 1 })
  app.input.editorView.moveDownVisual()
  expect(app.input.logicalCursor).toMatchObject({ row: 2, col: 8 })
})

test("selection replacement retains two logical edits, clears stale selection and restores caret", async () => {
  using app = await fixture("one two three")
  app.input.editBuffer.setCursor(0, 7)
  app.input.setSelection(4, 7)
  app.input.insertText("X")
  expect(app.input.plainText).toBe("one X three")
  app.input.undo()
  expect(app.input.plainText).toBe("one  three")
  app.input.undo()
  expect(app.input.plainText).toBe("one two three")
  expect(app.input.logicalCursor).toMatchObject({ row: 0, col: 7 })
  expect(app.input.hasSelection()).toBe(false)
  app.input.redo()
  app.input.redo()
  expect(app.input.plainText).toBe("one X three")
  expect(app.input.logicalCursor).toMatchObject({ row: 0, col: 5 })
})

test("native and extmark histories stay empty across edits, undo, redo, reset and disposal", async () => {
  using app = await fixture("seed")
  const marks = app.input.extmarks as ExtmarksController
  for (let index = 0; index < 20; index++) {
    app.input.editBuffer.replaceText("seed")
    app.input.editBuffer.insertText("x")
    app.input.undo()
    app.input.redo()
    expect(EditBuffer.prototype.canUndo.call(app.input.editBuffer)).toBe(false)
    expect(EditBuffer.prototype.canRedo.call(app.input.editBuffer)).toBe(false)
    expect(marks["history"].canUndo()).toBe(false)
    expect(marks["history"].canRedo()).toBe(false)
  }
  app.input.editBuffer.clear()
  expect(app.input.editBuffer.undo()).toBeNull()
  expect(app.input.editBuffer.redo()).toBeNull()
})

test("byte budget evicts a contiguous oldest window; redo and branching remain correct", async () => {
  const base = "a".repeat(256 * 1024)
  using app = await fixture(base)
  app.input.gotoBufferEnd()
  for (let index = 0; index < 80; index++) app.input.editBuffer.insertText("x")
  let count = 0
  while (app.input.editBuffer.canUndo()) {
    expect(app.input.editBuffer.undo()).not.toBeNull()
    count++
    expect(app.input.plainText).toBe(base + "x".repeat(80 - count))
  }
  expect(count).toBeGreaterThan(10)
  expect(count).toBeLessThan(80)
  expect(app.input.editBuffer.undo()).toBeNull()
  for (let index = 0; index < count; index++) expect(app.input.editBuffer.redo()).not.toBeNull()
  expect(app.input.plainText).toBe(base + "x".repeat(80))
  app.input.undo()
  app.input.insertText("branch")
  expect(app.input.editBuffer.canRedo()).toBe(false)
  app.input.undo()
  expect(app.input.plainText).toBe(base + "x".repeat(79))
}, 30000)

test("shared 1 MiB metadata does not multiply by 256; oversized payload establishes a history boundary", async () => {
  using app = await fixture("")
  app.metadata.payload = "p".repeat(1024 * 1024)
  for (let index = 0; index < PROMPT_UNDO_LIMIT; index++) app.input.insertText("x")
  for (let index = 0; index < PROMPT_UNDO_LIMIT; index++) expect(app.input.editBuffer.undo()).not.toBeNull()
  expect(app.input.plainText).toBe("")
  expect(app.metadata.payload).toHaveLength(1024 * 1024)
  app.metadata.payload = "q".repeat(PROMPT_UNDO_BYTES)
  app.input.insertText("oversized")
  expect(app.input.editBuffer.canUndo()).toBe(false)
  expect(app.input.editBuffer.canRedo()).toBe(false)
  app.input.editBuffer.clear()
  app.metadata.payload = "fresh"
  app.input.insertText("new")
  app.input.undo()
  expect(app.input.plainText).toBe("")
  expect(app.metadata.payload).toBe("fresh")
}, 30000)

test("history restores complete text beyond OpenTUI getText's 1 MiB cap", async () => {
  const base = "a".repeat(1024 * 1024 + 10)
  using app = await fixture(base)
  app.input.gotoBufferEnd()
  app.input.insertText("END")
  app.input.undo()
  const lib = resolveRenderLib()
  expect(lib.decoder.decode(lib.editBufferGetText(app.input.editBuffer.ptr, base.length + 100)!)).toBe(base)
  app.input.redo()
  expect(lib.decoder.decode(lib.editBufferGetText(app.input.editBuffer.ptr, base.length + 100)!)).toBe(base + "END")
  expect(app.input.logicalCursor.col).toBe(base.length + 3)
}, 30000)

test.each(["wcwidth", "unicode", "unicode-wide"] as const)("owned history preserves text/caret across zero and wide units (%s)", async (widthMethod) => {
  for (const text of ["中x", "👩‍💻x", "\tx", "\u0301x", "A\u0001B"]) {
    using app = await fixture(text, 20, widthMethod)
    app.input.editBuffer.setCursor(0, 1)
    const caret = app.input.logicalCursor
    app.input.editBuffer.deleteChar()
    const after = app.input.plainText
    const end = app.input.logicalCursor
    for (let index = 0; index < 3; index++) {
      expect(app.input.editBuffer.undo()).not.toBeNull()
      expect(app.input.plainText).toBe(text)
      expect(app.input.logicalCursor).toEqual(caret)
      expect(app.input.editBuffer.redo()).not.toBeNull()
      expect(app.input.plainText).toBe(after)
      expect(app.input.logicalCursor).toEqual(end)
    }
  }
})

test("cleanup is safe after renderer destruction and restores controller methods", async () => {
  const app = await createTestRenderer({ width: 80, height: 10, useThread: false })
  const input = new TextareaRenderable(app.renderer, { id: "destroyed-history" })
  app.renderer.root.add(input)
  const marks = input.extmarks as ExtmarksController
  const save = marks["saveSnapshot"]
  const dispose = bindPromptUndo(input, () => "payload", () => {})
  input.insertText("draft")
  app.renderer.destroy()
  expect(dispose).not.toThrow()
  expect(marks["saveSnapshot"]).toBe(save)
})
