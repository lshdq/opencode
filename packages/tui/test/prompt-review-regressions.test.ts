import { expect, test } from "bun:test"
import path from "node:path"
import { TextareaRenderable } from "@opentui/core"
import { Selection } from "../src/util/selection"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

async function fixture(state: string, fetch?: FetchHandler) {
  takeDraft(undefined)
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  const submissions: unknown[] = []
  const creations: { id: string; location: { directory: string } }[] = []
  const app = await createAppFixture({
    state,
    config: { animations: false, tabs: { mode: "off" }, prompt: { paste: "compact" } },
    fetch: async (url, request) => {
      const response = await fetch?.(url, request)
      if (response) return response
      const scoped = { ...location, directory: url.searchParams.get("location[directory]") ?? directory }
      if (url.pathname === "/api/location") return json(scoped)
      if (url.pathname === "/api/agent") return json({ location: scoped, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model") return json({ location: scoped, data: [{ id: "model", providerID: "provider", name: "Review model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location: scoped, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/session" && request.method === "POST") {
        const body = await request.json() as { id: string; location: { directory: string } }
        creations.push(body)
        return json({ data: { ...body, projectID: "proj_test", agent: "build", model: { providerID: "provider", id: "model" },
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } } })
      }
      if (request.method === "POST" && url.pathname.endsWith("/model")) return new Response(null, { status: 204 })
      if (request.method === "POST" && url.pathname.endsWith("/prompt")) {
        submissions.push(await request.json())
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
    },
  })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("Review model") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Prompt missing")
    const copied: string[] = []
    const clipboard = { write: async (text: string) => { copied.push(text) }, read: async () => undefined }
    const errors: unknown[] = []
    const toast = { show() {}, error: (error: unknown) => errors.push(error) }
    return {
      ...app, input, copied, errors, creations, submissions,
      async paste(text: string) {
        const before = input.plainText
        await app.mockInput.pasteBracketedText(text)
        await app.waitFor(() => input.plainText !== before && input.plainText.includes("[Pasted"))
      },
      async cut(start?: number, end?: number) {
        const before = input.plainText
        if (start !== undefined && end !== undefined) input.setSelection(start, end)
        else input.selectAll()
        await app.renderOnce()
        expect(Selection.cut(app.renderer, toast, clipboard)).toBe(true)
        await app.waitFor(() => input.plainText !== before)
      },
      async copy() {
        input.selectAll()
        await app.renderOnce()
        expect(Selection.copy(app.renderer, toast, clipboard)).toBe(true)
        await app.renderOnce()
        return copied.at(-1)
      },
      async [Symbol.asyncDispose]() {
        await app[Symbol.asyncDispose]()
        takeDraft(undefined)
      },
    }
  } catch (error) {
    await app[Symbol.asyncDispose]()
    throw error
  }
}

const a = "AAA1\nAAA2\nAAA3"
const b = "BBB1\nBBB2\nBBB3"
const c = "CCC1\nCCC2\nCCC3"

// TC-010 / DEC-011: independent end-to-end boundaries, not a mirror of undo.ts.
test.each([255, 256, 257])("independent: %i native steps retain payload at the window edge and on a new branch", async (steps) => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  app.input.editBuffer.clearHistory()
  for (let index = 0; index < steps; index++) app.input.editBuffer.insertText("x")
  for (let index = 0; index < Math.min(256, steps); index++) expect(app.input.editBuffer.undo()).not.toBeNull()
  expect(app.input.editBuffer.canUndo()).toBe(false)
  expect(app.input.editBuffer.undo()).toBeNull()
  const suffix = steps > 256 ? "x" : ""
  expect(await app.copy()).toBe(`${a} ${suffix}`)
  app.input.clearSelection()
  app.input.gotoBufferEnd()
  await app.paste(b)
  expect(app.input.editBuffer.canRedo()).toBe(false)
  expect(app.input.editBuffer.redo()).toBeNull()
  app.input.undo()
  expect(await app.copy()).toBe(`${a} ${suffix}`)
  app.input.clearSelection()
  app.input.redo()
  expect(await app.copy()).toBe(`${a} ${suffix}${b} `)
  app.input.clearSelection()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.submissions.length === 1)
  expect(app.submissions[0]).toMatchObject({ text: `${a} ${suffix}${b} ` })
})

