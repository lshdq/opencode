import { expect, test } from "bun:test"
import type { OpenCodeEvent, TaskQueueCreateInput, TaskQueueInfo } from "@opencode/client"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import { createAppFixture } from "../fixture/app"
import { renderLocal, session } from "../fixture/local"
import { approvedTaskPlan, planningTaskQueue } from "../fixture/task-queue"
import { directory, json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { TaskQueueDetail } from "../../src/feature-plugins/system/tasks"
import { TaskQueuePlan } from "../../src/feature-plugins/system/tasks-plan"

type PlanningForm = Extract<OpenCodeEvent, { type: "form.created" }>["data"]["form"]

test.each([100, 44])("real planning Form uses option values, becomes ready without execution, then starts manually at width %s", async (width) => {
  takeDraft(undefined)
  const target = { ...session(`ses_planning_${crypto.randomUUID()}`, undefined, "plan"), title: "Planning session" }
  const controls: string[] = []
  const answers: unknown[] = []
  const created: TaskQueueCreateInput[] = []
  let info = planningTaskQueue({ directory })
  let form: PlanningForm | undefined = approvalForm(target.id, "requirements")
  const publish = () => {
    info = { ...info, time: { created: 1, updated: info.time.updated + 1 } }
    app.events.emit({ id: `evt_plan_${info.time.updated}`, created: info.time.updated, type: "taskqueue.updated", data: info })
  }
  const app = await createAppFixture({ width, height: 32, config: { animations: false, tabs: { mode: "off" } }, fetch: async (url, request) => {
    if (url.pathname === "/api/task-queue" && request.method === "POST") {
      const input = await request.json() as TaskQueueCreateInput
      created.push(input)
      info = { ...info, tasks: [{ ...info.tasks[0], prompt: input.tasks[0].prompt }] }
      return json({ data: info })
    }
    if (url.pathname === "/api/task-queue") return json({ data: created.length ? [info] : [] })
    if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
    if (url.pathname.endsWith(`/${info.id}/plan`)) {
      controls.push("plan")
      info = { ...info, status: "running", currentTaskID: info.tasks[0].id,
        tasks: [{ ...info.tasks[0], status: "planning", sessionID: target.id }], time: { created: 1, updated: 2 } }
      return json({ data: info })
    }
    if (url.pathname.endsWith(`/${info.id}/start`)) {
      controls.push("start")
      info = { ...info, phase: "execution", status: "running", snapshot: "D:\\project\\.localdoc\\任务队列\\批次方案.json",
        tasks: [{ ...info.tasks[0], status: "running" }], currentTaskID: info.tasks[0].id, time: { created: 1, updated: 5 } }
      return json({ data: info })
    }
    if (url.pathname.endsWith(`/${info.id}/stop`)) { controls.push("stop"); return json({ data: { ...info, status: "stopped" } }) }
    if (url.pathname === `/api/session/${target.id}`) return json({ data: target })
    if (url.pathname === `/api/session/${target.id}/message`) return json({ data: [], cursor: {} })
    if (["inbox", "permission"].some((name) => url.pathname === `/api/session/${target.id}/${name}`)) return json({ data: [] })
    if (url.pathname === `/api/session/${target.id}/form`) return json({ data: form ? [form] : [] })
    if (url.pathname.includes(`/api/session/${target.id}/form/`) && request.method === "DELETE") throw new Error("Planning must not cancel user questions")
    if (url.pathname.endsWith("/reply")) {
      const body = await request.json() as { answer: { decision: string } }
      answers.push(body)
      if (form?.metadata?.stage === "requirements") {
        form = approvalForm(target.id, "proposal")
        app.events.emit({ id: "evt_proposal", created: 3, type: "form.created", data: { form } })
      } else {
        form = undefined
        info = { ...info, phase: "ready", status: "queued", currentTaskID: undefined,
          tasks: [{ ...info.tasks[0], status: "ready", plan: approvedTaskPlan() }] }
        publish()
      }
      return new Response(null, { status: 204 })
    }
    return undefined
  } })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app)
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次"))
    app.mockInput.pressKey("a", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
    await app.mockInput.pasteBracketedText("First task\n完整需求")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次") && frame.includes("First task"))
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("创建前预览"))
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("待规划") && frame.includes("开始规划"))
    expect(created.map((input) => input.tasks)).toEqual([[{ prompt: "First task\n完整需求" }]])
    expect(app.captureCharFrame()).toContain("开始规划")
    expect(app.captureCharFrame()).not.toContain("手动开始")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("跟随规划中"))
    expect(app.captureCharFrame()).not.toContain("▶ 执行")
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("确认需求") && frame.includes("确认需求按钮"))
    expect(app.captureCharFrame()).not.toContain("▶ 执行")
    expect(controls).toEqual(["plan"])
    // Single-field Form submits the option's value, not its Chinese label.
    app.mockInput.pressKey("1")
    await app.waitForFrame((frame) => frame.includes("确认方案与执行模式") && frame.includes("Auto"))
    expect(answers).toEqual([{ answer: { decision: "confirm" } }])
    expect(app.captureCharFrame()).not.toContain("Type your own answer")
    app.mockInput.pressKey("1")
    await app.waitForFrame((frame) => !frame.includes("确认方案与执行模式") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(answers).toEqual([{ answer: { decision: "confirm" } }, { answer: { decision: "auto" } }])
    expect(controls).toEqual(["plan"])
    // A ready update must not reopen the explicitly closed panel or start execution.
    expect(app.captureCharFrame()).not.toContain("批次：")
    await openTasks(app)
    expect(app.captureCharFrame()).toContain("等待手动开始")
    expect(controls).toEqual(["plan"])
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("跟随执行中"))
    expect(controls).toEqual(["plan", "start"])
    expect(info.snapshot).toContain("批次方案.json")
  } finally { await app[Symbol.asyncDispose]() }
  expect(controls).toEqual(["plan", "start", "stop"])
})

