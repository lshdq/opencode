import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import stringWidth from "string-width"
import { createAppFixture } from "../fixture/app"
import { renderLocal, session } from "../fixture/local"
import { taskQueue } from "../fixture/task-queue"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { TaskEditor, taskDraftName, type TaskDraft } from "../../src/feature-plugins/system/tasks"

test.each([100, 44])("single content editor rejects whitespace and retains pasted Chinese and Unicode at %s columns", async (width) => {
  await using app = await renderLocal()
  app.resize(width, 24)
  const saved: TaskDraft[] = []
  app.dialog.replace(() => <TaskEditor onSave={(task) => saved.push(task)} onBack={() => {}} />)
  await app.renderOnce()
  expect(app.renderer.currentFocusedEditor?.id).toBe("task-queue-prompt")
  expect(app.captureCharFrame()).not.toContain("任务标题")
  await app.mockInput.pasteBracketedText(" \n\t")
  app.mockInput.pressKey("s", { ctrl: true })
  await app.renderOnce()
  expect(saved).toEqual([])
  expect(app.captureCharFrame()).toContain("不能仅包含空白")
  const editor = app.renderer.currentFocusedEditor
  expect(editor).toBeInstanceOf(TextareaRenderable)
  if (!(editor instanceof TextareaRenderable)) throw new Error("Missing task content editor")
  editor.setText("")
  const prompt = "\n  中文任务😀\n保留  空格\n完整第二行\n"
  await app.mockInput.pasteBracketedText(prompt)
  app.mockInput.pressKey("s", { ctrl: true })
  await app.renderOnce()
  expect(saved).toEqual([{ prompt }])
  expect(taskDraftName(saved[0])).toBe("中文任务😀")
  expect(taskDraftName({ prompt: `\n${"😀".repeat(90)}\n完整内容` })).toBe(`${"😀".repeat(79)}…`)
  expect(taskDraftName({ prompt: " \r\u2028\u2029名称\r完整内容" })).toBe("名称")
  expect(taskDraftName({ title: "历史自定义标题", prompt })).toBe("历史自定义标题")
})

test("real split panel survives the dialog, follows tasks, pauses for mouse history, resumes, closes and reopens", async () => {
  takeDraft(undefined)
  const sessions = ["ses_one", "ses_two", "ses_three"].map((id, index) => ({ ...session(id), title: `Execution session ${index + 1}` }))
  let info = taskQueue({ directory, title: "并排任务", tasks: ["第一项", "第二项", "第三项"].map((title, index) => ({
    ...taskQueue().tasks[0], id: `tqt_${index + 1}`, title, position: index,
  })) })
  const controls: string[] = []
  const visited: string[] = []
  await using app = await createAppFixture({ width: 160, height: 32, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } }, fetch: (url) => {
    if (url.pathname === "/api/task-queue") return json({ data: [info] })
    if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
    if (url.pathname.endsWith(`/${info.id}/start`)) {
      controls.push("start")
      info = { ...info, status: "running", currentTaskID: info.tasks[0].id, time: { created: 1, updated: 2 } }
      return json({ data: info })
    }
    if (url.pathname.endsWith(`/${info.id}/stop`)) { controls.push("stop"); return json({ data: { ...info, status: "stopped" } }) }
    const target = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
    if (target) { visited.push(target.id); return json({ data: target }) }
    if (sessions.some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
    if (sessions.some((item) => ["inbox", "permission"].some((name) => url.pathname === `/api/session/${item.id}/${name}`))) return json({ data: [] })
    return undefined
  } })
  const emit = (revision: number) => app.events.emit({ id: `evt_batch_${revision}`, created: revision, type: "taskqueue.updated", data: { ...info, time: { created: 1, updated: revision } } })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await openTasks(app)
  app.mockInput.pressKey("s", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("执行中") && !frame.includes("正在处理"))
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => !frame.includes("任务队列 / tasks") && frame.includes("commands"))
  info = { ...info, tasks: info.tasks.map((task, index) => index === 0 ? { ...task, sessionID: sessions[0].id, status: "running" } : task) }
  emit(3)
  await app.waitForFrame((frame) => frame.includes(sessions[0].title) && frame.includes("批次：并排任务") && frame.includes("跟随执行中") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  expect(app.captureCharFrame()).toContain("▶ 执行")
  expect(app.captureCharFrame()).toContain("◉ 查看")
  info = { ...info, currentTaskID: info.tasks[1].id, tasks: info.tasks.map((task, index) => index === 0 ? { ...task, status: "completed", summary: "首项完成摘要" } : index === 1 ? { ...task, status: "running", sessionID: sessions[1].id } : task) }
  emit(4)
  await app.waitForFrame((frame) => frame.includes(sessions[1].title) && frame.includes("首项完成摘要"))
  await clickText(app, "1. 第一项")
  await app.waitForFrame((frame) => frame.includes(sessions[0].title) && frame.includes("已暂停跟随"))
  const before = visited.length
  await clickText(app, "3. 第三项")
  expect(visited).toHaveLength(before)
  info = { ...info, currentTaskID: info.tasks[2].id, tasks: info.tasks.map((task, index) => index === 1 ? { ...task, status: "failed", reason: "缺少凭据", summary: "失败摘要" } : index === 2 ? { ...task, status: "running", sessionID: sessions[2].id } : task) }
  emit(5)
  await app.waitForFrame((frame) => frame.includes("缺少凭据") && frame.includes(sessions[0].title) && frame.includes("已暂停跟随"))
  expect(visited).not.toContain(sessions[2].id)
  await clickText(app, "回到执行中 [r]")
  await app.waitForFrame((frame) => frame.includes(sessions[2].title) && frame.includes("跟随执行中"))
  info = { ...info, status: "done", tasks: info.tasks.map((task, index) => index === 2 ? { ...task, status: "completed", summary: "末项完成摘要" } : task) }
  emit(6)
  await app.waitForFrame((frame) => frame.includes("本批处理结束") && frame.includes("3/3") && frame.includes("末项完成摘要"))
  expect(controls).toEqual(["start"])
  await clickText(app, "收起 [esc]")
  await app.waitForFrame((frame) => !frame.includes("批次：并排任务") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  emit(7)
  await app.renderOnce()
  expect(app.captureCharFrame()).not.toContain("批次：并排任务")
  await openTasks(app)
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("本批处理结束") && frame.includes("批次侧面板"))
  app.mockInput.pressKey("o", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("批次：并排任务") && frame.includes("已暂停跟随"))
  app.resize(44, 24)
  await app.waitForFrame((frame) => frame.includes("收起 [esc]") && !frame.includes(sessions[2].title))
  await clickText(app, "收起 [esc]")
  await app.waitForFrame((frame) => !frame.includes("批次：") && !app.renderer.root.findDescendantById("session-panel") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
  expect(controls).toEqual(["start"])
})