test.each(["setText", "setTextOwned", "clear", "clearHistory"] as const)("independent: real Prompt %s resets history without reviving old payloads", async (operation) => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const label = app.input.plainText
  if (operation === "setText" || operation === "setTextOwned") app.input.editBuffer[operation](label)
  else app.input.editBuffer[operation]()
  expect(app.input.editBuffer.canUndo()).toBe(false)
  expect(app.input.editBuffer.undo()).toBeNull()
  const retained = operation === "clearHistory" ? `${a} ` : operation === "clear" ? "" : label
  if (retained) expect(await app.copy()).toBe(retained)
  app.input.clearSelection()
  app.input.gotoBufferEnd()
  await app.paste(b)
  app.input.undo()
  expect(app.input.plainText).toBe(operation === "clear" ? "" : label)
  app.input.redo()
  expect(await app.copy()).toBe(`${retained}${b} `)
  app.input.clearSelection()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.submissions.length === 1)
  expect(app.submissions[0]).toMatchObject({ text: `${retained}${b} ` })
})

test("independent: same-text native replacement distinguishes literal label from paste metadata", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const label = app.input.plainText
  app.input.editBuffer.replaceTextOwned(label)
  expect(await app.copy()).toBe(label)
  app.input.clearSelection()
  app.input.editBuffer.undo()
  expect(await app.copy()).toBe(`${a} `)
  app.input.clearSelection()
  app.input.editBuffer.redo()
  expect(await app.copy()).toBe(label)
  app.input.clearSelection()
  app.input.editBuffer.undo()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.submissions.length === 1)
  expect(app.submissions[0]).toMatchObject({ text: `${a} ` })
})

test("independent: middle identical placeholder survives direct native deletion and redo", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const width = app.input.plainText.length
  await app.paste(b)
  await app.paste(c)
  await app.cut(width, width * 2)
  expect(app.copied.at(-1)).toBe(`${b} `)
  app.input.undo()
  expect(await app.copy()).toBe(`${a} ${b} ${c} `)
  app.input.clearSelection()
  app.input.editBuffer.deleteRange(0, width, 0, width * 2)
  expect(await app.copy()).toBe(`${a} ${c} `)
  app.input.clearSelection()
  app.input.editBuffer.undo()
  expect(await app.copy()).toBe(`${a} ${b} ${c} `)
  app.input.clearSelection()
  app.input.editBuffer.redo()
  expect(await app.copy()).toBe(`${a} ${c} `)
  app.input.clearSelection()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.submissions.length === 1)
  expect(app.submissions[0]).toMatchObject({ text: `${a} ${c} ` })
})

test.each(["native", "keyboard"])("independent: repeated paste expansion can undo back to a payload-bearing placeholder (%s)", async (method) => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const label = app.input.plainText
  await app.mockInput.pasteBracketedText(a)
  await app.waitFor(() => app.input.plainText === `${a} `)
  // Selection replacement is two native operations: insertion, then deletion.
  for (let index = 0; index < 2; index++) {
    if (method === "native") app.input.undo()
    else app.mockInput.pressKey("z", { ctrl: true })
    await app.renderOnce()
  }
  await app.renderOnce()
  expect(app.input.plainText).toBe(label)
  const copied = await app.copy()
  app.input.clearSelection()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.submissions.length === 1)
  expect({ copied, submission: app.submissions[0] }).toMatchObject({
    copied: `${a} `,
    submission: { text: `${a} ` },
  })
})

