import { expect, test } from "bun:test"
import type { TaskQueueCreateInput } from "@opencode/client"
import { InputRenderable, TextRenderable } from "@opentui/core"
import { mkdir, realpath, symlink, unlink } from "node:fs/promises"
import path from "node:path"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { session } from "../fixture/local"
import { taskQueue } from "../fixture/task-queue"
import { sourceSignal } from "../fixture/task-queue-source"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"

const config = { animations: false, tabs: { mode: "on", layout: "horizontal" }, keybinds: { "command.palette.show": "f7" } } as const
const content = "已保存任务再次修改🧪\n第二行保持完整\n  尾部空格  "

// TC-009/007: unlike the wide new-task cases, this edits an existing draft row
// in a fullscreen-sized terminal before the delayed first session can reveal.
test.each(["start", "resume"] as const)("narrow %s cannot replace an existing draft editor with its late first session", async (action) => {
  takeDraft(undefined)
  const result = { ...session(`ses_narrow_intent_${crypto.randomUUID()}`), title: "Late narrow route" }
  let info = taskQueue({ directory, title: "Narrow delayed batch", status: action === "start" ? "queued" : "stopped" })
  const controls: string[] = []
  const visited: string[] = []
  const submissions: TaskQueueCreateInput[] = []
  const receipt = Promise.withResolvers<void>()
  let armed = false
  {
    await using app = await createAppFixture({ width: 44, height: 30, config, fetch: async (url, request) => {
      if (url.pathname === "/api/task-queue" && request.method === "POST") {
        submissions.push(await request.json() as TaskQueueCreateInput)
        return json({ data: taskQueue({ id: "tq_saved_narrow", directory, title: "Saved narrow draft" }) })
      }
      if (url.pathname === "/api/task-queue") { if (armed) receipt.resolve(); return json({ data: [info] }) }
      if (url.pathname === "/api/task-queue/tq_saved_narrow") return json({ data: taskQueue({ id: "tq_saved_narrow", directory, title: "Saved narrow draft" }) })
      if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
      if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
        const method = url.pathname.split("/").at(-1)!
        controls.push(method)
        info = { ...info, status: method === "stop" ? "stopped" : "running", currentTaskID: info.tasks[0].id, time: { created: 1, updated: 2 } }
        return json({ data: info })
      }
      return sessionResponse(url, [result], visited)
    } })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app, info.title!)
    app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("执行中") && !frame.includes("正在处理"))
    await addDraft(app, "旧内容")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次") && frame.includes("旧内容"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("编辑任务") && app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
    app.renderer.currentFocusedEditor?.selectAll()
    await app.mockInput.pasteBracketedText(content)
    const editor = app.renderer.currentFocusedEditor
    expect(editor?.plainText).toBe(content)
    info = { ...info, tasks: [{ ...info.tasks[0], status: "running", sessionID: result.id }], time: { created: 1, updated: 3 } }
    armed = true
    app.events.emit({ id: "evt_narrow_first", created: 3, type: "taskqueue.updated", data: info })
    app.events.emit({ id: "evt_narrow_receipt", type: "server.connected", data: {} })
    await sourceSignal(receipt.promise)
    await app.renderOnce()
    expect(app.renderer.currentFocusedEditor).toBe(editor)
    expect(editor?.plainText).toBe(content)
    expect(app.captureCharFrame()).toContain("编辑任务")
    expect(app.renderer.root.findDescendantById("session-panel")).toBeUndefined()
    expect(visited).toEqual([])
    expect(submissions).toEqual([])
    expect(controls).toEqual([action])
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建前预览") && frame.includes("第二行保持完整"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("Saved narrow draft"))
    expect(submissions.map((input) => input.tasks)).toEqual([[{ prompt: content }]])
    expect(controls).toEqual([action])
  }
  expect(controls).toEqual([action, "stop"])
})

