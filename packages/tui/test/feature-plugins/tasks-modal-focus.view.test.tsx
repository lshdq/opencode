import { expect, test } from "bun:test"
import type { TaskQueueCreateInput } from "@opencode/client"
import { InputRenderable, TextareaRenderable, TextRenderable } from "@opentui/core"
import stringWidth from "string-width"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture } from "../fixture/app"
import { session } from "../fixture/local"
import { taskQueue } from "../fixture/task-queue"
import { sourceSignal } from "../fixture/task-queue-source"
import { directory, json } from "../fixture/tui-client"

const cases = ([160, 44] as const).flatMap((width) =>
  (["subsequent", "reopened"] as const).flatMap((stage) =>
    (["start", "resume"] as const).map((action) => ({ width, stage, action })),
  ),
)

// TC-014: the original dialog's reveal is already consumed or its component is
// gone. A new modal must keep accepting keys while the real SessionFrame remounts.
test.each(cases)("$stage Session after $action preserves modal typing at $width columns", async ({ width, stage, action }) => {
  takeDraft(undefined)
  const sessions = [1, 2].map((index) => ({ ...session(`ses_modal_${index}_${crypto.randomUUID().slice(0, 8)}`), title: `Modal execution ${index}` }))
  let info = taskQueue({ directory, title: "Modal owner batch", status: action === "start" ? "queued" : "stopped",
    tasks: sessions.map((_, index) => ({ ...taskQueue().tasks[0], id: `tqt_modal_${index}`, title: `Modal task ${index + 1}`, position: index })) })
  const saved = taskQueue({ id: "tq_modal_saved", directory, title: "Saved modal batch" })
  const controls: string[] = []
  const visited: string[] = []
  const submissions: TaskQueueCreateInput[] = []
  const sessionCreates: string[] = []
  const navigated = Promise.withResolvers<void>()
  const target = stage === "subsequent" ? 1 : 0
  {
    await using app = await createAppFixture({ width, height: 30,
      config: { animations: false, tabs: { mode: "on", layout: "horizontal" }, keybinds: { "command.palette.show": "f7" } },
      fetch: async (url, request) => {
        if (url.pathname === "/api/session" && request.method === "POST") sessionCreates.push(url.pathname)
        if (url.pathname === "/api/task-queue" && request.method === "POST") {
          submissions.push(await request.json() as TaskQueueCreateInput)
          return json({ data: saved })
        }
        if (url.pathname === "/api/task-queue") return json({ data: submissions.length ? [info, saved] : [info] })
        if (url.pathname === `/api/task-queue/${saved.id}`) return json({ data: saved })
        if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
        if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
          const method = url.pathname.split("/").at(-1)!
          controls.push(`${info.id}:${method}`)
          info = { ...info, status: method === "stop" ? "stopped" : "running", currentTaskID: info.tasks[0].id,
            tasks: info.tasks.map((task, index) => !index && stage === "subsequent" ? { ...task, status: "running", sessionID: sessions[0].id } : task),
            time: { created: 1, updated: 2 } }
          return json({ data: info })
        }
        const item = sessions.find((item) => url.pathname === `/api/session/${item.id}`)
        if (item) {
          visited.push(item.id)
          if (item.id === sessions[target].id) navigated.resolve()
          return json({ data: item })
        }
        if (sessions.some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
        if (sessions.some((item) => url.pathname === `/api/session/${item.id}/inbox`)) return json({ data: [] })
        return undefined
      } })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app, info.title!)
    app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
    if (stage === "subsequent") {
      await app.waitForFrame((frame) => frame.includes("批次：Modal owner") && frame.includes("跟随执行中") &&
        (width === 44 ? app.renderer.currentFocusedRenderable?.id === "session-panel" : app.renderer.currentFocusedEditor instanceof TextareaRenderable))
    }
    if (stage === "reopened") {
      await app.waitForFrame((frame) => frame.includes("执行中") && !frame.includes("正在处理"))
      expect(visited).toEqual([])
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => !frame.includes("任务队列 / tasks") && frame.includes("commands"))
    }
    const previousPanel = app.renderer.root.findDescendantById("session-panel")
    await openTasks(app, info.title!)
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
    const content = "新编辑器完整内容🧪\n第二行保持完整\n  保留尾部空格  "
    await app.mockInput.pasteBracketedText(content)
    const editor = app.renderer.currentFocusedEditor
    if (!(editor instanceof TextareaRenderable)) throw new Error("Modal task editor was not focused")
    expect(editor?.plainText).toBe(content)
    expect(app.renderer.currentFocusedRenderable).toBe(editor)
    expect(submissions).toEqual([])

    info = { ...info, currentTaskID: info.tasks[target].id,
      tasks: info.tasks.map((task, index) => index === target ? { ...task, status: "running", sessionID: sessions[target].id } : { ...task, status: "completed" }),
      time: { created: 1, updated: 3 } }
    // No server.connected/refetch shortcut: the task event itself must navigate.
    app.events.emit({ id: "evt_modal_advance", created: 3, type: "taskqueue.updated", data: info })
    await sourceSignal(navigated.promise)
    await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.root.findDescendantById("session-panel")?.width === (width === 44 ? 44 : 80))
    const focused = app.renderer.currentFocusedRenderable
    const focusedEditor = app.renderer.currentFocusedEditor
    expect(app.renderer.root.findDescendantById("task-queue-prompt")).toBe(editor)
    expect(editor?.plainText).toBe(content)
    expect(app.renderer.root.findDescendantById("session-panel")).not.toBe(previousPanel)
    expect(visited.filter((id) => id === sessions[target].id)).toHaveLength(1)
    await app.mockInput.typeText("X")
    await app.renderOnce()
    expect(editor?.plainText, `Focus after ${stage}: ${focused?.id}\n${app.captureCharFrame()}`).toBe(content + "X")
    expect(focused).toBe(editor)
    expect(focusedEditor).toBe(editor)
    expect(app.renderer.currentFocusedEditor).toBe(editor)
    expect(app.captureCharFrame()).toContain("添加任务")
    expect(controls).toEqual([`${info.id}:${action}`])
    expect(submissions).toEqual([])
    expect(sessionCreates).toEqual([])

    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建前预览") && frame.includes("第二行保持完整"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes(saved.title!) && frame.includes("rounds"))
    expect(submissions.map((input) => input.tasks)).toEqual([[{ prompt: content + "X" }]])
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => !frame.includes("任务队列 / tasks") && frame.includes("跟随执行中") &&
      (width !== 44 || app.renderer.currentFocusedRenderable?.id === "session-panel"))
    // Closing the modal must reactively restore the fullscreen panel's keyboard
    // scope. It must also stay operable after a later keyed SessionFrame remount.
    if (width === 44) {
      if (stage === "subsequent") {
        app.mockInput.pressArrow("up")
        app.mockInput.pressEnter()
        await app.waitForFrame((frame) => viewedTask(app, 0) && frame.includes("已暂停跟随") && app.renderer.currentFocusedRenderable?.id === "session-panel")
        app.mockInput.pressKey("r")
        await app.waitForFrame((frame) => viewedTask(app, 1) && frame.includes("跟随执行中") && app.renderer.currentFocusedRenderable?.id === "session-panel")
      }
      app.mockInput.pressEscape()
      await app.waitForFrame(() => !app.renderer.root.findDescendantById("session-panel") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      await openTasks(app, info.title!)
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("批次侧面板") && frame.includes(info.title!))
      app.mockInput.pressKey("o", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("已暂停跟随") && app.renderer.currentFocusedRenderable?.id === "session-panel")
      await clickText(app, "收起 [esc]")
      await app.waitForFrame(() => !app.renderer.root.findDescendantById("session-panel") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    }
    expect(controls).toEqual([`${info.id}:${action}`])
    expect(submissions).toHaveLength(1)
    expect(sessionCreates).toEqual([])
  }
  expect(controls).toEqual([`${info.id}:${action}`, `${info.id}:stop`])
})