test.each([false, true])("independent: edited-away cd completion (%s) cannot change footer or submit location", async (reject) => {
  await using state = await tmpdir()
  const gate = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<void>()
  const target = path.resolve(directory, "independent-cancelled")
  await using app = await fixture(state.path, (url) => {
    if (url.pathname !== "/api/location" || url.searchParams.get("location[directory]") !== target) return
    entered.resolve()
    return gate.promise
  })
  try {
    await app.mockInput.typeText("/cd independent-cancelled")
    app.mockInput.pressEscape()
    app.mockInput.pressEnter()
    await entered.promise
    // Return to the same empty visible text; revision, not text equality, owns the result.
    await app.mockInput.typeText("x")
    app.input.undo()
    expect(app.input.plainText).toBe("")
    gate.resolve(reject ? new Response("cancelled error", { status: 503 }) : json({ directory: target, project: { id: "proj_test", directory: target } }))
    await app.waitForFrame((frame) => !frame.includes("independent-cancelled"))
    expect(app.captureCharFrame()).not.toContain("Failed to change directory")
    await app.mockInput.typeText("actual source")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.submissions.length === 1)
    expect(app.creations).toHaveLength(1)
    expect(app.creations[0].location.directory).toBe(directory)
    expect(app.submissions[0]).toMatchObject({ text: "actual source" })
  } finally {
    gate.resolve(json({ directory, project: { id: "proj_test", directory } }))
  }
})

test("R-01: same-name paste placeholders restore their own payload after three native undos", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  await app.cut()
  await app.paste(b)
  await app.cut()
  expect(app.copied).toEqual([`${a} `, `${b} `])
  for (let index = 0; index < 3; index++) {
    app.input.undo()
    await app.renderOnce()
  }
  expect(await app.copy()).toBe(`${a} `)
  app.input.clearSelection()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.submissions.length === 1)
  expect(app.submissions[0]).toMatchObject({ text: `${a} ` })
})

test("R-01: cutting one of two simultaneous identical labels copies that extmark's payload", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  const first = app.input.plainText
  await app.paste(b)
  await app.cut(first.length, app.input.plainText.length)
  expect(app.copied).toEqual([`${b} `])
  expect(app.input.plainText).toBe(first)
  app.input.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${a} ${b} `)
  app.input.clearSelection()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.submissions.length === 1)
  expect(app.submissions[0]).toMatchObject({ text: `${a} ${b} ` })
})

test("R-02: editing during Home cd clears the stale footer and submits in the actual directory", async () => {
  await using state = await tmpdir()
  const gate = Promise.withResolvers<Response>()
  const entered = Promise.withResolvers<void>()
  const target = path.resolve(directory, "review-other")
  await using app = await fixture(state.path, (url) => {
    if (url.pathname === "/api/location" && url.searchParams.get("location[directory]") === target) {
      entered.resolve()
      return gate.promise
    }
  })
  try {
    await app.mockInput.typeText("/cd review-other")
    app.mockInput.pressEscape()
    app.mockInput.pressEnter()
    await entered.promise
    await app.mockInput.typeText("new draft")
    gate.resolve(json({ directory: target, project: { id: "proj_test", directory: target, canonical: target } }))
    await Bun.sleep(40)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("review-other")
    expect(app.input.plainText).toBe("new draft")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.creations.length === 1)
    expect(app.creations[0].location.directory).toBe(directory)
  } finally { gate.resolve(json({ directory, project: { id: "proj_test", directory } })) }
})

test("R-01: native undo/redo and normal typing preserve repeated paste identities on a new branch", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  await app.cut()
  await app.paste(b)
  await app.cut()
  for (let index = 0; index < 3; index++) {
    app.input.editBuffer.undo()
    await app.renderOnce()
  }
  expect(await app.copy()).toBe(`${a} `)
  app.input.clearSelection()
  for (let index = 0; index < 3; index++) {
    app.input.editBuffer.redo()
    await app.renderOnce()
  }
  app.input.editBuffer.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${b} `)
  app.input.clearSelection()
  app.input.gotoBufferEnd()
  await app.mockInput.typeText("!")
  expect(app.input.editBuffer.canRedo()).toBe(false)
  expect(await app.copy()).toBe(`${b} !`)
  app.input.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${b} `)
  app.input.redo()
  await app.renderOnce()
  await app.cut()
  await app.paste(c)
  await app.cut()
  for (let index = 0; index < 3; index++) {
    app.input.undo()
    await app.renderOnce()
  }
  expect(await app.copy()).toBe(`${b} !`)
  app.input.clearSelection()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.submissions.length === 1)
  expect(app.submissions[0]).toMatchObject({ text: `${b} !` })
})

test("R-01: selecting and typing over a paste follows both native replacement operations", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path)
  await app.paste(a)
  app.input.selectAll()
  await app.mockInput.typeText("x")
  expect(app.input.plainText).toBe("x")
  app.input.undo()
  app.input.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${a} `)
  app.input.clearSelection()
  app.input.editBuffer.replaceTextOwned("literal")
  await app.renderOnce()
  app.input.editBuffer.undo()
  await app.renderOnce()
  expect(await app.copy()).toBe(`${a} `)
})

