import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { TaskQueueDetail } from "../../src/feature-plugins/system/tasks"
import { TaskQueuePlan } from "../../src/feature-plugins/system/tasks-plan"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture } from "../fixture/app"
import { renderLocal } from "../fixture/local"
import { approvedTaskPlan, planningTaskQueue } from "../fixture/task-queue"
import { directory, json } from "../fixture/tui-client"

// TC-003/004/005/011: even a stale server view claiming ready cannot bypass the
// real detail's keyboard gate when one current approval is missing or invalid.
test.each([100, 44])("detail refuses non-Auto and stale ready plans at %s columns", async (width) => {
  await using app = await renderLocal()
  app.resize(width, 30)
  app.dialog.setSize("large")
  const controls: string[] = []
  const plan = approvedTaskPlan()
  const rejected = [
    approvedTaskPlan({ mode: "interactive" }),
    approvedTaskPlan({ mode: undefined }),
    approvedTaskPlan({ approval: undefined }),
    ...(["interactive", "revise", "cancelled"] as const).map((choice) => approvedTaskPlan({
      approval: { ...plan.approval!, choice, answer: choice === "cancelled" ? undefined : { decision: choice } },
    })),
    approvedTaskPlan({ version: 3 }),
    approvedTaskPlan({ requirementsVersion: 2 }),
    approvedTaskPlan({ requirementsApproval: undefined }),
    approvedTaskPlan({ requirementsApproval: { ...plan.requirementsApproval!, choice: "revise" } }),
    approvedTaskPlan({ proposal: undefined }),
  ]
  for (const invalid of rejected) {
    const first = planningTaskQueue().tasks[0]
    const info = planningTaskQueue({ phase: "ready", tasks: [
      { ...first, status: "ready", plan },
      { ...first, id: "tqt_second", position: 2, status: "ready", plan: invalid },
    ] })
    app.dialog.replace(() => <TaskQueueDetail info={info} busy={false} onBack={() => {}}
      onStart={() => controls.push("start")} onResume={() => controls.push("resume")}
      onPlan={() => controls.push("plan")} onStop={() => controls.push("stop")} onSession={() => {}} />)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("手动开始 ctrl+s")
    app.mockInput.pressKey("s", { ctrl: true })
    app.mockInput.pressKey("e", { ctrl: true })
    await app.renderOnce()
    expect(controls).toEqual([])
  }
})

// TC-005/011: collect actual scrolled frames, not renderable source text, so
// approvals, versions, bodies, acceptance and snapshot must all be reachable.
test.each([100, 44])("read-only plan exposes all persisted evidence and withdrawal warning at %s columns", async (width) => {
  await using app = await renderLocal()
  app.resize(width, 24)
  app.dialog.setSize("large")
  const first = planningTaskQueue().tasks[0]
  const task = { ...first, id: "tqt_second", position: 2, prompt: "Original mixed مرحبا", status: "ready" as const,
    plan: approvedTaskPlan({ type: "other", dependencies: [first.id], requirements: "Requirement first\nRequirement last",
      proposal: "Proposal first\nProposal last", acceptance: ["Accept first", "Accept last"] }) }
  const info = planningTaskQueue({ phase: "ready", snapshot: "D:\\plan\\snapshot.json", tasks: [first, task] })
  let reopens = 0
  app.dialog.replace(() => <TaskQueuePlan info={info} task={task} busy={false} onBack={() => {}}
    onSession={() => {}} onReplan={() => { reopens++ }} />)
  const frames: string[] = []
  // One physical row per key avoids skipping evidence between viewport pages.
  for (const _ of Array.from({ length: 75 })) {
    await app.renderOnce()
    frames.push(app.captureCharFrame())
    expect(app.captureCharFrame()).toContain("重开规划")
    app.mockInput.pressArrow("down")
  }
  const visible = frames.join("\n").replaceAll(/\s/g, "")
  for (const expected of ["撤销本项及受影响依赖项的批准", "顺序：2", "Originalmixedمرحبا", "类型：其他任务",
    "方案v2", "需求v1", "模式：auto", "需求审批：confirm", "Formfrm_requirements", "方案审批：auto",
    "Formfrm_proposal", "需求原始回答：{\"decision\":\"confirm\"}", "方案原始回答：{\"decision\":\"auto\"}",
    "依赖：1.Firsttask(tqt_one)", "Requirementfirst", "Requirementlast", "1.Acceptfirst", "2.Acceptlast",
    "Proposalfirst", "Proposallast", "D:\\plan\\snapshot.json", "1970-01-01T00:00:00.003Z"])
    expect(visible).toContain(expected)
  expect(reopens).toBe(0)
})

// TC-005/008/011: exercise TasksDialog's real onReplan wiring after execution,
// not just canReplanTaskQueue or a manually omitted component callback.
test.each([100, 44])("an execution-phase persisted plan never offers or invokes replan at %s columns", async (width) => {
  takeDraft(undefined)
  const controls: string[] = []
  const info = planningTaskQueue({ phase: "execution", status: "stopped", tasks: [
    { ...planningTaskQueue().tasks[0], status: "interrupted", plan: approvedTaskPlan() },
  ] })
  await using app = await createAppFixture({ width, height: 30, config: { animations: false, tabs: { mode: "off" } }, fetch: (url) => {
    if (url.pathname === "/api/task-queue") return json({ data: [{ ...info, directory }] })
    if (url.pathname === `/api/task-queue/${info.id}`) return json({ data: { ...info, directory } })
    if (url.pathname.startsWith(`/api/task-queue/${info.id}/`)) {
      controls.push(url.pathname.split("/").at(-1)!)
      return json({ data: { ...info, directory } })
    }
    return undefined
  } })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("查看方案"))
  app.mockInput.pressKey("p", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("完整方案："))
  expect(app.captureCharFrame()).not.toContain("重开规划")
  app.mockInput.pressKey("r", { ctrl: true })
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain("完整方案：")
  expect(controls).toEqual([])
})
