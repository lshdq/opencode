import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import stringWidth from "string-width"
import { createAppFixture } from "../fixture/app"
import { session } from "../fixture/local"
import { taskQueue } from "../fixture/task-queue"
import { sourceSignal } from "../fixture/task-queue-source"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"

// TC-003/005: use the real App and delayed HTTP response, not display.prepare().
test.each(["start", "resume"] as const)("a fast %s completed after closing /tasks still reveals its final result", async (action) => {
  takeDraft(undefined)
  const requested = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<Response>()
  const result = { ...session(`ses_final_${crypto.randomUUID()}`), title: "Fast final result route" }
  const initial = taskQueue({ directory, title: "Fast final batch", status: action === "start" ? "queued" : "stopped" })
  const final = { ...initial, status: "done" as const, currentTaskID: undefined,
    tasks: [{ ...initial.tasks[0], status: "completed" as const, sessionID: result.id, summary: "Final result persisted" }],
    time: { created: 1, updated: 4 } }
  const controls: string[] = []
  {
    await using app = await createAppFixture({ width: 160, height: 30, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } }, fetch: (url) => {
      if (url.pathname === "/api/task-queue") return json({ data: [initial] })
      if (url.pathname === `/api/task-queue/${initial.id}`) return json({ data: initial })
      if (url.pathname.startsWith(`/api/task-queue/${initial.id}/`)) {
        controls.push(url.pathname.split("/").at(-1)!)
        if (url.pathname.endsWith(`/${action}`)) { requested.resolve(); return reply.promise }
        return json({ data: { ...initial, status: "stopped" } })
      }
      if (url.pathname === `/api/session/${result.id}`) return json({ data: result })
      if (url.pathname === `/api/session/${result.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${result.id}/inbox`) return json({ data: [] })
      return undefined
    } })
    try {
      await app.ready
      await app.waitForFrame((frame) => frame.includes("commands"))
      await openTasks(app, initial.title!)
      app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
      await requested.promise
      await app.waitForFrame((frame) => frame.includes("正在处理"))
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("commands") && !frame.includes("任务队列 / tasks"))
      reply.resolve(json({ data: final }))
      await app.waitForFrame((frame) => frame.includes(result.title) && frame.includes("批次：Fast final batch") && frame.includes("Final result persisted"))
      expect(app.captureCharFrame()).toContain("1/1")
      expect(app.captureCharFrame()).toContain("本批处理结束")
      expect(app.renderer.currentFocusedEditor).toBeInstanceOf(TextareaRenderable)
    } finally {
      reply.resolve(json({ data: final }))
    }
  }
  expect(controls).toEqual([action])
})