test.each([
  { oldFirst: true, same: false, reject: false },
  { oldFirst: false, same: false, reject: false },
  { oldFirst: true, same: true, reject: false },
  { oldFirst: true, same: false, reject: true },
])("R-02: cd ownership survives out-of-order completion ($oldFirst/$same/$reject)", async (options) => {
  await using state = await tmpdir()
  const first = Promise.withResolvers<Response>()
  const second = Promise.withResolvers<Response>()
  const entries = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const targets = [path.resolve(directory, "review-first"), path.resolve(directory, options.same ? "review-first" : "review-second")]
  let requests = 0
  await using app = await fixture(state.path, (url) => {
    if (url.pathname !== "/api/location" || !targets.includes(url.searchParams.get("location[directory]") ?? "")) return
    const index = requests++
    if (index > 1) return
    entries[index]?.resolve()
    return index === 0 ? first.promise : second.promise
  })
  const response = (index: number) => json({ directory: targets[index], project: { id: "proj_test", directory: targets[index], canonical: targets[index] } })
  try {
    await app.mockInput.typeText("/cd review-first")
    app.mockInput.pressEscape()
    app.mockInput.pressEnter()
    await entries[0].promise
    await app.mockInput.typeText(`/cd ${options.same ? "review-first" : "review-second"}`)
    app.mockInput.pressEscape()
    app.mockInput.pressEnter()
    await entries[1].promise
    if (options.oldFirst) first.resolve(options.reject ? new Response("old failed", { status: 500 }) : response(0))
    else second.resolve(response(1))
    await Bun.sleep(40)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(options.same ? "review-first" : "review-second")
    if (options.oldFirst) second.resolve(response(1))
    else first.resolve(response(0))
    await Bun.sleep(40)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(options.same ? "review-first" : "review-second")
    await app.mockInput.typeText("latest location")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.creations.length === 1)
    expect(app.creations[0].location.directory).toBe(targets[1])
  } finally { first.resolve(response(0)); second.resolve(response(1)) }
})

test("R-02: a failed latest cd clears its label and an older success cannot revive it", async () => {
  await using state = await tmpdir()
  const first = Promise.withResolvers<Response>()
  const second = Promise.withResolvers<Response>()
  const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const targets = [path.resolve(directory, "review-first"), path.resolve(directory, "review-second")]
  await using app = await fixture(state.path, (url) => {
    if (url.pathname !== "/api/location") return
    const index = targets.indexOf(url.searchParams.get("location[directory]") ?? "")
    if (index < 0) return
    entered[index].resolve()
    return index === 0 ? first.promise : second.promise
  })
  try {
    for (const [index, name] of ["review-first", "review-second"].entries()) {
      await app.mockInput.typeText(`/cd ${name}`)
      app.mockInput.pressEscape()
      app.mockInput.pressEnter()
      await entered[index].promise
    }
    second.resolve(new Response("latest failed", { status: 500 }))
    await app.waitForFrame((frame) => frame.includes("Failed to change directory"))
    first.resolve(json({ directory: targets[0], project: { id: "proj_test", directory: targets[0] } }))
    await Bun.sleep(40)
    await app.renderOnce()
    // Error details may contain the target URL; check the working-directory footer.
    const footer = app.captureCharFrame().split("\n").find((line) => line.includes("shift+tab"))
    expect(footer).not.toContain("review-first")
    expect(footer).not.toContain("review-second")
    await app.mockInput.typeText("source location")
    app.mockInput.pressEnter()
    await app.waitFor(() => app.creations.length === 1)
    expect(app.creations[0].location.directory).toBe(directory)
  } finally {
    first.resolve(json({ directory, project: { id: "proj_test", directory } }))
    second.resolve(new Response(null, { status: 500 }))
  }
})
