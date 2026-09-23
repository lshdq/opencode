import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { Selection } from "../src/util/selection"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

test("real Prompt expands compact paste on cut and retains metadata through undo/redo", async () => {
  await using state = await tmpdir()
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  await using app = await createAppFixture({
    state: state.path,
    args: { auto: true },
    config: { animations: false, prompt: { paste: "compact" } },
    fetch: async (url) => {
      if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model") return json({ location, data: [{ id: "model", providerID: "demo", name: "Model", variants: [], cost: [], time: { released: 0 } }] })
    },
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Model") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  expect(app.captureCharFrame()).toContain("Build auto")
  app.mockInput.pressKey("F4")
  await app.waitForFrame((frame) => frame.includes("Build") && !frame.includes("Build auto"))
  app.mockInput.pressKey("F4")
  await app.waitForFrame((frame) => frame.includes("Build auto"))
  const input = app.renderer.currentFocusedEditor
  if (!(input instanceof TextareaRenderable)) throw new Error("Prompt textarea missing")
  await app.mockInput.typeText("keep selection")
  app.mockInput.pressKey("a", { ctrl: true, shift: true })
  await app.renderOnce()
  expect(input.getSelectedText()).toBe("keep selection")
  expect(app.captureCharFrame()).toContain("Build auto")
  input.clear()
  const pasted = Array.from({ length: 30 }, (_, index) => `line ${index}: 中文 paste`).join("\n")
  await app.mockInput.pasteBracketedText(pasted)
  await app.waitFor(() => input.plainText.includes("[Pasted"))
  const placeholder = input.plainText
  expect(placeholder).not.toContain("line 0")
  const writes: string[] = []
  const errors: unknown[] = []
  const clipboard = { read: async () => undefined, write: async (text: string) => { writes.push(text) } }
  const toast = { show() {}, error: (error: unknown) => errors.push(error) }
  input.selectAll()
  await app.renderOnce()
  expect(Selection.cut(app.renderer, toast, clipboard)).toBe(true)
  await app.waitFor(() => input.plainText === "")
  expect(writes).toEqual([`${pasted} `])
  app.mockInput.pressKey("z", { ctrl: true })
  await app.waitFor(() => input.plainText === placeholder)
  // Redo and a second undo must preserve the same payload, not just its visible label.
  input.redo()
  await app.waitFor(() => input.plainText === "")
  app.mockInput.pressKey("z", { ctrl: true })
  await app.waitFor(() => input.plainText === placeholder)
  input.selectAll()
  await app.renderOnce()
  expect(Selection.cut(app.renderer, toast, clipboard)).toBe(true)
  await app.waitFor(() => input.plainText === "")
  expect(writes).toEqual([`${pasted} `, `${pasted} `])
  expect(errors).toEqual([])
})
