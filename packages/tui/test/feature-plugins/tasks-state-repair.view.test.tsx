import { expect, test } from "bun:test"
import type { TaskQueueCreateInput } from "@opencode/client"
import { InputRenderable, TextRenderable } from "@opentui/core"
import { mkdir, realpath, symlink, unlink } from "node:fs/promises"
import path from "node:path"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { taskDraftName } from "../../src/feature-plugins/system/tasks"
import { createAppFixture } from "../fixture/app"
import { tmpdir } from "../fixture/fixture"
import { session } from "../fixture/local"
import { taskQueue } from "../fixture/task-queue"
import { sourceSignal } from "../fixture/task-queue-source"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"

const config = { animations: false, tabs: { mode: "on", layout: "horizontal" } } as const
const text = "用户下一批的完整内容🧪\n第二行不能丢失\n  保留缩进与尾部  "

test.each([
  ["start", "edit"], ["resume", "edit"], ["start", "preview"], ["resume", "preview"],
  ["start", "list"], ["resume", "list"],
] as const)("late first session after %s respects the newer %s intent in the same dialog", async (action, stage) => {
  takeDraft(undefined)
  const first = { ...session(`ses_draft_${crypto.randomUUID()}`), title: "Deferred first session" }
  let info = taskQueue({ directory, title: "Original delayed batch", status: action === "start" ? "queued" : "stopped" })
  const controls: string[] = []
  const submissions: TaskQueueCreateInput[] = []
  let saved: ReturnType<typeof taskQueue> | undefined
  const visited: string[] = []
  const receipt = Promise.withResolvers<void>()
  let armed = false
  {
    await using app = await createAppFixture({ width: 160, height: 30, config, fetch: async (url, request) => {
      if (url.pathname === "/api/task-queue" && request.method === "POST") {
        const input = await request.json() as TaskQueueCreateInput
        submissions.push(input)
        saved = taskQueue({ id: "tq_new_draft", directory, title: "Saved next batch", tasks: input.tasks.map((task, index) => ({
          ...taskQueue().tasks[0], ...task, title: taskDraftName(task), id: `tqt_saved_${index}`,
        })) })
        return json({ data: saved })
      }
      if (url.pathname === "/api/task-queue") { if (armed) receipt.resolve(); return json({ data: saved ? [info, saved] : [info] }) }
      if (saved && url.pathname === `/api/task-queue/${saved.id}`) return json({ data: saved })
      if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
      if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
        const method = url.pathname.split("/").at(-1)!
        controls.push(method)
        info = { ...info, status: method === "stop" ? "stopped" : "running", currentTaskID: info.tasks[0].id, time: { created: 1, updated: 2 } }
        return json({ data: info })
      }
      return sessionResponse(url, [first], visited)
    } })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app, info.title!)
    app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("执行中") && !frame.includes("正在处理"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
    await app.mockInput.pasteBracketedText(text)
    const editor = app.renderer.currentFocusedEditor
    if (stage !== "edit") {
      app.mockInput.pressKey("s", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("新建批次"))
      app.mockInput.pressKey("r", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("创建前预览") && frame.includes("第二行不能丢失"))
    }
    if (stage === "list") {
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("新建批次"))
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    }
    info = { ...info, tasks: [{ ...info.tasks[0], sessionID: first.id, status: "running" }], time: { created: 1, updated: 3 } }
    armed = true
    app.events.emit({ id: "evt_new_draft_session", created: 3, type: "taskqueue.updated", data: info })
    // A second event causes an observable HTTP receipt after the update has been handled.
    app.events.emit({ id: "evt_new_draft_barrier", type: "server.connected", data: {} })
    await sourceSignal(receipt.promise)
    await app.renderOnce()
    expect(visited).toEqual([])
    expect(controls).toEqual([action])
    expect(submissions).toEqual([])
    if (stage === "edit") {
      expect(app.renderer.currentFocusedEditor).toBe(editor)
      expect(app.renderer.currentFocusedEditor?.plainText).toBe(text)
      expect(app.captureCharFrame()).toContain("添加任务")
      app.mockInput.pressKey("s", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("新建批次"))
      app.mockInput.pressKey("r", { ctrl: true })
    }
    if (stage !== "list") {
      await app.waitForFrame((frame) => frame.includes("创建前预览") && frame.includes("第二行不能丢失"))
      app.mockInput.pressKey("s", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("Saved next batch") && frame.includes("待开始"))
      expect(submissions).toHaveLength(1)
      expect(submissions[0].tasks).toEqual([{ prompt: text }])
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
      await app.mockInput.typeText("Original delayed batch")
    } else {
      expect(app.captureCharFrame()).toContain("任务队列 / tasks")
    }
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("批次侧面板") && frame.includes(first.id))
    app.mockInput.pressKey("o", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes(first.title) && frame.includes("批次：Original delayed batch") && frame.includes("已暂停跟随"))
    expect(controls).toEqual([action])
  }
  expect(controls).toEqual([action, "stop"])
})

