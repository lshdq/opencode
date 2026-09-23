import { expect, test } from "bun:test"
import path from "node:path"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { tmpdir } from "./fixture/fixture"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"

type Stage = "create" | "environment" | "agent" | "model" | "prompt" | "command" | "shell" | "revert" | "worktree" | "synthetic"

async function fixture(root: string, options: { stage: Stage; home?: boolean; reject?: boolean; command?: boolean; shell?: boolean; variant?: boolean }) {
  takeDraft(undefined)
  takeDraft("ses_cancel")
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const requests: { stage: string; body: Record<string, unknown> }[] = []
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  const base = {
    id: "ses_cancel", title: "Cancel fixture", projectID: "proj_test", location: { directory },
    agent: "build", model: { providerID: "provider", id: "model" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    ...(options.stage === "revert" ? { revert: { messageID: "msg_revert" } } : {}),
  }
  const sessions = new Map([[base.id, base]])
  const calls = createFetch(async (url, request) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/agent") return json({ location, data: ["build", "plan"].map((id) => ({ id, mode: "primary", hidden: false, permissions: [] })) })
    if (url.pathname === "/api/model") return json({ location, data: [{ id: "model", providerID: "provider", name: "Cancel Model", variants: options.variant ? [{ id: "low" }, { id: "high" }] : [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
    if (url.pathname === "/api/command") return json({ location, data: [{ name: "review", description: "Review fixture" }] })
    if (url.pathname === "/api/session" && request.method === "GET") return json({ data: [base], cursor: {} })
    if (/^\/api\/session\/[^/]+$/.test(url.pathname) && request.method === "GET")
      return json({ data: sessions.get(url.pathname.split("/").at(-1)!) ?? base })
    if (request.method === "GET" && /^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
      return json({ data: [], cursor: {} })
    if (request.method !== "POST" && request.method !== "PUT") return
    const stage = url.pathname === "/api/session" ? "create" :
      url.pathname.endsWith("/revert/commit") ? "revert" : url.pathname.split("/").at(-1)!
    const content = await request.text()
    const body = (content ? JSON.parse(content) : {}) as Record<string, unknown>
    requests.push({ stage, body })
    if (stage === options.stage) {
      entered.resolve()
      await gate.promise
      if (options.reject) return json({ message: "Fixture rejected request" }, { status: 500 })
    }
    if (stage === "create") {
      const session = { ...base, id: String(body.id), title: "New submitted session" }
      sessions.set(session.id, session)
      return json({ data: session })
    }
    if (stage === "prompt") return json({ data: {} })
    if (stage === "worktree") return json({ directory: `${directory}/fresh` })
    return new Response(null, { status: 204 })
  }, createEventStream())
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(run({
    app: { name: "test", version: "test", channel: "test" },
    server: { endpoint: { url: server.url.toString() } },
    config: { get: async () => ({ animations: false, tabs: { mode: "off" }, keybinds: { "session.move": "f5", "agent.cycle": "f6", "session.list": "f7", "session.new": "f8", "prompt.queue": "f9", "variant.cycle": "f10" } }), update: async () => ({}) },
    packages: { prepare: async () => { throw new Error("No installs in this fixture") } },
    terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete() {} }),
    args: options.home ? {} : { sessionID: base.id },
    environment: options.stage === "environment" ? { TEST_ONLY: "fixture" } : undefined,
    log() {},
  }).pipe(
    Effect.provide(Global.layerWith(Object.fromEntries(
      ["home", "data", "cache", "config", "state", "tmp", "bin", "log", "repos"].map((key) => [key, path.join(root, key)]),
    ))),
    Effect.provide(FileSystem.layerNoop({})),
  ))
  const dispose = async () => {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    gate.resolve()
    await task
    await server.stop(true)
    takeDraft(undefined)
    takeDraft(base.id)
  }
  try {
  await setup.waitForFrame((frame) => frame.includes("Build · Cancel Model") && setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
  const editor = setup.renderer.currentFocusedEditor
  if (!(editor instanceof TextareaRenderable)) throw new Error("Missing real Prompt textarea")
  if (options.stage === "worktree") {
    setup.mockInput.pressKey("F5")
    await setup.waitForFrame((frame) => frame.includes("Worktrees") && frame.includes("/tmp/opencode"))
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    setup.mockInput.pressKey("a", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Name worktree"))
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("fresh")
    setup.mockInput.pressEnter()
    await setup.waitFor(() => setup.renderer.currentFocusedEditor === editor)
  }
  if (options.stage === "agent") {
    setup.mockInput.pressKey("F6")
    await setup.waitForFrame((frame) => frame.includes("Plan ·"))
  }
  if (options.variant) {
    setup.mockInput.pressKey("F10")
    await setup.waitForFrame((frame) => frame.includes("low"))
  }
  const text = options.command ? "/review captured" : options.shell ? "echo captured" : "captured draft"
  if (options.shell) setup.mockInput.pressKey("!")
  await setup.mockInput.typeText(text)
  if (options.command) setup.mockInput.pressEscape()
  await setup.renderOnce()
  return {
    ...setup, editor, requests, gate, entered, text, task,
    [Symbol.asyncDispose]: dispose,
  }
  } catch (error) {
    await dispose()
    throw error
  }
}

test.each(["create", "environment", "agent", "model", "revert"] as const)("Escape during %s preparation retains the draft and never sends late", async (stage) => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage, home: stage === "create" || stage === "environment" })
  app.mockInput.pressEnter()
  await app.entered.promise
  app.mockInput.pressEnter()
  app.mockInput.pressEscape()
  expect(app.editor.plainText).toBe(app.text)
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.requests.filter((item) => item.stage === "prompt")).toEqual([])
  expect(app.editor.plainText).toBe(app.text)
  // An explicit retry works; there is no automatic retry or stale lock.
  app.mockInput.pressEnter()
  await app.waitFor(() => app.requests.some((item) => item.stage === "prompt"))
  expect(app.requests.filter((item) => item.stage === "prompt")).toHaveLength(1)
})

test("cancelling getDirectory after worktree creation prevents session creation and submission", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "worktree", home: true })
  app.mockInput.pressEnter()
  await app.entered.promise
  app.mockInput.pressEscape()
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.editor.plainText).toBe(app.text)
  expect(app.requests.filter((item) => item.stage === "create" || item.stage === "prompt")).toEqual([])
})