async function openTasks(app: Awaited<ReturnType<typeof createAppFixture>>, title: string) {
  app.mockInput.pressKey("F7")
  await app.waitForFrame((frame) => frame.includes("Commands") && app.renderer.currentFocusedEditor instanceof InputRenderable)
  await app.mockInput.typeText("Task queues")
  await app.waitForFrame((frame) => frame.includes("任务队列 / Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && frame.includes(title) && app.renderer.currentFocusedEditor instanceof InputRenderable)
  // Creating the new batch can change the remembered selection. Select the
  // owner's batch explicitly before exercising its history/reopen controls.
  await app.mockInput.typeText(title)
  await app.waitForFrame((frame) => frame.includes(title) && !frame.includes("Saved modal batch"))
}

async function clickText(app: Awaited<ReturnType<typeof createAppFixture>>, text: string) {
  const lines = app.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.includes(text))
  expect(row, app.captureCharFrame()).toBeGreaterThanOrEqual(0)
  app.renderer.clearSelection()
  await app.mockMouse.click(stringWidth(lines[row].slice(0, lines[row].indexOf(text))) + 1, row)
  await app.renderOnce()
}

function viewedTask(app: Awaited<ReturnType<typeof createAppFixture>>, index: number) {
  return app.renderer.root.findDescendantById(`batch-panel-tqt_modal_${index}`)?.getChildren()
    .some((node) => node instanceof TextRenderable && node.plainText.includes("◉ 查看")) ?? false
}
