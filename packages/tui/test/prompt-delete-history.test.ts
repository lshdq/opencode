import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { Selection } from "../src/util/selection"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { nativeHistoryCases, prepareNativeHistoryCase } from "./fixture/native-history-contract"

const payload = "AAA1\nAAA2\nAAA3"

test.each([
  { name: "Ctrl+D EOF", deletes: 1, steps: 1, tail: "", branch: false },
  { name: "repeated Ctrl+D EOF", deletes: 3, steps: 3, tail: "", branch: false },
  { name: "Ctrl+D EOF on redo branch", deletes: 1, steps: 1, tail: "", branch: true },
  { name: "forward character is one owned step", deletes: 1, steps: 1, tail: "xy", branch: false },
  { name: "forward newline is one owned step", deletes: 1, steps: 1, tail: "\nx", branch: true },
  ...nativeHistoryCases.map((contract) => ({
    name: `owned matrix ${contract.name}`, deletes: 0, steps: 0, tail: "", branch: false, contract,
  })),
])("R-03 actual Prompt copy and POST: $name", async (item) => {
  await using state = await tmpdir()
  const id = "ses_delete_history"
  takeDraft(id)
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  const submissions: unknown[] = []
  await using app = await createAppFixture({
    state: state.path,
    args: { sessionID: id },
    config: { animations: false, tabs: { mode: "off" }, prompt: { paste: "compact" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent") return json({ location, data: [
        { id: "build", mode: "primary", hidden: false, permissions: [] },
      ] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model") return json({ location, data: [
        { id: "model", providerID: "provider", name: "Delete model", variants: [] },
      ] })
      if (url.pathname === `/api/session/${id}`) return json({ data: {
        id, title: "Delete fixture", projectID: "proj_test", location: { directory },
        agent: "build", model: { providerID: "provider", id: "model" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
      } })
      if (request.method === "GET" && /^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) {
        return json({ data: [], cursor: {} })
      }
      if (request.method === "POST" && url.pathname.endsWith("/model")) return new Response(null, { status: 204 })
      if (request.method === "POST" && url.pathname.endsWith("/prompt")) {
        submissions.push(await request.json())
        return json({ data: {} })
      }
    },
  })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("Delete model") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Prompt missing")
    await app.mockInput.pasteBracketedText(payload)
    await app.waitFor(() => input.plainText.includes("[Pasted ~3 lines]"))
    let expected = `${payload} ${item.tail}`
    if ("contract" in item) {
      const operation = item.contract
      // Each scenario starts with older history and an existing redo branch.
      input.selectAll()
      input.deleteSelection()
      await app.renderOnce()
      if (!operation.empty) {
        await app.mockInput.pasteBracketedText(payload)
        await app.waitFor(() => input.plainText.includes("[Pasted ~3 lines]"))
      }
      const prefix = input.plainText.length
      if (operation.tail) input.insertText(operation.tail)
      input.insertText("!")
      input.undo()
      expect(input.editBuffer.canRedo()).toBe(true)
      prepareNativeHistoryCase(input, operation, prefix)
      const before = input.plainText
      const caret = input.logicalCursor
      operation.act(input, prefix)
      if (operation.reset) {
        expect(input.editBuffer.canUndo()).toBe(false)
        expect(input.editBuffer.canRedo()).toBe(false)
        const retained = operation.reset === "history" ? `${payload} ${operation.tail ?? ""}` : input.plainText
        input.clearSelection()
        input.gotoBufferEnd()
        const previous = input.plainText
        await app.mockInput.pasteBracketedText("BBB1\nBBB2\nBBB3")
        await app.waitFor(() => input.plainText !== previous && input.plainText.includes("[Pasted ~3 lines]"))
        input.undo()
        input.redo()
        expected = `${retained}BBB1\nBBB2\nBBB3 `
      } else {
        const steps = operation.name === "range unequal invalid" ? 0
          : operation.name.startsWith("forward") && operation.name !== "forward repeated EOF" ? 1
          : operation.steps
        const after = input.plainText
        for (let index = 0; index < steps; index++) expect(input.editBuffer.undo()).not.toBeNull()
        expect(input.plainText).toBe(before)
        if (steps) expect(input.logicalCursor).toEqual(caret)
        if (steps) {
          for (let index = 0; index < steps; index++) expect(input.editBuffer.redo()).not.toBeNull()
          expect(input.plainText).toBe(after)
          for (let index = 0; index < steps; index++) expect(input.editBuffer.undo()).not.toBeNull()
        }
        if (operation.empty) {
          // Recover the preceding cut too, proving an empty operation did not
          // consume/misidentify the older paste payload.
          expect(input.editBuffer.undo()).not.toBeNull()
        }
        input.clearSelection()
        input.gotoBufferEnd()
        input.insertText("#")
        expect(input.editBuffer.canRedo()).toBe(false)
        expected = `${payload} ${operation.empty ? "" : operation.tail ?? ""}#`
      }
    }
    const prefix = input.plainText.length
    if (item.tail) input.insertText(item.tail)
    if (item.branch) {
      input.insertText("!")
      input.undo()
      expect(input.editBuffer.canRedo()).toBe(true)
    }
    if (!("contract" in item)) input.editBuffer.setCursor(0, prefix)
    for (let count = 0; count < item.deletes; count++) app.mockInput.pressKey("d", { ctrl: true })
    await app.renderOnce()
    for (let count = 0; count < item.steps; count++) app.mockInput.pressKey("z", { ctrl: true })
    await app.renderOnce()

    const copied: string[] = []
    input.selectAll()
    await app.renderOnce()
    expect(Selection.copy(app.renderer, { show() {}, error: (error) => { throw error } }, {
      read: async () => undefined,
      write: async (text) => { copied.push(text) },
    })).toBe(true)
    await app.renderOnce()
    input.clearSelection()
    app.mockInput.pressEscape()
    app.mockInput.pressEnter()
    await app.waitFor(() => submissions.length === 1)
    // Assert both effects together: failure must expose POST as well as copy.
    expect({ copied, submissions }).toMatchObject({
      copied: [expected],
      submissions: [{ text: expected, files: [], agents: [], delivery: "steer" }],
    })
  } finally {
    takeDraft(id)
  }
})