test("cancellation during synthetic context admission never dispatches the following user prompt", async () => {
  await using root = await tmpdir()
  const before = { own: process.env.OPENCODE_EDITOR_SSE_PORT, claude: process.env.CLAUDE_CODE_SSE_PORT }
  const bridge = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response(null, { status: 400 })
    },
    websocket: {
      open(socket) {
        socket.send(JSON.stringify({ method: "selection_changed", params: {
          filePath: "/fixture/context.ts", text: "selected context", selection: {
            start: { line: 1, character: 0 }, end: { line: 2, character: 0 },
          },
        } }))
      },
      message() {},
    },
  })
  process.env.OPENCODE_EDITOR_SSE_PORT = String(bridge.port)
  delete process.env.CLAUDE_CODE_SSE_PORT
  try {
    await using app = await fixture(root.path, { stage: "synthetic" })
    await app.waitForFrame((frame) => frame.includes("context.ts"))
    app.mockInput.pressEnter()
    await app.entered.promise
    app.mockInput.pressEscape()
    app.gate.resolve()
    await Bun.sleep(80)
    expect(app.editor.plainText).toBe(app.text)
    expect(app.requests.filter((item) => item.stage === "prompt")).toEqual([])
    expect(app.requests.find((item) => item.stage === "synthetic")?.body.resume).toBe(false)
  } finally {
    if (before.own === undefined) delete process.env.OPENCODE_EDITOR_SSE_PORT
    else process.env.OPENCODE_EDITOR_SSE_PORT = before.own
    if (before.claude === undefined) delete process.env.CLAUDE_CODE_SSE_PORT
    else process.env.CLAUDE_CODE_SSE_PORT = before.claude
    await bridge.stop(true)
  }
})