test.each(["start", "resume"] as const)("a real junction %s keeps canonical session navigation, the next session and same-identity drafts", async (action) => {
  takeDraft(undefined)
  await using root = await tmpdir()
  const target = path.join(root.path, "real")
  const alias = path.join(root.path, "alias")
  await mkdir(target)
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
  try {
    const canonical = await realpath(alias)
    expect(canonical).toBe(await realpath(target))
    expect(canonical).not.toBe(alias)
    const sessions = [1, 2].map((index) => ({ ...session(`ses_alias_${index}_${crypto.randomUUID()}`), title: `Canonical execution ${index}`, location: { directory: canonical } }))
    let info = taskQueue({ directory: canonical, title: "Junction follow batch", status: action === "start" ? "queued" : "stopped",
      tasks: sessions.map((_, index) => ({ ...taskQueue().tasks[0], id: `tqt_alias_${index}`, title: `Alias task ${index}`, position: index })) })
    const scopes: string[] = []
    const visited: string[] = []
    const controls: string[] = []
    const moved = Promise.withResolvers<void>()
    let moveArmed = false
    {
      await using app = await createAppFixture({ width: 160, height: 30, config, fetch: (url) => {
        if (url.pathname === "/api/location" || url.pathname === "/api/fs/list") {
          const value = url.searchParams.get("location[directory]") === canonical ? canonical : alias
          const location = { directory: value, project: { id: "proj_test", directory: value, canonical } }
          return json(url.pathname === "/api/location" ? location : { location, data: [] })
        }
        if (url.pathname === "/api/task-queue") { if (moveArmed) moved.resolve(); scopes.push(url.searchParams.get("directory")!); return json({ data: [info] }) }
        if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
        if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
          const method = url.pathname.split("/").at(-1)!
          controls.push(method)
          info = { ...info, status: method === "stop" ? "stopped" : "running", currentTaskID: info.tasks[0].id,
            tasks: info.tasks.map((task, index) => index ? task : { ...task, sessionID: sessions[0].id, status: "running" }), time: { created: 1, updated: 2 } }
          return json({ data: info })
        }
        return sessionResponse(url, sessions, visited)
      } })
      await app.ready
      // The initial Location request can finish after the home UI mounts.
      // Wait for its real path label before asserting the first list scope.
      await app.waitForFrame((frame) => frame.includes("commands") && frame.includes("alias"))
      await openTasks(app, info.title!)
      expect(scopes[0]).toBe(alias)
      app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes(sessions[0].title) && frame.includes("批次：Junction follow batch") && frame.includes("跟随执行中"))
      info = { ...info, currentTaskID: info.tasks[1].id, tasks: info.tasks.map((task, index) => index
        ? { ...task, sessionID: sessions[1].id, status: "running" } : { ...task, status: "completed" }), time: { created: 1, updated: 3 } }
      app.events.emit({ id: "evt_alias_second", created: 3, type: "taskqueue.updated", data: info })
      await app.waitForFrame((frame) => frame.includes(sessions[1].title) && frame.includes("批次：Junction follow batch") && frame.includes("跟随执行中"))
      expect(visited).toEqual(sessions.map((item) => item.id))
      await openTasks(app, info.title!)
      app.mockInput.pressKey("a", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("新建批次"))
      app.mockInput.pressKey("a", { ctrl: true })
      await app.waitForFrame((frame) => app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
      await app.mockInput.pasteBracketedText(text)
      const editor = app.renderer.currentFocusedEditor
      sessions[1] = { ...sessions[1], location: { directory: alias } }
      app.events.emit({ id: "evt_alias_spelling", created: 4, type: "session.moved", durable: { aggregateID: sessions[1].id, seq: 1, version: 1 },
        data: { sessionID: sessions[1].id, projectID: "proj_test", location: { directory: alias } } })
      await app.waitFor(() => {
        const label = app.renderer.root.findDescendantById("prompt.footer.location")
        return label instanceof TextRenderable && /[\\/]alias$/.test(label.plainText)
      })
      moveArmed = true
      app.events.emit({ id: "evt_alias_moved_barrier", type: "server.connected", data: {} })
      await sourceSignal(moved.promise)
      await app.renderOnce()
      expect(scopes.at(-1)).toBe(alias)
      expect(app.renderer.currentFocusedEditor).toBe(editor)
      expect(editor?.plainText).toBe(text)
      expect(app.captureCharFrame()).toContain("添加任务")
      expect(controls).toEqual([action])
    }
    expect(controls).toEqual([action, "stop"])
  } finally {
    await unlink(alias)
  }
})

