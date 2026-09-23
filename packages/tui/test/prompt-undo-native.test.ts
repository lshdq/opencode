import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { bindPromptUndo, PROMPT_UNDO_LIMIT } from "../src/component/prompt/undo"

async function fixture() {
  const app = await createTestRenderer({ width: 80, height: 10, useThread: false })
  const input = new TextareaRenderable(app.renderer, { id: "native-undo", initialValue: "ab\ncd" })
  app.renderer.root.add(input)
  input.focus()
  const metadata = { value: "before" }
  const dispose = bindPromptUndo(input, () => metadata.value, (value) => { metadata.value = value })
  return { input, metadata, [Symbol.dispose]() { dispose(); app.renderer.destroy() } }
}

const mutations = [
  ["insertChar", (input: TextareaRenderable) => input.editBuffer.insertChar("X")],
  ["insertText", (input: TextareaRenderable) => input.editBuffer.insertText("XYZ")],
  ["deleteChar", (input: TextareaRenderable) => input.editBuffer.deleteChar()],
  ["deleteCharBackward", (input: TextareaRenderable) => input.editBuffer.deleteCharBackward()],
  ["deleteRange", (input: TextareaRenderable) => input.editBuffer.deleteRange(0, 0, 1, 1)],
  ["deleteLine", (input: TextareaRenderable) => input.editBuffer.deleteLine()],
  ["newLine", (input: TextareaRenderable) => input.editBuffer.newLine()],
  ["replaceText", (input: TextareaRenderable) => input.editBuffer.replaceText("other")],
  ["replaceTextOwned", (input: TextareaRenderable) => input.editBuffer.replaceTextOwned("other")],
  ["selection", (input: TextareaRenderable) => { input.editorView.setSelection(0, 2); input.editorView.deleteSelectedText() }],
] as const

test.each(mutations)("native %s shares the exact undo/redo metadata boundary", async (_name, mutate) => {
  using app = await fixture()
  app.input.editBuffer.setCursor(0, 1)
  mutate(app.input)
  const after = app.input.plainText
  app.metadata.value = "after"
  expect(app.input.editBuffer.undo()).not.toBeNull()
  expect(app.input.plainText).toBe("ab\ncd")
  expect(app.metadata.value).toBe("before")
  expect(app.input.editBuffer.redo()).not.toBeNull()
  expect(app.input.plainText).toBe(after)
  expect(app.metadata.value).toBe("after")
})

test("no-op native operations do not shift history, same-text replacement does", async () => {
  using app = await fixture()
  app.input.editBuffer.replaceText("ab\ncd")
  app.metadata.value = "same text, different metadata"
  app.input.editBuffer.setCursor(0, 0)
  app.input.editBuffer.deleteCharBackward()
  app.input.editBuffer.insertText("")
  app.input.editBuffer.deleteRange(0, 0, 0, 0)
  app.input.editorView.resetSelection()
  app.input.editorView.deleteSelectedText()
  expect(app.input.editBuffer.undo()).not.toBeNull()
  expect(app.metadata.value).toBe("before")
  expect(app.input.editBuffer.canUndo()).toBe(false)
  expect(app.input.editBuffer.redo()).not.toBeNull()
  expect(app.metadata.value).toBe("same text, different metadata")
})

test.each(["setText", "setTextOwned", "clear", "clearHistory"] as const)("native %s resets the parallel history", async (operation) => {
  using app = await fixture()
  app.input.editBuffer.insertText("first")
  if (operation === "setText" || operation === "setTextOwned") app.input.editBuffer[operation]("reset")
  else app.input.editBuffer[operation]()
  app.metadata.value = "reset"
  expect(app.input.editBuffer.canUndo()).toBe(false)
  expect(app.input.editBuffer.undo()).toBeNull()
  app.input.editBuffer.insertText("next")
  app.metadata.value = "next"
  app.input.editBuffer.undo()
  expect(app.metadata.value).toBe("reset")
})

test("native editing after undo discards redo without selecting by text", async () => {
  using app = await fixture()
  app.input.editBuffer.replaceText("same")
  app.metadata.value = "A"
  app.input.editBuffer.replaceText("same")
  app.metadata.value = "B"
  app.input.editBuffer.undo()
  expect(app.metadata.value).toBe("A")
  app.input.editBuffer.replaceText("same")
  app.metadata.value = "C"
  expect(app.input.editBuffer.canRedo()).toBe(false)
  expect(app.input.editBuffer.redo()).toBeNull()
  app.input.editBuffer.undo()
  expect(app.metadata.value).toBe("A")
  app.input.editBuffer.undo()
  expect(app.metadata.value).toBe("before")
})

test("metadata history is bounded and native undo cannot cross the retained window", async () => {
  using app = await fixture()
  for (let index = 0; index < PROMPT_UNDO_LIMIT + 5; index++) {
    app.input.editBuffer.insertText("x")
    app.metadata.value = String(index + 1)
  }
  for (let index = 0; index < PROMPT_UNDO_LIMIT; index++) expect(app.input.editBuffer.undo()).not.toBeNull()
  expect(app.metadata.value).toBe("5")
  expect(app.input.editBuffer.canUndo()).toBe(false)
  expect(app.input.editBuffer.undo()).toBeNull()
  for (let index = 0; index < PROMPT_UNDO_LIMIT; index++) expect(app.input.editBuffer.redo()).not.toBeNull()
  expect(app.metadata.value).toBe(String(PROMPT_UNDO_LIMIT + 5))
  expect(app.input.editBuffer.canRedo()).toBe(false)
})
