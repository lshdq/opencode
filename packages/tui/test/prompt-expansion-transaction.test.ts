import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { Selection } from "../src/util/selection"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

async function fixture(state: string) {
  const id = "ses_expansion_transaction"
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
        { id: "reviewer", mode: "subagent", hidden: false, permissions: [] },
      ] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/fs/find") return json({ location, data: [] })
      if (url.pathname === "/api/model") return json({ location, data: [{ id: "model", providerID: "provider", name: "Expansion model", variants: [] }] })
      if (url.pathname === `/api/session/${id}`) return json({ data: {
        id, title: "Expansion fixture", projectID: "proj_test", location: { directory },
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
    await app.waitForFrame((frame) => frame.includes("Expansion model") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Prompt missing")
    return {
      ...app, input, submissions,
      async paste(text: string) {
        const before = input.plainText
        await app.mockInput.pasteBracketedText(text)
        await app.waitFor(() => input.plainText !== before)
      },
      async copy() {
        const values: string[] = []
        input.selectAll()
        await app.renderOnce()
        expect(Selection.copy(app.renderer, { show() {}, error: (error) => { throw error } }, {
          read: async () => undefined, write: async (text) => { values.push(text) },
        })).toBe(true)
        await app.renderOnce()
        input.clearSelection()
        return values.at(-1)
      },
      async submit(expected: { text: string; agents?: { name: string }[] }) {
        input.clearSelection()
        app.mockInput.pressEscape()
        app.mockInput.pressEnter()
        await app.waitFor(() => submissions.length === 1)
        expect(submissions[0]).toMatchObject(expected)
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

const a = "AAA1\nAAA2\nAAA3"
const b = "BBB1\nBBB2\nBBB3"

test("mouse expansion keeps both same-name paste payloads through native undo", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const label = app.input.plainText
  await app.paste(b)
  const frame = await app.waitForFrame((frame) => (frame.match(/\[Pasted ~3 lines\]/g)?.length ?? 0) === 2)
  const lines = frame.split("\n")
  const row = lines.findLastIndex((line) => line.includes("[Pasted"))
  await app.mockMouse.click(lines[row].lastIndexOf("[Pasted") + 5, row)
  await app.waitFor(() => app.input.plainText === `${label}${b} `)
  app.input.undo()
  app.input.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${a} ${b} `)
  await app.submit({ text: `${a} ${b} ` })
})

test("expansion redo and a later edit branch retain the original payload identity", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const label = app.input.plainText
  await app.paste(a)
  expect(app.input.plainText).toBe(`${a} `)
  app.input.editBuffer.undo()
  app.input.editBuffer.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${a} `)
  app.input.editBuffer.redo()
  app.input.editBuffer.redo()
  await app.renderOnce()
  expect(app.input.plainText).toBe(`${a} `)
  app.input.editBuffer.undo()
  app.input.editBuffer.undo()
  await app.renderOnce()
  expect(app.input.plainText).toBe(label)
  app.input.gotoBufferEnd()
  await app.paste(b)
  expect(app.input.editBuffer.canRedo()).toBe(false)
  expect(await app.copy()).toBe(`${a} ${b} `)
  await app.submit({ text: `${a} ${b} ` })
})

test.each(["delete", "clear"] as const)("non-text extmark %s cannot stage stale payloads for a later text undo", async (operation) => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const label = app.input.plainText
  if (operation === "clear") app.input.extmarks.clear()
  else app.input.extmarks.delete(app.input.extmarks.getAll()[0].id)
  // This is an intentional metadata-only removal, not an expand transaction.
  await app.renderOnce()
  app.input.gotoBufferEnd()
  await app.mockInput.typeText("!")
  app.input.editBuffer.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(label)
  await app.submit({ text: label })
})

test("non-text extmark relocation remains current when a later native edit is undone", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const label = app.input.plainText
  app.input.insertText(label)
  await app.renderOnce()
  const mark = app.input.extmarks.getAll()[0]
  const length = mark.end - mark.start
  mark.start = label.length
  mark.end = label.length + length
  app.input.editBuffer.insertText("!")
  app.input.editBuffer.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${label}${a} `)
  await app.submit({ text: `${label}${a} ` })
})

test("autocomplete mention insertion and replacement share the native metadata undo boundary", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  await app.mockInput.typeText("@reviewer")
  await app.waitForFrame((frame) => (frame.match(/@reviewer/g)?.length ?? 0) >= 2)
  app.mockInput.pressEnter()
  await app.waitFor(() => app.input.plainText.endsWith("@reviewer "))
  app.input.editBuffer.undo()
  app.input.editBuffer.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${a} @reviewer`)
  app.input.editBuffer.redo()
  app.input.editBuffer.redo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${a} @reviewer `)
  await app.submit({ text: `${a} @reviewer `, agents: [{ name: "reviewer" }] })
})

// TC-010 / F-02: exercise resetComposer through the production keymap, not buffer.clear.
test.each([false, true])("independent: Ctrl+C after expansion (restored=%s) cannot revive metadata in a new draft", async (restored) => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const label = app.input.plainText
  await app.paste(a)
  expect(app.input.plainText).toBe(`${a} `)
  if (restored) {
    app.input.undo()
    app.input.undo()
    await app.renderOnce()
    expect(await app.copy()).toBe(`${a} `)
    app.input.clearSelection()
  }
  app.mockInput.pressKey("c", { ctrl: true })
  await app.waitFor(() => app.input.plainText === "")
  expect(app.input.extmarks.getAll()).toHaveLength(0)
  expect(app.input.editBuffer.canUndo()).toBe(false)
  expect(app.input.editBuffer.canRedo()).toBe(false)
  app.mockInput.pressKey("z", { ctrl: true })
  await app.renderOnce()
  expect(app.input.plainText).toBe("")
  // An identical-looking literal must stay literal, even beside a new compact paste.
  app.input.insertText(label)
  await app.paste(b)
  app.input.undo()
  expect(await app.copy()).toBe(label)
  app.input.redo()
  expect(await app.copy()).toBe(`${label}${b} `)
  await app.submit({ text: `${label}${b} `, agents: [] })
})