test.each(["create", "agent", "model"] as const)("editing during %s cancels only the old intent", async (stage) => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage, home: stage === "create" })
  app.mockInput.pressEnter()
  await app.entered.promise
  await app.mockInput.typeText(" updated")
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.requests.filter((item) => item.stage === "prompt")).toEqual([])
  expect(app.editor.plainText).toBe(`${app.text} updated`)
})

test.each(["create", "model"] as const)("navigation during %s does not steal the route when preparation settles", async (stage) => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage, home: stage === "create" })
  app.mockInput.pressEnter()
  await app.entered.promise
  if (stage === "create") {
    app.mockInput.pressKey("F7")
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof InputRenderable)
    const frame = await app.waitForFrame((frame) => frame.includes("Sessions") && frame.includes("Cancel fixture"))
    const lines = frame.split("\n")
    const row = lines.findLastIndex((line) => line.includes("Cancel fixture"))
    await app.mockMouse.click(lines[row].indexOf("Cancel fixture") + 1, row)
    await app.waitForFrame(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable && !(app.renderer.currentFocusedEditor instanceof InputRenderable) && app.renderer.currentFocusedEditor !== app.editor)
  } else {
    app.mockInput.pressKey("F8")
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable && app.renderer.currentFocusedEditor !== app.editor)
  }
  const next = app.renderer.currentFocusedEditor
  if (!(next instanceof TextareaRenderable)) throw new Error("Missing destination composer")
  await app.mockInput.typeText("destination draft")
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.renderer.currentFocusedEditor).toBe(next)
  expect(next.plainText).toBe("destination draft")
  expect(app.requests.filter((item) => item.stage === "prompt")).toEqual([])
  expect(takeDraft(stage === "create" ? undefined : "ses_cancel")?.prompt.text).toBe(app.text)
})

test.each(["create", "model"] as const)("exit during %s prevents late sends", async (stage) => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage, home: stage === "create" })
  app.mockInput.pressEnter()
  await app.entered.promise
  app.renderer.destroy()
  await app.task
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.requests.filter((item) => item.stage === "prompt")).toEqual([])
  expect(takeDraft(stage === "create" ? undefined : "ses_cancel")?.prompt.text).toBe(app.text)
})

test.each(["agent", "model"] as const)("server command is cancelled after awaited %s without changing its semantics", async (stage) => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage, command: true })
  app.mockInput.pressEnter()
  await app.entered.promise
  app.mockInput.pressEscape()
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.requests.filter((item) => item.stage === "command")).toEqual([])
  expect(app.editor.plainText).toBe("/review captured")
})

test("new-session shell waits for creation and Escape cancels only the unsent shell", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "create", home: true, shell: true })
  app.mockInput.pressEnter()
  await app.entered.promise
  app.mockInput.pressEscape()
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.requests.filter((item) => item.stage === "shell")).toEqual([])
  expect(app.editor.plainText).toBe("echo captured")
})

test.each([false, true])("a dispatched prompt is not revoked or allowed to replace new input (reject=%s)", async (reject) => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "prompt", home: true, reject })
  app.mockInput.pressEnter()
  await app.entered.promise
  expect(app.editor.plainText).toBe("")
  await app.mockInput.typeText("new intent")
  app.mockInput.pressEscape()
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.renderer.currentFocusedEditor).toBe(app.editor)
  expect(app.editor.plainText).toBe("new intent")
  expect(app.requests.filter((item) => item.stage === "prompt")).toHaveLength(1)
})

test("server rejection restores an untouched cleared composer", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "prompt", reject: true })
  app.mockInput.pressEnter()
  await app.entered.promise
  expect(app.editor.plainText).toBe("")
  app.gate.resolve()
  await app.waitFor(() => app.editor.plainText === app.text)
})