test.each([
  ["event", 160], ["list", 160], ["empty", 160], ["delete", 160], ["close", 160], ["close", 44],
] as const)("same-URL refresh list failure preserves intent until current %s confirmation at %s columns", async (recovery, width) => {
  takeDraft(undefined)
  const sessions = [1, 2, 3].map((index) => ({ ...session(`ses_retry_${index}_${crypto.randomUUID()}`), title: `Recovered execution ${index}` }))
  let info = taskQueue({ directory, title: "Recoverable batch", tasks: sessions.map((_, index) => ({ ...taskQueue().tasks[0], id: `tqt_retry_${index}`, title: `Retry task ${index}` })) })
  const oldEvents = createEventStream()
  const events = createEventStream()
  const requested = Promise.withResolvers<void>()
  const detailRequested = Promise.withResolvers<void>()
  const oldDetail = Promise.withResolvers<Response>()
  const absentReceipt = Promise.withResolvers<void>()
  const failure = Promise.withResolvers<Response>()
  const controls: string[] = []
  const visited: string[] = []
  const rejected: string[] = []
  let endpoint = ""
  let refreshed = false
  let failed = false
  let empty = false
  let checkingAbsence = false
  const auth = (password: string) => ({ type: "basic", username: "fixture", password } as const)
  const calls = createFetch((url, request) => {
    if (url.pathname === "/api/event") {
      if (request.headers.get("authorization") === "Basic " + Buffer.from("fixture:old").toString("base64")) {
        return oldEvents.v2()
      }
      return events.v2()
    }
    if (url.pathname.startsWith("/api/task-queue")) {
      const expected = "Basic " + Buffer.from(`fixture:${refreshed ? "new" : "old"}`).toString("base64")
      if (request.headers.get("authorization") !== expected) { rejected.push(url.pathname); return new Response(null, { status: 401 }) }
    }
    if (url.pathname === "/api/task-queue") {
      if (refreshed && !failed) { failed = true; requested.resolve(); return failure.promise }
      if (checkingAbsence) absentReceipt.resolve()
      return json({ data: empty ? [] : [info] })
    }
    if (url.pathname === `/api/task-queue/${info.id}`) {
      if (request.method === "DELETE") { controls.push("delete"); empty = true; return new Response(null, { status: 204 }) }
      if (!refreshed) { detailRequested.resolve(); return oldDetail.promise }
      return json({ data: info })
    }
    if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
      const method = url.pathname.split("/").at(-1)!
      controls.push(`${refreshed ? "new" : "old"}:${method}`)
      info = { ...info, status: method === "stop" ? "stopped" : "running", currentTaskID: info.tasks[0].id,
        tasks: info.tasks.map((task, index) => index ? task : { ...task, sessionID: sessions[0].id, status: "running" }), time: { created: 1, updated: 2 } }
      return json({ data: info })
    }
    return sessionResponse(url, sessions, visited)
  })
  try {
    {
      await using app = await createAppFixture({ width, height: 30, config, auth: auth("old"),
        service: { reconnect: async () => { refreshed = true; return { url: endpoint, auth: auth("new") } }, restart: async () => {} },
        fetch: (url, request) => { endpoint = `${url.origin}/`; return calls.fetch(request) } })
      try {
      await app.ready
      await app.waitForFrame((frame) => frame.includes("commands"))
      await openTasks(app, info.title!)
      app.mockInput.pressEnter()
      await sourceSignal(detailRequested.promise)
      await app.waitForFrame((frame) => frame.includes("rounds"))
      app.mockInput.pressKey("s", { ctrl: true })
      await app.waitFor(() => visited.includes(sessions[0].id))
      await app.waitForFrame((frame) => frame.includes("跟随执行中"))
      app.events.disconnect()
      oldEvents.disconnect()
      await sourceSignal(requested.promise)
      await app.waitForFrame((frame) => frame.includes("正在加载批次"))
      failure.resolve(new Response("transient list outage", { status: 503 }))
      await app.waitForFrame((frame) => frame.includes("无法访问任务队列") && !!app.renderer.root.findDescendantById("session-panel"))
      const stale = { ...info, title: "Obsolete credential receipt", currentTaskID: info.tasks[2].id,
        tasks: info.tasks.map((task, index) => index === 2 ? { ...task, sessionID: sessions[2].id, status: "running" as const } : task), time: { created: 1, updated: 99 } }
      // This real old-SDK HTTP response must not refill the refreshed feed.
      // Exact stale SSE source rejection is also covered by tasks-panel-source.
      oldDetail.resolve(json({ data: stale }))
      await app.renderOnce()
      expect(app.captureCharFrame()).not.toContain(stale.title!)
      expect(visited).not.toContain(sessions[2].id)
      if (recovery === "close") {
        if (width === 160) {
          app.mockInput.pressKey("x", { ctrl: true })
          app.mockInput.pressArrow("right")
        }
        await app.waitFor(() => app.renderer.currentFocusedRenderable?.id === "session-panel")
        app.mockInput.pressEscape()
        await app.waitForFrame(() => !app.renderer.root.findDescendantById("session-panel"))
      }
      info = { ...info, currentTaskID: info.tasks[1].id, tasks: info.tasks.map((task, index) => index === 1
        ? { ...task, sessionID: sessions[1].id, status: "running" } : { ...task, status: index ? "pending" : "completed" }), time: { created: 1, updated: 3 } }
      if (recovery === "empty") empty = true
      if (recovery === "event" || recovery === "delete" || recovery === "close") events.emit({ id: "evt_retry_next", created: 3, type: "taskqueue.updated", data: info })
      if (recovery === "list" || recovery === "empty") events.emit({ id: "evt_retry_list", type: "server.connected", data: {} })
      if (recovery === "event" || recovery === "list" || recovery === "delete") {
        await app.waitForFrame((frame) => frame.includes(sessions[1].title) && frame.includes("批次：Recoverable batch") && frame.includes("跟随执行中"))
        expect(app.captureCharFrame()).not.toContain("无法访问任务队列")
      }
      if (recovery === "delete") {
        info = { ...info, status: "done", time: { created: 1, updated: 4 } }
        events.emit({ id: "evt_retry_done", created: 4, type: "taskqueue.updated", data: info })
        await app.waitForFrame((frame) => frame.includes("本批处理结束"))
        await openTasks(app, info.title!)
        app.mockInput.pressKey("x", { ctrl: true })
        await app.waitForFrame((frame) => frame.includes("删除批次？"))
        app.mockInput.pressKey("x", { ctrl: true })
        await app.waitForFrame((frame) => frame.includes("暂无批次"))
        app.mockInput.pressEscape()
      }
      if (recovery === "empty" || recovery === "delete") {
        await app.waitForFrame(() => !app.renderer.root.findDescendantById("session-panel"))
        events.emit({ id: "evt_after_absence", created: 5, type: "taskqueue.updated", data: { ...info, time: { created: 1, updated: 5 } } })
        // Establish the authoritative empty read after the event, rather than
        // racing /tasks' own refresh against the transient event snapshot.
        checkingAbsence = true
        events.emit({ id: "evt_absence_barrier", type: "server.connected", data: {} })
        await sourceSignal(absentReceipt.promise)
        await openTasks(app, "暂无批次")
        app.mockInput.pressEscape()
        await app.waitForFrame(() => !app.renderer.root.findDescendantById("session-panel"))
        if (recovery === "empty") expect(visited).not.toContain(sessions[1].id)
      }
      if (recovery === "close") {
        await openTasks(app, info.title!)
        app.mockInput.pressEscape()
        await app.waitForFrame(() => !app.renderer.root.findDescendantById("session-panel"))
        expect(visited).not.toContain(sessions[1].id)
      }
      expect(controls).toEqual(recovery === "delete" ? ["old:start", "delete"] : ["old:start"])
      expect(rejected).toEqual([])
      expect(visited).not.toContain(sessions[2].id)
      } finally {
        failure.resolve(new Response(null, { status: 503 }))
        oldDetail.resolve(json({ data: info }))
      }
    }
    expect(controls).toEqual(recovery === "delete" ? ["old:start", "delete"] : ["old:start", "new:stop"])
  } finally {
    failure.resolve(new Response(null, { status: 503 }))
    oldDetail.resolve(json({ data: info }))
    events.disconnect()
    oldEvents.disconnect()
  }
})

async function openTasks(app: Awaited<ReturnType<typeof createAppFixture>>, title: string) {
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && frame.includes(title) && app.renderer.currentFocusedEditor instanceof InputRenderable)
}

function sessionResponse(url: URL, sessions: ReturnType<typeof session>[], visited: string[]) {
  const item = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
  if (item) { visited.push(item.id); return json({ data: item }) }
  if (sessions.some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
  if (sessions.some((item) => url.pathname === `/api/session/${item.id}/inbox`)) return json({ data: [] })
  return undefined
}
