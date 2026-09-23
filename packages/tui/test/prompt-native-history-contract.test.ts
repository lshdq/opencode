import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { bindPromptUndo } from "../src/component/prompt/undo"
import { nativeHistoryCases, prepareNativeHistoryCase } from "./fixture/native-history-contract"

// Keep the oracle separate so a binder failure cannot hide dependency evidence.
for (const bound of [false, true]) {
  test.each(nativeHistoryCases)(`${bound ? "bound" : "raw"} native history contract: $name`, async (item) => {
    const app = await createTestRenderer({ width: 80, height: 10, useThread: false })
    const input = new TextareaRenderable(app.renderer, { id: "native-contract" })
    app.renderer.root.add(input)
    input.focus()
    const metadata = { value: "setup" }
    const dispose = bound ? bindPromptUndo(input, () => metadata.value, (value) => { metadata.value = value }) : () => {}
    const label = "[Pasted ~3 lines] "
    const mark = () => input.extmarks.create({ start: 0, end: label.length - 1, virtual: true })
    try {
      input.insertText(label)
      mark()
      input.editorView.setSelection(0, label.length)
      input.editorView.deleteSelectedText()
      input.clearSelection()
      if (!item.empty) {
        input.insertText(label)
        mark()
        if (item.tail) input.insertText(item.tail)
      }
      const base = (item.empty ? 2 : 3) + (!item.empty && item.tail ? 1 : 0)
      input.insertText("~")
      input.undo()
      prepareNativeHistoryCase(input, item, item.empty ? 0 : label.length)
      metadata.value = "before"
      const before = input.plainText
      const cursor = input.editBuffer.getCursorPosition()
      item.act(input, item.empty ? 0 : label.length)
      const count = !bound ? item.steps
        : item.name === "range unequal invalid" ? 0
        : item.name.startsWith("forward") && item.name !== "forward repeated EOF" ? 1
        : item.steps
      if (!item.reset) expect(input.editBuffer.canRedo()).toBe(count === 0)
      const expected = item.reset ? (!bound && item.reset === "clear" ? base : 0) : base + count
      metadata.value = "after"
      const steps: string[] = []
      while (input.editBuffer.canUndo() && steps.length <= expected + 2) {
        expect(input.editBuffer.undo()).not.toBeNull()
        steps.push(input.plainText)
        if (bound && steps.length <= count) expect(metadata.value).toBe("before")
        if (bound && steps.length === count && !item.reset) {
          expect(input.plainText).toBe(before)
          expect(input.editBuffer.getCursorPosition()).toEqual(cursor)
        }
      }
      expect({ bound, steps: steps.length }).toEqual({ bound, steps: expected })
      expect(input.editBuffer.undo()).toBeNull()
    } finally {
      dispose()
      app.renderer.destroy()
    }
  })
}