test("viewing an approved task is read-only; reopening sends that task ID, revokes readiness and follows planning", async () => {
  takeDraft(undefined)
  const target = { ...session(`ses_replan_${crypto.randomUUID()}`), title: "Reopened original session" }
  let info = planningTaskQueue({ directory, phase: "ready", tasks: [{ ...planningTaskQueue().tasks[0], status: "ready", sessionID: target.id, plan: approvedTaskPlan() }] })
  const requests: unknown[] = []
  const controls: string[] = []
  await using app = await createAppFixture({ width: 100, height: 30, config: { animations: false, tabs: { mode: "off" } }, fetch: async (url, request) => {
    if (url.pathname === "/api/task-queue") return json({ data: [info] })
    if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: info })
    if (url.pathname.endsWith(`/${info.id}/plan`)) {
      requests.push(await request.json())
      info = { ...info, status: "running", phase: "planning", currentTaskID: info.tasks[0].id,
        tasks: [{ ...info.tasks[0], status: "planning", plan: approvedTaskPlan({ version: 3, approval: undefined, mode: undefined }) }], time: { created: 1, updated: 4 } }
      return json({ data: info })
    }
    if (/\/(start|resume|stop)$/.test(url.pathname)) { controls.push(url.pathname.split("/").at(-1)!); return json({ data: { ...info, status: "stopped" } }) }
    if (url.pathname === `/api/session/${target.id}`) return json({ data: target })
    if (url.pathname === `/api/session/${target.id}/message`) return json({ data: [], cursor: {} })
    if (["inbox", "permission"].some((name) => url.pathname === `/api/session/${target.id}/${name}`)) return json({ data: [] })
    return undefined
  } })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await openTasks(app)
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("查看方案") && frame.includes("等待手动开始"))
  app.mockInput.pressKey("p", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("完整方案：") && frame.includes("重开规划"))
  expect(requests).toEqual([])
  expect(controls).toEqual([])
  app.mockInput.pressKey("r", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("跟随规划中") && frame.includes("方案 v3"))
  expect(requests).toEqual([{ taskID: "tqt_one" }])
  expect(controls).toEqual([])
  expect(info.tasks[0].plan?.approval).toBeUndefined()
  expect(info.tasks[0].sessionID).toBe(target.id)
})

test.each([100, 44])("persisted plan displays 1-based task and dependency positions at %s columns", async (width) => {
  await using app = await renderLocal()
  app.resize(width, 32)
  const first = planningTaskQueue().tasks[0]
  const info = planningTaskQueue({ tasks: [first, { ...first, id: "tqt_two", title: "Second task", position: 2,
    plan: approvedTaskPlan({ dependencies: [first.id], requirementsApproval: undefined, approval: undefined }) }] })
  app.dialog.setSize("large")
  const show = (index: number) => app.dialog.replace(() => <TaskQueuePlan info={info} task={info.tasks[index]} busy={false}
    onBack={() => {}} onSession={() => {}} />)
  show(0)
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("顺序：1 · 任务：tqt_one")
  show(1)
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("顺序：2 · 任务：tqt_two")
  expect(app.captureCharFrame()).toContain("依赖：1. First task (tqt_one)")
})