test("official prompt queue stays ordered behind an in-flight admission", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "prompt" })
  app.mockInput.pressEnter()
  await app.entered.promise
  await app.mockInput.typeText("queued followup")
  app.mockInput.pressKey("F9")
  await Bun.sleep(40)
  expect(app.requests.filter((item) => item.stage === "prompt")).toHaveLength(1)
  app.gate.resolve()
  await app.waitFor(() => app.requests.filter((item) => item.stage === "prompt").length === 2)
  expect(app.requests.filter((item) => item.stage === "prompt").map((item) => [item.body.text, item.body.delivery])).toEqual([
    ["captured draft", "steer"], ["queued followup", "queue"],
  ])
})

test("Escape cancels a queued local send without revoking the already dispatched admission", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "prompt" })
  app.mockInput.pressEnter()
  await app.entered.promise
  await app.mockInput.typeText("cancel queued")
  app.mockInput.pressKey("F9")
  await app.renderOnce()
  app.mockInput.pressEscape()
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.requests.filter((item) => item.stage === "prompt")).toHaveLength(1)
  expect(app.editor.plainText).toBe("cancel queued")
})

test("commands retain captured agent/model/variant despite later selector changes", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "agent", command: true, variant: true })
  app.mockInput.pressEnter()
  await app.entered.promise
  app.mockInput.pressKey("F10")
  await app.waitForFrame((frame) => frame.includes("high"))
  app.gate.resolve()
  await app.waitFor(() => app.requests.some((item) => item.stage === "command"))
  expect(app.requests.find((item) => item.stage === "agent")?.body).toEqual({ agent: "plan" })
  expect(app.requests.find((item) => item.stage === "model")?.body).toEqual({ model: { providerID: "provider", id: "model", variant: "low" } })
  expect(app.requests.find((item) => item.stage === "command")?.body).toMatchObject({ name: "review", text: "captured", delivery: "steer" })
})

test("an uncancelled new-session shell keeps the shell endpoint and can navigate after success", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "shell", home: true, shell: true })
  app.mockInput.pressEnter()
  await app.entered.promise
  expect(app.requests.find((item) => item.stage === "shell")?.body).toEqual({ command: "echo captured" })
  expect(app.requests.filter((item) => item.stage === "prompt" || item.stage === "command")).toEqual([])
  app.gate.resolve()
  await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable && app.renderer.currentFocusedEditor !== app.editor)
})

// TC-005 independent counterexample: equality of text is insufficient to prove
// the same user intent survived an await; edits followed by undo still cancel.
test("editing then restoring identical text never revives a pending admission", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "model" })
  app.mockInput.pressEnter()
  await app.entered.promise
  await app.mockInput.typeText("x")
  app.mockInput.pressBackspace()
  await app.waitFor(() => app.editor.plainText === app.text)
  app.gate.resolve()
  await Bun.sleep(80)
  expect(app.requests.filter((item) => item.stage === "prompt")).toEqual([])
  expect(app.editor.plainText).toBe(app.text)
  app.mockInput.pressEnter()
  await app.waitFor(() => app.requests.some((item) => item.stage === "prompt"))
  expect(app.requests.filter((item) => item.stage === "prompt")).toHaveLength(1)
})

test("a new explicit submit before the cancelled preparation settles sends only the new intent", async () => {
  await using root = await tmpdir()
  await using app = await fixture(root.path, { stage: "agent" })
  app.mockInput.pressEnter()
  await app.entered.promise
  app.mockInput.pressEscape()
  await app.mockInput.typeText(" replacement")
  app.mockInput.pressEnter()
  await app.waitFor(() => app.requests.filter((item) => item.stage === "agent").length === 2)
  app.gate.resolve()
  await app.waitFor(() => app.requests.some((item) => item.stage === "prompt"))
  await Bun.sleep(80)
  expect(app.requests.filter((item) => item.stage === "prompt").map((item) => item.body.text)).toEqual([`${app.text} replacement`])
})