// TC-004/005/007: a real close, diff panel replacement, or /new navigation must
// remain authoritative even when later task sessions arrive from the live feed.
test.each(["close", "diff", "leave"] as const)("real %s prevents subsequent task events from retaking the route or panel", async (choice) => {
  takeDraft(undefined)
  const sessions = [1, 2, 3].map((index) => ({ ...session(`ses_depart_${index}_${crypto.randomUUID()}`), title: `Departure session ${index}` }))
  let info = taskQueue({ directory, title: "Departure batch", tasks: sessions.map((_, index) => ({
    ...taskQueue().tasks[0], id: `tqt_depart_${index}`, title: `Departure task ${index + 1}`, position: index,
  })) })
  const visited: string[] = []
  const controls: string[] = []
  {
    await using app = await createAppFixture({ width: 160, height: 30,
      config: { animations: false, tabs: { mode: "on", layout: "horizontal" }, keybinds: { "diff.open": "f6" } }, fetch: (url) => {
        if (url.pathname === "/api/task-queue") return json({ data: [info] })
        if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
        if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
          const method = url.pathname.split("/").at(-1)!
          controls.push(method)
          info = { ...info, status: method === "stop" ? "stopped" : "running", currentTaskID: info.tasks[0].id,
            tasks: info.tasks.map((task, index) => index ? task : { ...task, sessionID: sessions[0].id, status: "running" }), time: { created: 1, updated: 2 } }
          return json({ data: info })
        }
        if (url.pathname === "/api/vcs/base") return json({ location: { directory }, data: { name: "main", ref: "refs/heads/main", source: "default" } })
        if (url.pathname === "/api/vcs/diff") return json({ location: { directory }, data: [] })
        const target = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
        if (target) { visited.push(target.id); return json({ data: target }) }
        if (sessions.some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
        if (sessions.some((item) => url.pathname === `/api/session/${item.id}/inbox`)) return json({ data: [] })
        return undefined
      } })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app, info.title!)
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes(sessions[0].title) && frame.includes("批次：Departure batch") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    if (choice === "close") await clickText(app, "收起 [esc]")
    if (choice === "diff") app.mockInput.pressKey("F6")
    if (choice === "leave") {
      await app.mockInput.typeText("/new")
      await app.waitForFrame((frame) => frame.includes("New session"))
      app.mockInput.pressEnter()
    }
    await app.waitForFrame((frame) => !frame.includes("批次：Departure batch") && (choice === "diff"
      ? app.renderer.currentFocusedRenderable?.id === "session-panel" : app.renderer.currentFocusedEditor instanceof TextareaRenderable))
    const panel = app.renderer.root.findDescendantById("session-panel")
    for (const index of [1, 2]) {
      info = { ...info, title: `Departure receipt ${index}`, currentTaskID: info.tasks[index].id,
        tasks: info.tasks.map((task, at) => at === index ? { ...task, status: "running", sessionID: sessions[index].id } : task),
        time: { created: 1, updated: index + 3 } }
      app.events.emit({ id: `evt_depart_${index}`, created: index + 3, type: "taskqueue.updated", data: info })
      // /tasks is also the observable receipt that the updated feed is usable.
      // Close it without choosing any view or acquiring ownership.
      if (choice === "diff") {
        app.mockInput.pressKey("x", { ctrl: true })
        app.mockInput.pressArrow("left")
        await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      }
      await openTasks(app, info.title!)
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => !frame.includes("任务队列 / tasks") && !frame.includes("批次："))
      expect(visited).not.toContain(sessions[index].id)
      expect(app.renderer.root.findDescendantById("session-panel")).toBe(panel)
      if (choice !== "leave") expect(app.captureCharFrame()).toContain(sessions[0].title)
      if (choice === "leave") expect(app.captureCharFrame()).toContain("New session")
      expect(controls).toEqual(["start"])
    }
  }
  expect(controls).toEqual(["start", "stop"])
})