test("a replacement service cancels active follow even when it publishes the same queue ID", async () => {
  takeDraft(undefined)
  const current = { ...session("ses_origin"), title: "Original execution route" }
  const wrong = { ...session("ses_foreign"), title: "Must not navigate to foreign task" }
  const initial = taskQueue({ directory, title: "Origin active batch", currentTaskID: "tqt_one", tasks: [{ ...taskQueue().tasks[0], sessionID: current.id }] })
  const replacement = taskQueue({ directory, title: "Replacement observed batch", status: "running", currentTaskID: "tqt_one", tasks: [{ ...taskQueue().tasks[0], sessionID: wrong.id }], time: { created: 1, updated: 10 } })
  const listed = Promise.withResolvers<void>()
  const events = createEventStream()
  const visited: string[] = []
  const controls: string[] = []
  const calls = createFetch((url) => {
    if (url.pathname === "/api/task-queue") { listed.resolve(); return json({ data: [replacement] }) }
    if (url.pathname.startsWith("/api/task-queue/")) {
      if (/\/(start|resume|heartbeat|stop)$/.test(url.pathname)) controls.push(url.pathname)
      return json({ data: replacement })
    }
    const target = [current, wrong].find((item) => url.pathname === `/api/session/${item.id}`)
    if (target) { visited.push(target.id); return json({ data: target }) }
    if ([current, wrong].some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
    if ([current, wrong].some((item) => ["inbox", "permission"].some((name) => url.pathname === `/api/session/${item.id}/${name}`))) return json({ data: [] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  try {
    await using app = await createAppFixture({ width: 160, height: 30, config: { animations: false, tabs: { mode: "off" } },
      service: { reconnect: async () => ({ url: server.url.toString(), auth: undefined }), restart: async () => {} },
      fetch: (url) => {
        if (url.pathname === "/api/task-queue") return json({ data: [initial] })
        if (url.pathname.endsWith(`/${initial.id}/start`)) return json({ data: { ...initial, status: "running", time: { created: 1, updated: 2 } } })
        if (url.pathname.startsWith("/api/task-queue/")) return json({ data: { ...initial, status: "stopped" } })
        if (url.pathname === `/api/session/${current.id}`) return json({ data: current })
        if (url.pathname === `/api/session/${current.id}/message`) return json({ data: [], cursor: {} })
        if (["inbox", "permission"].some((name) => url.pathname === `/api/session/${current.id}/${name}`)) return json({ data: [] })
        return undefined
      },
    })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app, initial.title!)
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("批次：Origin active batch") && app.renderer.root.findDescendantById("session-pane") !== undefined)
    app.events.disconnect()
    await listed.promise
    await app.waitForFrame((frame) => !frame.includes("批次：") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await openTasks(app, replacement.title!)
    events.emit({ id: "evt_replacement_view", created: 11, type: "taskqueue.updated", data: { ...replacement, title: "New service event received", time: { created: 1, updated: 11 } } })
    await app.waitForFrame((frame) => frame.includes("New service event received"))
    expect(visited).not.toContain(wrong.id)
    expect(controls).toEqual([])
  } finally {
    events.disconnect()
    await server.stop(true)
  }
})

async function openTasks(app: Awaited<ReturnType<typeof createAppFixture>>, title = "并排任务") {
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