// TC-010/011: previous tests cover canonical navigation OR SDK refresh. Returning
// to the confirmed alias and then losing that SDK's identity facts must preserve
// the editor, and a successful scoped list must re-confirm identity and follow.
test.each([["start", 160], ["resume", 44]] as const)("alias return then %s SDK refresh and failed list recover without losing drafts at %s columns", async (action, width) => {
  takeDraft(undefined)
  await using root = await tmpdir()
  const target = path.join(root.path, "real")
  const alias = path.join(root.path, "alias")
  await mkdir(target)
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
  const oldEvents = createEventStream()
  const events = createEventStream()
  const failedList = Promise.withResolvers<Response>()
  const refreshRequested = Promise.withResolvers<void>()
  const aliasReceipt = Promise.withResolvers<void>()
  const recoveryReceipt = Promise.withResolvers<void>()
  const controls: string[] = []
  const scopes: string[] = []
  const visited: string[] = []
  const rejected: string[] = []
  let endpoint = ""
  let refreshed = false
  let moved = false
  let recovering = false
  try {
    const canonical = await realpath(alias)
    expect(canonical).toBe(await realpath(target))
    expect(canonical).not.toBe(alias)
    const sessions = [1, 2].map((index) => ({ ...session(`ses_combo_${index}_${crypto.randomUUID()}`), title: `Combo route ${index}`, location: { directory: canonical } }))
    let info = taskQueue({ directory: canonical, title: "Alias refresh batch", status: action === "start" ? "queued" : "stopped",
      tasks: sessions.map((_, index) => ({ ...taskQueue().tasks[0], id: `tqt_combo_${index}`, title: `Combo task ${index}`, position: index })) })
    const auth = (password: string) => ({ type: "basic", username: "fixture", password } as const)
    const calls = createFetch((url, request) => {
      if (url.pathname === "/api/event") return request.headers.get("authorization") === "Basic " + Buffer.from("fixture:old").toString("base64") ? oldEvents.v2() : events.v2()
      if (url.pathname === "/api/location" || url.pathname === "/api/fs/list") {
        const value = url.searchParams.get("location[directory]") === canonical ? canonical : alias
        const location = { directory: value, project: { id: "proj_test", directory: value, canonical } }
        return json(url.pathname === "/api/location" ? location : { location, data: [] })
      }
      if (url.pathname.startsWith("/api/task-queue")) {
        if (request.headers.get("authorization") !== "Basic " + Buffer.from(`fixture:${refreshed ? "new" : "old"}`).toString("base64")) {
          rejected.push(url.pathname)
          return new Response(null, { status: 401 })
        }
      }
      if (url.pathname === "/api/task-queue") {
        scopes.push(url.searchParams.get("directory")!)
        if (refreshed && !recovering) { refreshRequested.resolve(); return failedList.promise }
        if (recovering) recoveryReceipt.resolve()
        if (moved) aliasReceipt.resolve()
        return json({ data: [info] })
      }
      if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
      if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
        const method = url.pathname.split("/").at(-1)!
        controls.push(`${refreshed ? "new" : "old"}:${method}`)
        info = { ...info, status: method === "stop" ? "stopped" : "running", currentTaskID: info.tasks[0].id,
          tasks: info.tasks.map((task, index) => index ? task : { ...task, status: "running", sessionID: sessions[0].id }), time: { created: 1, updated: 2 } }
        return json({ data: info })
      }
      return sessionResponse(url, sessions, visited)
    })
    {
      await using app = await createAppFixture({ width, height: 30, config, auth: auth("old"),
        service: { reconnect: async () => { refreshed = true; return { url: endpoint, auth: auth("new") } }, restart: async () => {} },
        fetch: (url, request) => { endpoint = `${url.origin}/`; return calls.fetch(request) } })
      try {
        await app.ready
        await app.waitForFrame((frame) => frame.includes("commands") && aliasLabel(app))
        await openTasks(app, info.title!)
        expect(scopes[0]).toBe(alias)
        app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
        await app.waitFor(() => visited.includes(sessions[0].id))
        await app.waitForFrame((frame) => frame.includes("批次：Alias refresh") && frame.includes("跟随执行中"))
        await openTasks(app, info.title!)
        await addDraft(app, content)
        const editor = app.renderer.currentFocusedEditor
        sessions[0] = { ...sessions[0], location: { directory: alias } }
        oldEvents.emit({ id: "evt_combo_alias", created: 3, type: "session.moved", durable: { aggregateID: sessions[0].id, seq: 1, version: 1 },
          data: { sessionID: sessions[0].id, projectID: "proj_test", location: { directory: alias } } })
        // The transport batches events: a connected event is not a barrier for
        // Solid's Location effects. Wait for the production prompt's path first.
        await app.waitFor(() => aliasLabel(app))
        moved = true
        oldEvents.emit({ id: "evt_combo_alias_receipt", type: "server.connected", data: {} })
        await sourceSignal(aliasReceipt.promise)
        await app.renderOnce()
        expect(scopes.at(-1)).toBe(alias)
        expect(app.renderer.currentFocusedEditor).toBe(editor)
        expect(editor?.plainText).toBe(content)
        app.events.disconnect()
        oldEvents.disconnect()
        await sourceSignal(refreshRequested.promise)
        expect(scopes.at(-1)).toBe(alias)
        await app.renderOnce()
        expect(app.renderer.currentFocusedEditor).toBe(editor)
        expect(editor?.plainText).toBe(content)
        failedList.resolve(new Response("combo transient list failure", { status: 503 }))
        await app.waitForFrame((frame) => frame.includes("无法访问任务队列") && frame.includes("添加任务"))
        expect(app.renderer.currentFocusedEditor).toBe(editor)
        expect(editor?.plainText).toBe(content)
        recovering = true
        events.emit({ id: "evt_combo_list_recover", type: "server.connected", data: {} })
        await sourceSignal(recoveryReceipt.promise)
        await app.waitForFrame((frame) => frame.includes("添加任务") && !frame.includes("无法访问任务队列"))
        expect(scopes.at(-1)).toBe(alias)
        expect(app.renderer.currentFocusedEditor).toBe(editor)
        expect(editor?.plainText).toBe(content)
        app.mockInput.pressEscape()
        await app.waitForFrame((frame) => frame.includes("新建批次"))
        app.mockInput.pressEscape()
        await app.waitForFrame((frame) => frame.includes("任务队列 / tasks"))
        app.mockInput.pressEscape()
        await app.waitForFrame((frame) => frame.includes("跟随执行中") && !frame.includes("任务队列 / tasks"))
        info = { ...info, currentTaskID: info.tasks[1].id, tasks: info.tasks.map((task, index) => index ? { ...task, status: "running", sessionID: sessions[1].id } : { ...task, status: "completed" }), time: { created: 1, updated: 4 } }
        events.emit({ id: "evt_combo_second", created: 4, type: "taskqueue.updated", data: info })
        await app.waitFor(() => visited.includes(sessions[1].id))
        await app.waitForFrame((frame) => frame.includes("批次：Alias refresh") && frame.includes("跟随执行中") && frame.includes("▶ 执行"))
        expect(visited.filter((id) => id === sessions[1].id)).toHaveLength(1)
        expect(controls).toEqual([`old:${action}`])
        expect(rejected).toEqual([])
      } finally {
        failedList.resolve(new Response(null, { status: 503 }))
      }
    }
    expect(controls).toEqual([`old:${action}`, "new:stop"])
  } finally {
    failedList.resolve(new Response(null, { status: 503 }))
    events.disconnect()
    oldEvents.disconnect()
    await unlink(alias)
  }
})

