import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture } from "../fixture/app"
import { session } from "../fixture/local"
import { taskQueue } from "../fixture/task-queue"
import { sourceSignal } from "../fixture/task-queue-source"
import { directory, json } from "../fixture/tui-client"

const cases = (["start", "resume"] as const).flatMap((action) =>
  (["Enter", "Ctrl+O"] as const).flatMap((key) => ([160, 44] as const).map((width) => ({ action, key, width }))),
)

// TC-013: start views another finished batch; resume views its own previous
// result, while the next Session has not been assigned in either case.
test.each(cases)("first $key after $action opens an explicit result at $width columns despite pending automatic reveal", async ({ action, key, width }) => {
  takeDraft(undefined)
  const history = { ...session(`ses_eh_${crypto.randomUUID().slice(0, 8)}`), title: "Historical task route" }
  const late = { ...session(`ses_el_${crypto.randomUUID().slice(0, 8)}`), title: "Late automatic route" }
  const historical = taskQueue({ id: "tq_other_result", directory, title: "Done batch", status: "done", tasks: [
    { ...taskQueue().tasks[0], id: "tqt_history", status: "completed", sessionID: history.id },
  ] })
  let info = taskQueue({ directory, title: "Waiting batch", status: action === "start" ? "queued" : "stopped", tasks: [
    ...(action === "resume" ? historical.tasks : []),
    { ...taskQueue().tasks[0], id: "tqt_waiting", position: action === "start" ? 0 : 1 },
  ] })
  const visited: string[] = []
  const controls: string[] = []
  const submissions: string[] = []
  const navigated = Promise.withResolvers<void>()
  const receipt = Promise.withResolvers<void>()
  let armed = false
  {
    await using app = await createAppFixture({ width, height: 30,
      config: { animations: false, tabs: { mode: "on", layout: "horizontal" } }, fetch: (url, request) => {
        if (url.pathname === "/api/session" && request.method === "POST") submissions.push("session.create")
        if (url.pathname === "/api/task-queue") {
          if (request.method === "POST") submissions.push("create")
          if (armed) receipt.resolve()
          return json({ data: action === "start" ? [info, historical] : [info] })
        }
        if (url.pathname === `/api/task-queue/${historical.id}`) return json({ data: historical })
        if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
        if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
          const method = url.pathname.split("/").at(-1)!
          controls.push(method)
          info = { ...info, status: method === "stop" ? "stopped" : "running", currentTaskID: "tqt_waiting", time: { created: 1, updated: 2 } }
          return json({ data: info })
        }
        const target = [history, late].find((item) => url.pathname === `/api/session/${item.id}`)
        if (target) { visited.push(target.id); navigated.resolve(); return json({ data: target }) }
        if ([history, late].some((item) => url.pathname === `/api/session/${item.id}/message`)) return json({ data: [], cursor: {} })
        if ([history, late].some((item) => url.pathname === `/api/session/${item.id}/inbox`)) return json({ data: [] })
        return undefined
      } })
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.mockInput.typeText("/tasks")
    await app.waitForFrame((frame) => frame.includes("Task queues"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes(info.title!) && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("rounds") && frame.includes(info.title!))
    app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("执行中") && !frame.includes("正在处理"))
    expect(visited).toEqual([])
    expect(controls).toEqual([action])

    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    if (action === "start") {
      await app.mockInput.typeText(historical.title!)
      await app.waitForFrame((frame) => frame.includes(historical.title!) && !frame.includes(info.title!))
    }
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("批次侧面板") && frame.includes(history.id))
    if (key === "Enter") app.mockInput.pressEnter()
    if (key === "Ctrl+O") app.mockInput.pressKey("o", { ctrl: true })
    await app.waitForFrame((frame) => !frame.includes("任务队列 / tasks") && !frame.includes("批次侧面板"))
    // A request is a network signal, not a reason to increase frame passes.
    await sourceSignal(navigated.promise).catch((cause: unknown) => {
      throw new Error(`First explicit view did not navigate: ${JSON.stringify({ visited, controls })}\n${app.captureCharFrame()}`, { cause })
    })
    expect(visited).toEqual([history.id])
    const title = action === "start" ? historical.title! : info.title!
    await app.waitForFrame((frame) => frame.includes(`批次：${title}`) && frame.includes("已暂停跟随"))
    const panel = app.renderer.root.findDescendantById("session-panel")
    expect(panel).toBeDefined()
    expect(panel?.width).toBe(width === 44 ? 44 : 80)
    expect(controls).toEqual([action])
    expect(submissions).toEqual([])

    info = { ...info, tasks: info.tasks.map((task) => task.id === "tqt_waiting" ? { ...task, status: "running", sessionID: late.id } : task),
      time: { created: 1, updated: 3 } }
    armed = true
    app.events.emit({ id: "evt_explicit_late", created: 3, type: "taskqueue.updated", data: info })
    app.events.emit({ id: "evt_explicit_receipt", type: "server.connected", data: {} })
    await sourceSignal(receipt.promise)
    await app.renderOnce()
    // The reconnect barrier also refetches the active Session; it must never read the late one.
    expect([...new Set(visited)]).toEqual([history.id])
    expect(app.renderer.root.findDescendantById("session-panel")).toBe(panel)
    expect(app.captureCharFrame()).toContain(`批次：${title}`)
    expect(app.captureCharFrame()).toContain("已暂停跟随")
    expect(app.captureCharFrame()).not.toContain(late.title)
    expect(controls).toEqual([action])
    expect(submissions).toEqual([])
  }
  expect(controls).toEqual([action, "stop"])
})