test.each([160, 44])("task panel keyboard navigation and recovery preserve no-session safety at %s columns", async (width) => {
  takeDraft(undefined)
  const sessions = [1, 2].map((index) => ({ ...session(`ses_keys_${index}_${crypto.randomUUID()}`), title: `Keyboard execution ${index}` }))
  const base = taskQueue()
  const info = taskQueue({ directory, title: "Keyboard batch", status: "running", currentTaskID: "tqt_keys_2", tasks: [
    { ...base.tasks[0], id: "tqt_keys_1", title: "First keyboard task", status: "completed", sessionID: sessions[0].id },
    { ...base.tasks[0], id: "tqt_keys_2", title: "Second keyboard task", status: "running", sessionID: sessions[1].id },
    { ...base.tasks[0], id: "tqt_keys_3", title: "Pending keyboard task", status: "pending" },
  ] })
  const controls: string[] = []
  const visited: string[] = []
  await using app = await createAppFixture({ width, height: 30, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } }, fetch: (url) => {
    if (url.pathname === "/api/task-queue") return json({ data: [info] })
    if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
    if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) { controls.push(url.pathname); return json({ data: info }) }
    const target = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
    if (target) { visited.push(target.id); return json({ data: target }) }
    const transcript = sessions.findIndex((item) => url.pathname === `/api/session/${item.id}/message`)
    if (transcript >= 0) return json({ data: [{ id: `msg_keys_${transcript}`, type: "user", text: `Keyboard route ${transcript + 1}`, time: { created: 1 } }], cursor: {} })
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/inbox`)) return json({ data: [] })
    return undefined
  } })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await openTasks(app, info.title!)
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("批次侧面板"))
  app.mockInput.pressKey("o", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("批次：Keyboard batch") && frame.includes("已暂停跟随"))
  if (width === 160) {
    await app.waitFor(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await app.mockInput.typeText("kept draft")
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("kept draft")
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressArrow("right")
  }
  await app.waitFor(() => app.renderer.currentFocusedRenderable?.id === "session-panel")
  app.mockInput.pressArrow("down")
  app.mockInput.pressEnter()
  await app.renderOnce()
  expect(visited).toEqual([sessions[1].id])
  expect(controls).toEqual([])
  app.mockInput.pressArrow("up")
  app.mockInput.pressArrow("up")
  app.mockInput.pressEnter()
  await app.waitFor(() => visited.includes(sessions[0].id))
  await app.waitForFrame((frame) => frame.includes("已暂停跟随") && frame.includes("◉ 查看"))
  expect(visited).toContain(sessions[0].id)
  if (width === 160) {
    app.mockInput.pressKey("x", { ctrl: true })
    app.mockInput.pressArrow("right")
    await app.waitFor(() => app.renderer.currentFocusedRenderable?.id === "session-panel")
  }
  app.mockInput.pressKey("r")
  await app.waitForFrame((frame) => frame.includes("跟随执行中"))
  expect(app.renderer.root.findDescendantById("session-panel")?.width).toBe(width === 44 ? 44 : 80)
  expect(controls).toEqual([])
  await clickText(app, "收起 [esc]")
  await app.waitForFrame((frame) => frame.includes("Keyboard route 2") && !app.renderer.root.findDescendantById("session-panel") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  if (width === 160) expect(app.renderer.currentFocusedEditor?.plainText).toBe("kept draft")
})

// TC-006: refreshing credentials at the same endpoint must retain an already
// established follow intent, while all new queue controls use the new credential.
test("same-service credential refresh retains real active follow and its original owner's exit responsibility", async () => {
  takeDraft(undefined)
  const sessions = [1, 2].map((index) => ({ ...session(`ses_refresh_${index}_${crypto.randomUUID()}`), title: `Refreshed execution ${index}` }))
  let info = taskQueue({ directory, title: "Credential batch", tasks: sessions.map((_, index) => ({ ...taskQueue().tasks[0], id: `tqt_refresh_${index}`, title: `Credential task ${index + 1}` })) })
  const events = createEventStream()
  const refreshed = Promise.withResolvers<void>()
  const controls: string[] = []
  const rejected: string[] = []
  const auth = (password: string) => ({ type: "basic", username: "fixture", password } as const)
  let current = false
  let endpoint = ""
  const replacement = createFetch((url, request) => {
    // Activation-owned plugin clients can legitimately retain their old event
    // stream credential. Assert the refreshed queue resource, not those clients.
    if (url.pathname.startsWith("/api/task-queue")) {
      if (request.headers.get("authorization") !== "Basic " + Buffer.from("fixture:new-credential").toString("base64")) {
        rejected.push(url.pathname)
        return new Response(null, { status: 401 })
      }
    }
    if (url.pathname === "/api/task-queue") { refreshed.resolve(); return json({ data: [info] }) }
    if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
    if (url.pathname.endsWith(`/${info.id}/stop`)) { controls.push("new:stop"); return json({ data: { ...info, status: "stopped" } }) }
    const target = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
    if (target) return json({ data: target })
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/inbox`)) return json({ data: [] })
    return undefined
  }, events)
  try {
    await using app = await createAppFixture({ width: 160, height: 30, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } }, auth: auth("old-credential"),
      service: { reconnect: async () => { current = true; return { url: endpoint, auth: auth("new-credential") } }, restart: async () => {} },
      fetch: (url, request) => {
        endpoint = `${url.origin}/`
        if (current) return replacement.fetch(request)
        if (url.pathname === "/api/task-queue") return json({ data: [info] })
        if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
        if (url.pathname.endsWith(`/${info.id}/start`)) {
          controls.push("old:start")
          info = { ...info, status: "running", currentTaskID: info.tasks[0].id, tasks: info.tasks.map((task, index) => index ? task : { ...task, status: "running", sessionID: sessions[0].id }), time: { created: 1, updated: 2 } }
          return json({ data: info })
        }
        if (url.pathname === `/api/session/${sessions[0].id}`) return json({ data: sessions[0] })
        if (url.pathname === `/api/session/${sessions[0].id}/message`) return json({ data: [], cursor: {} })
        if (url.pathname === `/api/session/${sessions[0].id}/inbox`) return json({ data: [] })
        return undefined
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app, info.title!)
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes(sessions[0].title) && frame.includes("跟随执行中"))
    app.events.disconnect()
    await refreshed.promise
    await app.waitForFrame((frame) => frame.includes("批次：Credential batch") && frame.includes("跟随执行中"))
    info = { ...info, currentTaskID: info.tasks[1].id,
      tasks: info.tasks.map((task, index) => index ? { ...task, status: "running", sessionID: sessions[1].id } : { ...task, status: "completed" }), time: { created: 1, updated: 3 } }
    events.emit({ id: "evt_credential_next", created: 3, type: "taskqueue.updated", data: info })
    await app.waitForFrame((frame) => frame.includes(sessions[1].title) && frame.includes("跟随执行中"))
    expect(controls).toEqual(["old:start"])
  } finally {
    events.disconnect()
  }
  expect(controls).toEqual(["old:start", "new:stop"])
  expect(rejected).toEqual([])
})