test.each([100, 44])("complete persisted plan and replan controls are keyboard-accessible at %s columns", async (width) => {
  await using app = await renderLocal()
  app.resize(width, 24)
  const info = planningTaskQueue({ phase: "ready", snapshot: "D:\\project\\.localdoc\\任务队列\\批次方案-مرحبا.json",
    tasks: [{ ...planningTaskQueue().tasks[0], status: "ready", sessionID: "ses_plan", plan: approvedTaskPlan({
      requirements: "需求-start\n" + "中文 mixed مرحبا requirement\n".repeat(20),
      proposal: "方案-start\n" + "完整方案 line\n".repeat(30) + "方案-end",
      acceptance: ["验收 A", "验收 B"], dependencies: [],
    }) }] })
  let reopened = 0
  const viewed: string[] = []
  app.dialog.setSize("large")
  app.dialog.replace(() => <TaskQueuePlan info={info} task={info.tasks[0]} busy={false} onBack={() => {}}
    onSession={(id) => viewed.push(id)} onReplan={() => { reopened++ }} />)
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("完整方案")
  expect(app.captureCharFrame()).toContain("重开规划")
  app.mockInput.pressKey("\x1b[F")
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("方案-end")
  expect(app.captureCharFrame()).toContain("批次方案-")
  app.mockInput.pressKey("\x1b[H")
  await app.renderOnce()
  // Scrolling never hides the persistent footer action.
  expect(app.captureCharFrame()).toContain("重开规划")
  app.mockInput.pressKey("r", { ctrl: true })
  app.mockInput.pressEnter()
  await app.renderOnce()
  expect(reopened).toBe(1)
  expect(viewed).toEqual(["ses_plan"])
})

test.each(["stopped", "interrupted"] as const)("%s planning continues with plan, never resume; execution does the opposite", async (status) => {
  await using app = await renderLocal()
  let plans = 0
  let resumes = 0
  let starts = 0
  const show = (info: TaskQueueInfo) => app.dialog.replace(() => <TaskQueueDetail info={info} busy={false} onBack={() => {}}
    onPlan={() => { plans++ }} onStart={() => { starts++ }} onResume={() => { resumes++ }} onStop={() => {}} onSession={() => {}} />)
  show(planningTaskQueue({ status }))
  app.dialog.setSize("large")
  app.dialog.setCentered(true)
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("继续规划")
  app.mockInput.pressKey("e", { ctrl: true })
  app.mockInput.pressKey("s", { ctrl: true })
  await app.renderOnce()
  expect({ plans, resumes, starts }).toEqual({ plans: 1, resumes: 0, starts: 0 })
  show(planningTaskQueue({ status, phase: "execution" }))
  await app.renderOnce()
  app.mockInput.pressKey("s", { ctrl: true })
  app.mockInput.pressKey("e", { ctrl: true })
  await app.renderOnce()
  expect({ plans, resumes, starts }).toEqual({ plans: 1, resumes: 1, starts: 0 })
})

function approvalForm(sessionID: string, stage: "requirements" | "proposal"): PlanningForm {
  return {
    id: `frm_${stage}_${sessionID}`, sessionID, title: stage === "requirements" ? "确认需求" : "确认方案与执行模式",
    metadata: { kind: "taskqueue.plan", queueID: "tq_fixture", taskID: "tqt_one", version: stage === "requirements" ? 1 : 2, stage },
    fields: [{ key: "decision", type: "string", required: true, custom: false,
      description: stage === "requirements" ? "完整需求与验收" : "完整实施方案，尚未执行",
      options: stage === "requirements" ? [{ value: "confirm", label: "确认需求按钮" }, { value: "revise", label: "不通过，继续澄清" }]
        : [{ value: "auto", label: "确认方案并使用 Auto 模式" }, { value: "interactive", label: "确认方案并使用交互决策模式" }, { value: "revise", label: "不通过，继续修改方案" }],
    }],
  }
}

async function openTasks(app: Awaited<ReturnType<typeof createAppFixture>>) {
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
}