async function addDraft(app: Awaited<ReturnType<typeof createAppFixture>>, text: string) {
  app.mockInput.pressKey("a", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("新建批次"))
  app.mockInput.pressKey("a", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
  await app.mockInput.pasteBracketedText(text)
}

async function openTasks(app: Awaited<ReturnType<typeof createAppFixture>>, title: string) {
  app.mockInput.pressKey("F7")
  await app.waitForFrame((frame) => frame.includes("Commands") && app.renderer.currentFocusedEditor instanceof InputRenderable)
  await app.mockInput.typeText("Task queues")
  await app.waitForFrame((frame) => frame.includes("任务队列 / Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && frame.includes(title) && app.renderer.currentFocusedEditor instanceof InputRenderable)
}

function aliasLabel(app: Awaited<ReturnType<typeof createAppFixture>>) {
  const label = app.renderer.root.findDescendantById("prompt.footer.location")
  return label instanceof TextRenderable && /[\\/]ali/.test(label.plainText)
}

function sessionResponse(url: URL, sessions: ReturnType<typeof session>[], visited: string[]) {
  const value = sessions.find((value) => url.pathname === `/api/session/${value.id}`)
  if (value) { visited.push(value.id); return json({ data: value }) }
  if (sessions.some((value) => url.pathname === `/api/session/${value.id}/message`)) return json({ data: [], cursor: {} })
  if (sessions.some((value) => url.pathname === `/api/session/${value.id}/inbox`)) return json({ data: [] })
  return undefined
}
