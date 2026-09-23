import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createMockKeys } from "@opentui/core/testing"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { Selection } from "../src/util/selection"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const long = "abcdefghijklmnopqrst"
const payload = "AAA1\nAAA2\nAAA3"

async function fixture(state: string, reverse: boolean) {
  const id = "ses_navigation_history"
  takeDraft(id)
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  const submissions: unknown[] = []
  const app = await createAppFixture({
    state,
    args: { sessionID: id },
    config: { animations: false, tabs: { mode: "off" }, prompt: { paste: "compact" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent") return json({ location, data: [
        { id: "build", mode: "primary", hidden: false, permissions: [] },
      ] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model") return json({ location, data: [
        { id: "model", providerID: "provider", name: "Navigation model", variants: [] },
      ] })
      if (url.pathname === `/api/session/${id}`) return json({ data: {
        id, title: "Navigation fixture", projectID: "proj_test", location: { directory },
        agent: "build", model: { providerID: "provider", id: "model" }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
      } })
      if (request.method === "GET" && /^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      if (request.method === "POST" && url.pathname.endsWith("/model")) return new Response(null, { status: 204 })
      if (request.method === "POST" && url.pathname.endsWith("/prompt")) {
        submissions.push(await request.json())
        return json({ data: {} })
      }
    },
  })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("Navigation model") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Prompt missing")
    input.insertText(`${long}\nx\n`)
    await app.mockInput.pasteBracketedText(payload)
    await app.waitFor(() => input.plainText.includes("[Pasted ~3 lines]"))
    input.insertText(`${reverse ? "\nx" : ""}\n${long}`)
    await app.renderOnce()
    const historyKeys = createMockKeys(app.renderer, { kittyKeyboard: true })
    return {
      ...app, input,
      expanded: `${long}\nx\n${payload} ${reverse ? "\nx" : ""}\n${long}`,
      async arrow(direction: "up" | "down") {
        app.mockInput.pressArrow(direction)
        await app.renderOnce()
      },
      async redo() {
        // Ctrl+. is the configured default. Legacy Ctrl+Shift+Z cannot carry
        // the Shift bit and would be decoded as another Ctrl+Z instead.
        historyKeys.pressKey(".", { ctrl: true })
        await app.renderOnce()
      },
      async checkPayload(text: string) {
        const copied: string[] = []
        input.selectAll()
        await app.renderOnce()
        expect(Selection.copy(app.renderer, { show() {}, error: (error) => { throw error } }, {
          read: async () => undefined, write: async (text) => { copied.push(text) },
        })).toBe(true)
        await app.renderOnce()
        input.clearSelection()
        app.mockInput.pressEscape()
        app.mockInput.pressEnter()
        await app.waitFor(() => submissions.length === 1)
        expect({ copied, submissions }).toMatchObject({ copied: [text], submissions: [{ text }] })
      },
      async [Symbol.asyncDispose]() {
        await app[Symbol.asyncDispose]()
        takeDraft(id)
      },
    }
  } catch (error) {
    await app[Symbol.asyncDispose]()
    takeDraft(id)
    throw error
  }
}

const paths = [
  { name: "forward virtual", reverse: false, start: [0, 8], arrows: ["down", "down", "up"], path: [[1, 1], [2, 17], [1, 1]], next: "up", expected: [0, 17] },
  { name: "reverse virtual", reverse: true, start: [4, 12], arrows: ["up", "up", "down"], path: [[3, 1], [2, 17], [3, 1]], next: "down", expected: [4, 17] },
  { name: "first move virtual snap", reverse: false, start: [1, 1], arrows: ["down", "up"], path: [[2, 17], [1, 1]], next: "up", expected: [0, 17] },
  { name: "plain long-short", reverse: false, start: [0, 8], arrows: ["down"], path: [[1, 1]], next: "up", expected: [0, 8] },
  { name: "explicit buffer cursor", reverse: false, start: [0, 8], arrows: ["down", "down", "up"], path: [[1, 1], [2, 17], [1, 1]], next: "up", expected: [0, 1], reset: "buffer" },
  { name: "explicit view cursor", reverse: false, start: [0, 8], arrows: ["down", "down", "up"], path: [[1, 1], [2, 17], [1, 1]], next: "up", expected: [0, 1], reset: "view" },
] as const

test.each(paths.flatMap((path) => ["undo", "redo"].map((mode) => ({ ...path, mode }))))(
  "R-04 real arrows restore desired-column: $name / $mode", async (item) => {
    await using state = await tmpdir()
    await using app = await fixture(state.path, item.reverse)
    const original = app.input.plainText
    const runPath = async () => {
      app.input.editBuffer.setCursor(item.start[0], item.start[1])
      for (const [index, arrow] of item.arrows.entries()) {
        await app.arrow(arrow)
        expect(app.input.logicalCursor).toMatchObject({ row: item.path[index][0], col: item.path[index][1] })
      }
      if ("reset" in item) {
        const cursor = app.input.logicalCursor
        if (item.reset === "buffer") app.input.editBuffer.setCursor(cursor.row, cursor.col)
        else app.input.editorView.setCursorByOffset(cursor.offset)
      }
    }

    // The oracle is uninterrupted real keyboard navigation, NOT native undo.
    await runPath()
    await app.arrow(item.next)
    expect(app.input.logicalCursor).toMatchObject({ row: item.expected[0], col: item.expected[1] })

    if (item.mode === "redo") {
      app.input.gotoBufferEnd()
      await app.mockInput.typeText("!")
      await app.waitFor(() => app.input.plainText === original + "!")
    }
    await runPath()
    const caret = app.input.logicalCursor
    if (item.mode === "undo") {
      await app.mockInput.typeText("!")
      await app.waitFor(() => app.input.plainText !== original)
    }
    app.mockInput.pressKey("z", { ctrl: true })
    await app.renderOnce()
    if (item.mode === "redo") {
      await app.redo()
    }
    expect(app.input.logicalCursor).toEqual(caret)
    expect(app.input.plainText).toBe(original + (item.mode === "redo" ? "!" : ""))
    await app.arrow(item.next)
    expect(app.input.logicalCursor).toMatchObject({ row: item.expected[0], col: item.expected[1] })
    await app.checkPayload(app.expanded + (item.mode === "redo" ? "!" : ""))
  },
)
