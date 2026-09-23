import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { bindPromptUndo, PROMPT_UNDO_LIMIT } from "../src/component/prompt/undo"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { Selection } from "../src/util/selection"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"
import { nativeHistoryCases, prepareNativeHistoryCase } from "./fixture/native-history-contract"

// Independent DEC-013 acceptance: real Prompt, production copy, and Client HTTP.
async function fixture(state: string) {
  const id = "ses_owned_review"
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
      if (url.pathname === "/api/fs/find") return json({ location, data: [] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model") return json({ location, data: [
        { id: "model", providerID: "provider", name: "Owned review model", variants: [] },
      ] })
      if (url.pathname === `/api/session/${id}`) return json({ data: {
        id, title: "Owned review", projectID: "proj_test", location: { directory },
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
    await app.waitForFrame((frame) => frame.includes("Owned review model") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Prompt missing")
    return {
      ...app, input,
      async paste(text: string) {
        const before = input.plainText
        await app.mockInput.pasteBracketedText(text)
        await app.waitFor(() => input.plainText !== before && input.plainText.includes("[Pasted"))
      },
      async copy() {
        if (!input.plainText) return ""
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

const payload = "AAA1\nAAA2\nAAA3"

// Compare only forward-edit results. Native checkpoint counts are deliberately
// not an oracle for the approved application-owned history contract.
test.each(nativeHistoryCases)("independent owned forward result matches locked native input: $name", async (item) => {
  const app = await createTestRenderer({ width: 80, height: 10, useThread: false })
  const raw = new TextareaRenderable(app.renderer, { id: "raw-result" })
  const owned = new TextareaRenderable(app.renderer, { id: "owned-result" })
  app.renderer.root.add(raw)
  app.renderer.root.add(owned)
  const dispose = bindPromptUndo(owned, () => undefined, () => {})
  const label = "[Pasted ~3 lines] "
  try {
    for (const input of [raw, owned]) {
      if (!item.empty) {
        input.insertText(label)
        input.extmarks.create({ start: 0, end: label.length - 1, virtual: true })
        if (item.tail) input.insertText(item.tail)
      }
      prepareNativeHistoryCase(input, item, item.empty ? 0 : label.length)
      item.act(input, item.empty ? 0 : label.length)
    }
    expect({ text: owned.plainText, caret: owned.logicalCursor }).toEqual({ text: raw.plainText, caret: raw.logicalCursor })
  } finally {
    dispose()
    app.renderer.destroy()
  }
})

test.each(["deleteToLineStart", "deleteToLineEnd", "deleteWordForward", "deleteWordBackward"] as const)(
  "independent owned undo covers renderable %s with real copy and POST", async (method) => {
    await using state = await tmpdir()
    await using app = await fixture(state.path)
    await app.paste(payload)
    const prefix = app.input.plainText.length
    app.input.insertText("left right")
    app.input.editBuffer.setCursor(0, method === "deleteWordBackward" ? prefix + 10 : prefix + 5)
    const before = app.input.plainText
    app.input[method]()
    const after = app.input.plainText
    expect(after).not.toBe(before)
    app.input.undo()
    expect(await app.copy()).toBe(`${payload} left right`)
    app.input.redo()
    expect(app.input.plainText).toBe(after)
    app.input.undo()
    expect(await app.copy()).toBe(`${payload} left right`)
    await app.submit({ text: `${payload} left right` })
  },
)

test("independent restored paste/source and agent/mention snapshots survive repeated position changes", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(payload)
  await app.mockInput.typeText("@reviewer")
  await app.waitForFrame((frame) => (frame.match(/@reviewer/g)?.length ?? 0) >= 2)
  app.mockInput.pressEnter()
  await app.waitFor(() => app.input.plainText.endsWith("@reviewer "))
  const expected = `${payload} @reviewer `
  app.input.editBuffer.clearHistory()
  app.input.gotoBufferHome()
  app.input.insertText("HEAD ")
  app.input.gotoBufferHome()
  app.input.insertText("中 ")
  for (let index = 0; index < 4; index++) {
    expect(await app.copy()).toBe(`中 HEAD ${expected}`)
    app.input.undo()
    expect(await app.copy()).toBe(`HEAD ${expected}`)
    app.input.undo()
    expect(await app.copy()).toBe(expected)
    app.input.redo()
    expect(await app.copy()).toBe(`HEAD ${expected}`)
    app.input.redo()
  }
  app.input.undo()
  app.input.gotoBufferHome()
  app.input.insertText("BRANCH ")
  expect(app.input.editBuffer.canRedo()).toBe(false)
  expect(await app.copy()).toBe(`BRANCH HEAD ${expected}`)
  await app.submit({ text: `BRANCH HEAD ${expected}`, agents: [{ name: "reviewer" }] })
})

test("independent distinct hidden payloads evict complete steps without corrupting copy or POST", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  const states = [""]
  // Each distinct 1 MiB UTF-16 payload costs just over 2 MiB: ten cannot fit.
  for (let index = 0; index < 10; index++) {
    if (index) {
      app.input.selectAll()
      expect(app.input.deleteSelection()).toBe(true)
      states.push("")
    }
    const text = `${String.fromCharCode(65 + index).repeat(1024 * 1024)}\nline2\nline3`
    await app.paste(text)
    states.push(`${text} `)
    expect(await app.copy()).toBe(states.at(-1))
  }
  let position = states.length - 1
  while (app.input.editBuffer.canUndo()) {
    expect(app.input.editBuffer.undo()).not.toBeNull()
    expect(await app.copy()).toBe(states[--position])
  }
  expect(position).toBeGreaterThan(0)
  expect(position).toBeLessThan(states.length - 3)
  expect(app.input.editBuffer.undo()).toBeNull()
  while (app.input.editBuffer.canRedo()) {
    expect(app.input.editBuffer.redo()).not.toBeNull()
    expect(await app.copy()).toBe(states[++position])
  }
  expect(position).toBe(states.length - 1)
  await app.submit({ text: states[position] })
  expect(app.input.editBuffer.canUndo()).toBe(false)
  expect(app.input.editBuffer.canRedo()).toBe(false)
}, 30000)

test.each(["clearHistory", "clear"] as const)("independent %s releases exhausted payload budget for a full new window", async (reset) => {
  const app = await createTestRenderer({ width: 80, height: 10, useThread: false })
  const input = new TextareaRenderable(app.renderer, { id: "owned-budget-release" })
  app.renderer.root.add(input)
  const metadata = { payload: "" }
  const dispose = bindPromptUndo(input, () => ({ ...metadata }), (snapshot) => { metadata.payload = snapshot.payload })
  try {
    for (let index = 0; index < 20; index++) {
      metadata.payload = String.fromCharCode(65 + index).repeat(1024 * 1024)
      input.insertText("x")
    }
    input.editBuffer[reset]()
    metadata.payload = "fresh"
    const before = input.plainText
    for (let index = 0; index < PROMPT_UNDO_LIMIT; index++) input.insertText("y")
    for (let index = 0; index < PROMPT_UNDO_LIMIT; index++) expect(input.editBuffer.undo()).not.toBeNull()
    expect(input.plainText).toBe(before)
    expect(metadata.payload).toBe("fresh")
    expect(input.editBuffer.canUndo()).toBe(false)
    for (let index = 0; index < PROMPT_UNDO_LIMIT; index++) expect(input.editBuffer.redo()).not.toBeNull()
    expect(input.plainText).toBe(before + "y".repeat(PROMPT_UNDO_LIMIT))
  } finally {
    dispose()
    app.renderer.destroy()
  }
})