test("moving the real active session to another directory rejects late old detail and task events", async () => {
  takeDraft(undefined)
  const destination = "/fixture/tasks-destination"
  let active = { ...session(`ses_moved_${crypto.randomUUID()}`), title: "Directory execution route" }
  const wrong = { ...session(`ses_wrong_${crypto.randomUUID()}`), title: "Wrong old-directory route" }
  const old = taskQueue({ directory, title: "Old directory batch" })
  const running = { ...old, status: "running" as const, currentTaskID: old.tasks[0].id,
    tasks: [{ ...old.tasks[0], status: "running" as const, sessionID: active.id }], time: { created: 1, updated: 2 } }
  const requested = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<Response>()
  const moved = Promise.withResolvers<void>()
  const scopes: string[] = []
  const visited: string[] = []
  const controls: string[] = []
  {
    await using app = await createAppFixture({ width: 160, height: 30, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } }, fetch: (url) => {
      if (url.pathname === "/api/task-queue") {
        const scope = url.searchParams.get("directory") ?? ""
        scopes.push(scope)
        if (scope === destination) { moved.resolve(); return json({ data: [] }) }
        return json({ data: [old] })
      }
      if (url.pathname === `/api/task-queue/${old.id}`) { requested.resolve(); return reply.promise }
      if (url.pathname.endsWith(`/${old.id}/start`)) { controls.push("start"); return json({ data: running }) }
      if (url.pathname.endsWith(`/${old.id}/stop`)) { controls.push("stop"); return json({ data: { ...running, status: "stopped" } }) }
      if (url.pathname === "/api/location" && url.searchParams.get("location[directory]") === destination)
        return json({ directory: destination, project: { id: "proj_destination", directory: destination, canonical: destination } })
      const target = [active, wrong].find((item) => url.pathname === `/api/session/${item.id}`)
      if (target) { visited.push(target.id); return json({ data: target }) }
      if ([active, wrong].some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
      if ([active, wrong].some((item) => url.pathname === `/api/session/${item.id}/inbox`)) return json({ data: [] })
      return undefined
    } })
    try {
      await app.ready
      await app.waitForFrame((frame) => frame.includes("commands"))
      await openTasks(app, old.title!)
      app.mockInput.pressEnter()
      await requested.promise
      await app.waitForFrame((frame) => frame.includes("rounds"))
      app.mockInput.pressKey("s", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes(active.title) && frame.includes("批次：Old directory batch"))
      active = { ...active, location: { directory: destination }, projectID: "proj_destination" }
      app.events.emit({ id: "evt_task_session_moved", created: 3, type: "session.moved",
        durable: { aggregateID: active.id, seq: 1, version: 1 },
        data: { sessionID: active.id, location: active.location, projectID: active.projectID } })
      await sourceSignal(moved.promise)
      await app.waitForFrame((frame) => !frame.includes("批次：") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      const stale = { ...running, title: "Late old directory receipt", tasks: [{ ...running.tasks[0], sessionID: wrong.id }], time: { created: 1, updated: 99 } }
      reply.resolve(json({ data: stale }))
      app.events.emit({ id: "evt_task_old_directory", created: 99, type: "taskqueue.updated", data: stale })
      await app.mockInput.typeText("/tasks")
      await app.waitForFrame((frame) => frame.includes("Task queues"))
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("暂无批次") && app.renderer.currentFocusedEditor instanceof InputRenderable)
      expect(app.captureCharFrame()).not.toContain(stale.title!)
      expect(scopes.at(-1)).toBe(destination)
      expect(visited).not.toContain(wrong.id)
      expect(controls).toEqual(["start"])
    } finally {
      reply.resolve(json({ data: running }))
    }
  }
  expect(controls).toEqual(["start", "stop"])
})

async function openTasks(app: Awaited<ReturnType<typeof createAppFixture>>, title: string) {
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && frame.includes(title) && app.renderer.currentFocusedEditor instanceof InputRenderable)
}

async function clickText(app: Awaited<ReturnType<typeof createAppFixture>>, text: string) {
  const lines = app.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.includes(text))
  expect(row, app.captureCharFrame()).toBeGreaterThanOrEqual(0)
  app.renderer.clearSelection()
  await app.mockMouse.click(stringWidth(lines[row].slice(0, lines[row].indexOf(text))) + 1, row)
  await app.renderOnce()
}
