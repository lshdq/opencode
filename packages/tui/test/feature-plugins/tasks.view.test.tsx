import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import type { ExperimentalTaskQueueCreateInput } from "@opencode/client"
import { createAppFixture } from "../fixture/app"
import { taskQueue } from "../fixture/task-queue"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { TaskEditor, TaskQueueDetail, TaskQueuePreview } from "../../src/feature-plugins/system/tasks"
import { DialogPrompt } from "../../src/ui/dialog-prompt"
import { renderLocal, session } from "../fixture/local"
import { mkdir, realpath, symlink, unlink } from "node:fs/promises"
import path from "node:path"
import stringWidth from "string-width"
import { tmpdir } from "../fixture/fixture"

test.each([100, 44])("global /tasks creates three multi-line tasks, previews/reorders, survives panel close, and stops on TUI exit at width %s", async (width) => {
  takeDraft(undefined)
  const created: ExperimentalTaskQueueCreateInput[] = []
  const stopped: string[] = []
  let info = taskQueue({ directory })
  let deleted = false
  {
    await using app = await createAppFixture({ width, height: 24, config: { animations: false, tabs: { mode: "off" } }, fetch: async (url, request) => {
      if (url.pathname === "/api/experimental/task-queue" && request.method === "GET") return json({ data: created.length && !deleted ? [info] : [] })
      if (url.pathname === "/api/experimental/task-queue" && request.method === "POST") {
        const input = await request.json() as ExperimentalTaskQueueCreateInput
        created.push(input)
        info = taskQueue({ directory, title: input.title, tasks: input.tasks.map((task, index) => ({
          ...taskQueue().tasks[0], ...task, id: `tqt_${index}`, position: index,
        })) })
        return json({ data: info })
      }
      if (url.pathname === `/api/experimental/task-queue/${info.id}`) {
        if (request.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }) }
        return json({ data: info })
      }
      if (url.pathname.endsWith(`/${info.id}/start`)) {
        info = { ...info, status: "running", currentTaskID: info.tasks[0].id, time: { created: 1, updated: 2 } }
        return json({ data: info })
      }
      if (url.pathname.endsWith(`/${info.id}/stop`)) {
        stopped.push((await request.json() as { reason: string }).reason)
        return json({ data: { ...info, status: "stopped" } })
      }
      return undefined
    } })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.mockInput.typeText("/tasks")
    await app.waitForFrame((frame) => frame.includes("Task queues"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("暂无批次") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    app.mockInput.pressKey("t", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("批次标题（可选）") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await app.mockInput.typeText("三项批次")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("新建批次：三项批次"))
    for (const index of [1, 2, 3]) {
      app.mockInput.pressKey("a", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.currentFocusedEditor?.id === "task-queue-title")
      if (index === 1) {
        app.mockInput.pressKey("s", { ctrl: true })
        await app.waitForFrame((frame) => frame.includes("请填写任务标题") && frame.includes("保存 ctrl+s"))
      }
      await app.mockInput.typeText(`任务${index}`)
      app.mockInput.pressTab()
      await app.waitFor(() => app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
      expect(app.renderer.currentFocusedEditor).toBeInstanceOf(TextareaRenderable)
      await app.mockInput.pasteBracketedText(`第一行-${index}\n第二行-${index}`)
      app.mockInput.pressEnter()
      await app.mockInput.typeText(`第三行-${index}`)
      app.mockInput.pressKey("s", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("新建批次") && frame.includes(`任务${index}`))
    }
    app.mockInput.pressArrow("up", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressArrow("down", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressArrow("up", { ctrl: true })
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("编辑任务") && app.renderer.currentFocusedEditor?.plainText === "任务3")
    app.mockInput.pressTab()
    await app.waitFor(() => app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
    expect(app.renderer.currentFocusedEditor?.plainText).toBe("第一行-3\n第二行-3\n第三行-3")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次：三项批次"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.currentFocusedEditor?.id === "task-queue-title")
    await app.mockInput.typeText("待移除任务")
    app.mockInput.pressTab()
    await app.waitFor(() => app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
    await app.mockInput.typeText("不会发送到服务端")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("待移除任务") && frame.includes("新建批次"))
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitForFrame((frame) => !frame.includes("待移除任务") && frame.includes("新建批次"))
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建前预览") && frame.includes("第一行-1"))
    expect(app.captureCharFrame()).toContain("暂不开始")
    app.mockInput.pressKey("\x1b[6~")
    await app.waitForFrame((frame) => frame.includes("第三行-2"))
    const preview = app.captureCharFrame()
    expect(preview.indexOf("任务3")).toBeLessThan(preview.indexOf("任务2"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("待开始"))
    expect(created).toHaveLength(1)
    expect(created[0].title).toBe("三项批次")
    expect(created[0].tasks.map((task) => task.title)).toEqual(["任务1", "任务3", "任务2"])
    expect(created[0].tasks.map((task) => task.prompt)).toEqual([1, 3, 2].map((index) => `第一行-${index}\n第二行-${index}\n第三行-${index}`))
    expect(info.status).toBe("queued")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("执行中"))
    app.mockInput.pressArrow("down")
    app.mockInput.pressArrow("up")
    await app.waitForFrame((frame) => frame.includes("▶"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("任务队列 / tasks"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("commands") && !frame.includes("任务队列 / tasks"))
    expect(stopped).toHaveLength(0)
    // An unrelated Location event must not appear when the panel is reopened.
    app.events.emit({ id: "evt_other_queue", created: 3, type: "taskqueue.updated", data: taskQueue({ directory: "/other", title: "Secret other location" }) })
    await app.mockInput.typeText("/tasks")
    await app.waitForFrame((frame) => frame.includes("Task queues"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("执行中") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.events.emit({ id: "evt_other_queue_open", created: 4, type: "taskqueue.updated", data: taskQueue({ directory: "/other", title: "Secret other location" }) })
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Secret other location")
    expect(stopped).toHaveLength(0)
  }
  expect(stopped).toHaveLength(1)
  expect(stopped[0]).toContain("TUI 已退出")
})

test.each([100, 44])("real detail updates and truthful done/blocked summary at width %s", async (width) => {
  takeDraft(undefined)
  let info = taskQueue({ directory, status: "done", title: "Mixed results", tasks: [
    { ...taskQueue().tasks[0], title: "Completed task", status: "completed", summary: "Saved files", sessionID: "ses_task" },
    { ...taskQueue().tasks[0], id: "tqt_blocked", title: "Blocked task", status: "blocked", reason: "Missing credential", rounds: 2 },
  ] })
  let resumed = 0
  await using app = await createAppFixture({ width, height: 24, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } }, fetch: (url) => {
    if (url.pathname === "/api/experimental/task-queue") return json({ data: [info] })
    if (url.pathname.endsWith(`/${info.id}/resume`)) { resumed++; info = { ...info, status: "running" }; return json({ data: info }) }
    if (url.pathname.endsWith(`/${info.id}/stop`)) return json({ data: { ...info, status: "stopped" } })
    if (url.pathname === `/api/experimental/task-queue/${info.id}`) return json({ data: info })
    if (url.pathname === "/api/session/ses_task") return json({ data: {
      id: "ses_task", title: "Associated session", projectID: "proj_test", location: { directory },
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 },
    } })
    if (url.pathname === "/api/session/ses_task/message") return json({ data: [], cursor: {} })
    if (["/api/session/ses_task/inbox", "/api/session/ses_task/permission"].includes(url.pathname)) return json({ data: [] })
    return undefined
  } })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Mixed results") && app.renderer.currentFocusedEditor instanceof InputRenderable)
  app.mockInput.pressEnter()
   await app.waitForFrame((frame) => frame.includes("本批处理结束") && frame.includes("完成 1"))
  const frame = app.captureCharFrame()
  expect(frame).toContain("完成 1")
  expect(frame).toContain("阻塞 1")
  expect(frame).toContain("手动续办")
   expect(frame).not.toContain("全部成功")
   app.mockInput.pressArrow("down")
   await app.waitForFrame((frame) => frame.includes("Missing credential") && frame.includes("rounds 2"))
   expect(app.captureCharFrame()).toContain("手动续办")
   app.mockInput.pressArrow("up")
   await app.waitForFrame((frame) => frame.includes("Saved files") && frame.includes("ses_task"))
   app.mockInput.pressKey("\x1b[5~")
   await app.waitForFrame((frame) => frame.includes("本批处理结束"))
  app.mockInput.pressKey("e", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("执行中"))
  expect(resumed).toBe(1)
  info = { ...info, status: "stopped", reason: "Lease stopped", time: { created: 1, updated: 20 } }
  app.events.emit({ id: "evt_queue_stop", created: 20, type: "taskqueue.updated", data: info })
  await app.waitForFrame((frame) => frame.includes("Lease stopped") && frame.includes("已停止"))
  // Session navigation uses the real association, not a fabricated new Session.
  app.mockInput.pressEnter()
   await app.waitForFrame((frame) => frame.includes("Associated session") && !frame.includes("Mixed results"))
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Mixed results") && app.renderer.currentFocusedEditor instanceof InputRenderable)
})

test("403 is a friendly empty state and does not crash the global command", async () => {
  takeDraft(undefined)
  await using app = await createAppFixture({ fetch: (url) => url.pathname.startsWith("/api/experimental/task-queue")
    ? json({ _tag: "ForbiddenError", message: "task_queue disabled" }, { status: 403 }) : undefined })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("experimental.task_queue"))
})

test("closing the panel and exiting during an in-flight start stops its late successful batch once", async () => {
  takeDraft(undefined)
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const stops: string[] = []
  let heartbeats = 0
  const info = taskQueue({ directory })
  const app = await createAppFixture({ config: { animations: false, tabs: { mode: "off" } }, fetch: async (url, request) => {
    if (url.pathname === "/api/experimental/task-queue") return json({ data: [info] })
    if (url.pathname.endsWith(`/${info.id}/start`)) { requested.resolve(); return response.promise }
    if (url.pathname.endsWith(`/${info.id}/heartbeat`)) { heartbeats++; return json({ data: { ...info, status: "running" } }) }
    if (url.pathname.endsWith(`/${info.id}/stop`)) {
      stops.push((await request.json() as { reason: string }).reason)
      return json({ data: { ...info, status: "stopped" } })
    }
    return undefined
  } })
  let closing: Promise<void> | undefined
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.mockInput.typeText("/tasks")
    await app.waitForFrame((frame) => frame.includes("Task queues"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Fixture batch") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("正在处理"))
    await requested.promise
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("commands") && !frame.includes("任务队列 / tasks"))
    expect(stops).toEqual([])
    closing = app[Symbol.asyncDispose]()
    response.resolve(json({ data: { ...info, status: "running" } }))
    await closing
    expect(stops).toHaveLength(1)
    expect(stops[0]).toContain("TUI 已退出")
    expect(heartbeats).toBe(0)
  } finally {
    response.resolve(json({ data: { ...info, status: "running" } }))
    await (closing ?? app[Symbol.asyncDispose]())
  }
})

test("viewing another TUI's running queue neither adopts ownership nor polls on frames", async () => {
  takeDraft(undefined)
  const info = taskQueue({ directory, status: "running" })
  const requests: string[] = []
  {
    await using app = await createAppFixture({ config: { animations: false, tabs: { mode: "off" } }, fetch: (url) => {
      if (!url.pathname.startsWith("/api/experimental/task-queue")) return undefined
      requests.push(url.pathname)
      if (url.pathname === "/api/experimental/task-queue") return json({ data: [info] })
      if (url.pathname === `/api/experimental/task-queue/${info.id}`) return json({ data: info })
      return json({ data: { ...info, status: "stopped" } })
    } })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.mockInput.typeText("/tasks")
    await app.waitForFrame((frame) => frame.includes("Task queues"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("执行中") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Fixture batch") && frame.includes("rounds"))
    const reads = requests.length
    for (const _ of [1, 2, 3, 4]) await app.renderOnce()
    expect(requests).toHaveLength(reads)
  }
  expect(requests.filter((path) => /\/(heartbeat|stop|resume|start)$/.test(path))).toEqual([])
})

test("non-running deletion is confirmed, preserves sessions, and returns to the empty list", async () => {
  takeDraft(undefined)
  const info = taskQueue({ directory, status: "stopped" })
  let removed = false
  const deleted: string[] = []
  await using app = await createAppFixture({ config: { animations: false, tabs: { mode: "off" } }, fetch: (url, request) => {
    if (url.pathname === "/api/experimental/task-queue") return json({ data: removed ? [] : [info] })
    if (request.method === "DELETE") {
      deleted.push(url.pathname)
      removed = true
      return new Response(null, { status: 204 })
    }
    return undefined
  } })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Fixture batch") && app.renderer.currentFocusedEditor instanceof InputRenderable)
  app.mockInput.pressKey("x", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("删除批次？") && frame.includes("任务会话和文件改动保留"))
  expect(deleted).toEqual([])
  app.mockInput.pressKey("x", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("暂无批次"))
  expect(deleted).toEqual([`/api/experimental/task-queue/${info.id}`])
})

test.each(["editor", "preview", "detail"] as const)("unmounted task %s keymap does not act on an unrelated modal", async (view) => {
  // TC-015/017: exercise the real components' raw Keymap layers, not a visual copy.
  await using app = await renderLocal()
  let actions = 0
  const act = () => { actions++ }
  app.dialog.replace(() => view === "editor"
    ? <TaskEditor task={{ title: "Valid task", prompt: "完整描述\n第二行" }} onSave={act} onBack={() => {}} />
    : view === "preview"
      ? <TaskQueuePreview title="Preview" tasks={[{ title: "Task", prompt: "Text" }]} busy={false} onCreate={act} onBack={() => {}} />
      : <TaskQueueDetail info={taskQueue({ status: "running" })} busy={false} onBack={() => {}} onStart={act} onResume={act} onStop={act} onSession={act} />)
  await app.renderOnce()
  app.mockInput.pressKey(view === "detail" ? "x" : "s", { ctrl: true })
  await app.renderOnce()
  expect(actions).toBe(1)
  app.dialog.replace(() => <DialogPrompt title="Unrelated modal" onCancel={() => {}} onConfirm={() => {}} />)
  await app.renderOnce()
  app.mockInput.pressKey("s", { ctrl: true })
  app.mockInput.pressKey("x", { ctrl: true })
  app.mockInput.pressKey("e", { ctrl: true })
  await app.renderOnce()
  expect(actions).toBe(1)
  expect(app.captureCharFrame()).toContain("Unrelated modal")
})

test("global tasks works from a session route and a running owned queue survives real session navigation", async () => {
  takeDraft(undefined)
  const existing = { ...session("ses_existing"), title: "Existing session route" }
  const associated = { ...session("ses_owned"), title: "Queue task session" }
  let info = taskQueue({ directory, tasks: [{ ...taskQueue().tasks[0], sessionID: associated.id }] })
  const stops: string[] = []
  let starts = 0
  {
    await using app = await createAppFixture({ width: 44, height: 24,
      args: { sessionID: existing.id }, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } },
      fetch: async (url, request) => {
        if (url.pathname === "/api/experimental/task-queue") return json({ data: [info] })
        if (url.pathname === `/api/experimental/task-queue/${info.id}`) return json({ data: info })
        if (url.pathname.endsWith(`/${info.id}/start`)) {
          starts++
          info = { ...info, status: "running", currentTaskID: info.tasks[0].id }
          return json({ data: info })
        }
        if (url.pathname.endsWith(`/${info.id}/stop`)) {
          stops.push((await request.json() as { reason: string }).reason)
          return json({ data: { ...info, status: "stopped" } })
        }
        if (url.pathname.endsWith(`/${info.id}/heartbeat`)) return json({ data: info })
        const target = [existing, associated].find((item) => url.pathname === `/api/session/${item.id}`)
        if (target) return json({ data: target })
        if ([existing, associated].some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
        if ([existing, associated].some((item) => url.pathname === `/api/session/${item.id}/inbox`)) return json({ data: [] })
        return undefined
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes(existing.title))
    await app.mockInput.typeText("/tasks")
    await app.waitForFrame((frame) => frame.includes("Task queues"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("待开始") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("执行中"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("▶") && frame.includes("停止"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes(associated.title) && !frame.includes("Fixture batch"))
    expect(starts).toBe(1)
    expect(stops).toEqual([])
    await app.mockInput.typeText("/tasks")
    await app.waitForFrame((frame) => frame.includes("Task queues"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("执行中"))
    expect(stops).toEqual([])
  }
  expect(stops).toHaveLength(1)
  expect(stops[0]).toContain("TUI 已退出")
})

test.each([100, 44])("long mixed-result content keeps footer controls and failed-task reasons keyboard-accessible at %s columns", async (width) => {
  await using app = await renderLocal()
  app.resize(width, 24)
  let resumed = 0
  const info = taskQueue({ status: "done", reason: "批次的详细处理说明；".repeat(60), tasks: [
    { ...taskQueue().tasks[0], status: "completed", summary: "完成摘要" },
    { ...taskQueue().tasks[0], id: "tqt_blocked", status: "blocked", reason: "阻塞原因" },
    { ...taskQueue().tasks[0], id: "tqt_failed", title: "Failed task", status: "failed", reason: "失败原因可见", summary: "失败摘要可见", rounds: 3 },
  ] })
  app.dialog.replace(() => <TaskQueueDetail info={info} busy={false} onBack={() => {}} onStart={() => {}}
    onResume={() => { resumed++ }} onStop={() => {}} onSession={() => {}} />)
  app.dialog.setSize("large")
  app.dialog.setCentered(true)
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("手动续办")
  expect(app.captureCharFrame()).not.toContain("全部成功")
  app.mockInput.pressArrow("down")
  app.mockInput.pressArrow("down")
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("失败原因可见")
  expect(app.captureCharFrame()).toContain("失败摘要可见")
  expect(app.captureCharFrame()).toContain("rounds 3")
  expect(app.captureCharFrame()).toContain("手动续办")
  app.mockInput.pressKey("e", { ctrl: true })
  await app.renderOnce()
  expect(resumed).toBe(1)
})

test("an ordinary session route never starts queue requests or acquires exit ownership", async () => {
  // Control for app teardown with horizontal tabs, without ever opening /tasks.
  const ordinary = { ...session("ses_ordinary"), title: "Ordinary session control" }
  const queueRequests: string[] = []
  {
    await using app = await createAppFixture({ width: 44, height: 24,
      args: { sessionID: ordinary.id }, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } },
      fetch: (url) => {
        if (url.pathname.startsWith("/api/experimental/task-queue")) queueRequests.push(url.pathname)
        if (url.pathname === `/api/session/${ordinary.id}`) return json({ data: ordinary })
        if (url.pathname === `/api/session/${ordinary.id}/message`) return json({ data: [], cursor: {} })
        if (url.pathname === `/api/session/${ordinary.id}/inbox`) return json({ data: [] })
        return undefined
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes(ordinary.title))
    expect(queueRequests).toEqual([])
  }
  expect(queueRequests).toEqual([])
})

test("a real directory junction supports scoped list, create, detail and start without accepting unrelated SSE", async () => {
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
    const location = { directory: alias, project: { id: "proj_alias", directory: alias, canonical: alias } }
    const existing = taskQueue({ directory: canonical, title: "Existing canonical batch" })
    let created = taskQueue({ id: "tq_alias_created", directory: canonical, title: "Created canonical batch" })
    const directories: string[] = []
    const started: string[] = []
    await using app = await createAppFixture({ width: 100, height: 30, config: { animations: false, tabs: { mode: "off" } }, fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/experimental/task-queue" && request.method === "GET") {
        directories.push(url.searchParams.get("directory") ?? "")
        return json({ data: [existing] })
      }
      if (url.pathname === "/api/experimental/task-queue" && request.method === "POST") {
        const input = await request.json() as ExperimentalTaskQueueCreateInput
        expect(input.directory).toBe(alias)
        // This is the server fixture resolving its request; production TUI code never realpaths remote paths.
        created = { ...created, directory: await realpath(input.directory), tasks: input.tasks.map((task, index) => ({
          ...taskQueue().tasks[0], ...task, id: `tqt_alias_${index}`, position: index + 1,
        })) }
        return json({ data: created })
      }
      if (url.pathname === `/api/experimental/task-queue/${existing.id}`) return json({ data: existing })
      if (url.pathname === `/api/experimental/task-queue/${created.id}`) return json({ data: created })
      if (url.pathname.endsWith(`/${created.id}/start`)) {
        started.push(created.id)
        created = { ...created, status: "running", currentTaskID: created.tasks[0].id, time: { created: 1, updated: 2 } }
        return json({ data: created })
      }
      if (url.pathname.endsWith(`/${created.id}/stop`)) return json({ data: { ...created, status: "stopped" } })
      return undefined
    } })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app)
    await app.waitForFrame((frame) => frame.includes(existing.title!))
    expect(directories.at(-1)).toBe(alias)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("rounds") && frame.includes(existing.title!))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("任务队列 / tasks"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    await addDraftTask(app, "Created through alias", "完整描述\n第二行")
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建前预览"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes(created.title!) && frame.includes("Created through alias") && frame.includes("待开始"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("执行中") && frame.includes("▶"))
    expect(started).toEqual([created.id])
    app.events.emit({ id: "evt_alias", created: 3, type: "taskqueue.updated", data: { ...created, reason: "Canonical SSE accepted", time: { created: 1, updated: 3 } } })
    app.events.emit({ id: "evt_other_alias", created: 4, type: "taskqueue.updated", data: taskQueue({ id: "tq_unrelated_alias", directory: path.join(root.path, "unrelated"), title: "Unrelated secret" }) })
    await app.waitForFrame((frame) => frame.includes("Canonical SSE accepted"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("任务队列 / tasks"))
    expect(app.captureCharFrame()).not.toContain("Unrelated secret")
  } finally {
    // Unlink only our known alias before the private root fixture cleans its real directory.
    await unlink(alias)
  }
})

test.each([
  ["escape/legacy", "escape", false], ["header/legacy", "header", false],
  ["footer/legacy", "footer", false], ["shortcut/legacy", "shortcut", false],
  ["escape/new-designs", "escape", true], ["header/new-designs", "header", true],
  ["footer/new-designs", "footer", true], ["shortcut/new-designs", "shortcut", true],
] as const)("creating locks editing, and %s close isolates a new draft from the old response", async (_, close, newDesigns) => {
  takeDraft(undefined)
  const requested = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<Response>()
  const submitted: ExperimentalTaskQueueCreateInput[] = []
  const refreshed = Promise.withResolvers<void>()
  let reads = 0
  const info = taskQueue({ directory, title: "Old created batch" })
  const next = taskQueue({ directory, id: "tq_next_draft", title: "New created batch" })
  await using app = await createAppFixture({ width: 44, height: 24, config: { animations: false, tabs: { mode: "off" }, experimental: { "new-designs": newDesigns } }, fetch: async (url, request) => {
    if (url.pathname === "/api/experimental/task-queue" && request.method === "GET") {
      if (++reads > 1) refreshed.resolve()
      return json({ data: [] })
    }
    if (url.pathname === "/api/experimental/task-queue" && request.method === "POST") {
      submitted.push(await request.json() as ExperimentalTaskQueueCreateInput)
      if (submitted.length === 1) { requested.resolve(); return reply.promise }
      return json({ data: { ...next, tasks: submitted[1].tasks.map((task) => ({ ...next.tasks[0], ...task })) } })
    }
    if (url.pathname === `/api/experimental/task-queue/${info.id}`) return json({ data: info })
    if (url.pathname === `/api/experimental/task-queue/${next.id}`) return json({ data: next })
    return undefined
  } })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app)
    await app.waitForFrame((frame) => frame.includes("暂无批次"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    await addDraftTask(app, "Original", "Original description\n第二行")
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建前预览"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建中，暂不能修改"))
    await requested.promise
    app.events.emit({ id: "evt_task_reconnected", type: "server.connected", data: {} })
    await refreshed.promise
    await app.waitForFrame((frame) => frame.includes("创建中，暂不能修改"))
    await clickTaskText(app, "返回修改")
    app.mockInput.pressKey("a", { ctrl: true })
    app.mockInput.pressKey("t", { ctrl: true })
    app.mockInput.pressKey("r", { ctrl: true })
    app.mockInput.pressEnter()
    app.mockInput.pressKey("s", { ctrl: true })
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("创建前预览")
    expect(app.captureCharFrame()).not.toContain("添加任务")
    expect(submitted).toHaveLength(1)
    if (close === "escape") app.mockInput.pressEscape()
    if (close === "header") await clickTaskText(app, "关闭", (line) => line.includes("创建前预览"))
    if (close === "footer") await clickTaskText(app, "关闭面板")
    if (close === "shortcut") app.mockInput.pressKey("w", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("commands") && !frame.includes("创建前预览"))
    await openTasks(app)
    await app.waitForFrame((frame) => frame.includes("暂无批次"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    await addDraftTask(app, "New user task", "新输入不会被旧响应清空")
    reply.resolve(json({ data: info }))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("New user task")
    expect(app.captureCharFrame()).not.toContain("Old created batch")
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建前预览") && frame.includes("New user task"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("New created batch"))
    expect(submitted.map((input) => input.tasks.map((task) => task.title))).toEqual([["Original"], ["New user task"]])
    expect(submitted[1].tasks[0].prompt).toBe("新输入不会被旧响应清空")
  } finally {
    reply.resolve(json({ data: info }))
  }
})

async function openTasks(app: Awaited<ReturnType<typeof createAppFixture>>) {
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable && !app.renderer.currentFocusedEditor.isDestroyed)
}

async function addDraftTask(app: Awaited<ReturnType<typeof createAppFixture>>, title: string, prompt: string) {
  app.mockInput.pressKey("a", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.currentFocusedEditor?.id === "task-queue-title")
  await app.mockInput.typeText(title)
  app.mockInput.pressTab()
  await app.waitFor(() => app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
  await app.mockInput.pasteBracketedText(prompt)
  app.mockInput.pressKey("s", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("新建批次") && frame.includes(title))
}

async function clickTaskText(app: Awaited<ReturnType<typeof createAppFixture>>, text: string, matches: (line: string) => boolean = () => true) {
  const lines = app.captureCharFrame().split("\n")
  const row = lines.findLastIndex((line) => line.includes(text) && matches(line))
  expect(row, app.captureCharFrame()).toBeGreaterThanOrEqual(0)
  app.renderer.clearSelection()
  await app.mockMouse.click(stringWidth(lines[row].slice(0, lines[row].indexOf(text))) + 1, row)
  await app.renderOnce()
}

test.each(["open", "reopened"] as const)("tasks uses the replacement URL and credentials for every operation with the panel %s", async (panel) => {
  takeDraft(undefined)
  const connected = Promise.withResolvers<void>()
  const events = createEventStream()
  const oldRequests: string[] = []
  const newRequests: string[] = []
  const auth = { type: "basic", username: "fixture", password: "replacement-only" } as const
  const expected = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  const rejected: string[] = []
  let migrating = false
  let deleted = false
  let info = taskQueue({ directory, title: "Replacement queue" })
  let created = taskQueue({ directory, id: "tq_replacement_created", title: "Replacement created" })
  const calls = createFetch(async (url, request) => {
    if (request.headers.get("authorization") !== expected) {
      rejected.push(url.pathname)
      return new Response(null, { status: 401 })
    }
    if (url.pathname === "/api/plugin") connected.resolve()
    if (!url.pathname.startsWith("/api/experimental/task-queue")) return undefined
    newRequests.push(`${request.method} ${url.pathname}`)
    if (url.pathname === "/api/experimental/task-queue" && request.method === "GET") return json({ data: deleted ? [] : [info] })
    if (url.pathname === "/api/experimental/task-queue" && request.method === "POST") {
      const input = await request.json() as ExperimentalTaskQueueCreateInput
      created = { ...created, tasks: input.tasks.map((task, index) => ({ ...created.tasks[0], ...task, id: `tqt_replacement_${index}` })) }
      return json({ data: created })
    }
    if (url.pathname === `/api/experimental/task-queue/${created.id}`) return json({ data: created })
    if (request.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }) }
    if (url.pathname.endsWith("/start") || url.pathname.endsWith("/resume")) info = { ...info, status: "running", time: { created: 1, updated: info.time.updated + 1 } }
    if (url.pathname.endsWith("/stop")) info = { ...info, status: "stopped", time: { created: 1, updated: info.time.updated + 1 } }
    return json({ data: info })
  }, events)
  const replacement = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  try {
    await using app = await createAppFixture({ width: 100, height: 30, config: { animations: false, tabs: { mode: "off" } },
      auth: { type: "basic", username: "fixture", password: "old-only" },
      service: { reconnect: async () => ({ url: replacement.url.toString(), auth }), restart: async () => {} },
      fetch: (url, request) => {
        if (!url.pathname.startsWith("/api/experimental/task-queue")) return undefined
        oldRequests.push(`${request.method} ${url.pathname}`)
        if (migrating) return new Response(null, { status: 503 })
        return json({ data: url.pathname === "/api/experimental/task-queue" ? [taskQueue({ directory, title: "Original endpoint queue" })] : taskQueue({ directory, title: "Original endpoint queue" }) })
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app)
    await app.waitForFrame((frame) => frame.includes("Original endpoint queue"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("rounds"))
    if (panel === "reopened") {
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("任务队列 / tasks"))
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("commands") && !frame.includes("任务队列 / tasks"))
    }
    const oldCount = oldRequests.length
    migrating = true
    app.events.disconnect()
    // This resolves only on the authenticated new service's plugin synchronization,
    // not merely when service.reconnect returns an endpoint.
    await connected.promise
    if (panel === "reopened") await openTasks(app)
    await app.waitForFrame((frame) => frame.includes("Replacement queue"))
    if (panel === "open") app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressKey("r", { ctrl: true })
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("rounds") && frame.includes("Replacement queue"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("执行中"))
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("已停止"))
    app.mockInput.pressKey("e", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("执行中"))
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("已停止"))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("删除批次？"))
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("暂无批次"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    await addDraftTask(app, "After migration", "只发送到新端点的完整描述")
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建前预览"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes(created.title!) && frame.includes("After migration"))
    expect(oldRequests).toHaveLength(oldCount)
    expect(rejected).toEqual([])
    expect(newRequests).toContain("GET /api/experimental/task-queue")
    expect(newRequests).toContain(`GET /api/experimental/task-queue/${info.id}`)
    expect(newRequests).toContain("POST /api/experimental/task-queue")
    expect(newRequests).toContain(`POST /api/experimental/task-queue/${info.id}/start`)
    expect(newRequests).toContain(`POST /api/experimental/task-queue/${info.id}/resume`)
    expect(newRequests.filter((request) => request.endsWith("/stop"))).toHaveLength(2)
    expect(newRequests).toContain(`DELETE /api/experimental/task-queue/${info.id}`)
  } finally {
    events.disconnect()
    await replacement.stop(true)
  }
})
