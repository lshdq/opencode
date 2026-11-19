import { expect, test } from "bun:test"
import { canPlanTaskQueue, canReplanTaskQueue, canResumeTaskQueue, canStartTaskQueue, taskQueueCounts } from "../../src/feature-plugins/system/tasks-data"
import { approvedTaskPlan, planningTaskQueue, taskQueue } from "../fixture/task-queue"

test("new queues plan first, all current Auto approvals gate manual start, and legacy queues retain execution semantics", () => {
  const initial = planningTaskQueue()
  expect(canPlanTaskQueue(initial)).toBe(true)
  expect(canStartTaskQueue(initial)).toBe(false)
  expect(canResumeTaskQueue(initial)).toBe(false)
  const ready = planningTaskQueue({ phase: "ready", tasks: [{ ...initial.tasks[0], status: "ready", plan: approvedTaskPlan() }] })
  expect(canStartTaskQueue(ready)).toBe(true)
  expect(canPlanTaskQueue(ready)).toBe(false)
  expect(canReplanTaskQueue(ready)).toBe(true)
  for (const plan of [undefined, approvedTaskPlan({ mode: "interactive" }), approvedTaskPlan({ approval: undefined }),
    approvedTaskPlan({ version: 3 }), approvedTaskPlan({ requirementsVersion: 2 }), approvedTaskPlan({ proposal: undefined }),
    approvedTaskPlan({ approval: { version: 2, choice: "revise", formID: "frm_reject", time: 3 } })]) {
    expect(canStartTaskQueue({ ...ready, tasks: [{ ...ready.tasks[0], plan }] })).toBe(false)
  }
  expect(canStartTaskQueue({ ...ready, tasks: [...ready.tasks, { ...initial.tasks[0], id: "tqt_next" }] })).toBe(false)
  expect(canStartTaskQueue({ ...ready, tasks: [] })).toBe(false)
  for (const status of ["stopped", "interrupted"] as const) {
    expect(canPlanTaskQueue({ ...initial, status })).toBe(true)
    expect(canResumeTaskQueue({ ...initial, status })).toBe(false)
    expect(canResumeTaskQueue({ ...initial, status, phase: "execution" })).toBe(true)
  }
  expect(canReplanTaskQueue({ ...initial, status: "running" })).toBe(false)
  expect(canReplanTaskQueue({ ...initial, status: "stopped", phase: "execution" })).toBe(false)
  expect(canStartTaskQueue(taskQueue())).toBe(true)
  expect(canStartTaskQueue(taskQueue({ workflowVersion: undefined, phase: undefined }))).toBe(true)
  expect(canResumeTaskQueue(taskQueue({ status: "interrupted" }))).toBe(true)
})

test("planning counts distinguish ready from executed tasks", () => {
  const info = planningTaskQueue()
  const tasks = (["pending", "planning", "ready", "interrupted"] as const).map((status) => ({ ...info.tasks[0], status }))
  expect(taskQueueCounts(tasks, "planning")).toBe("待规划 1 · 规划中 1 · 已就绪 1 · 中断 1")
  expect(taskQueueCounts(tasks, "ready")).not.toContain("完成")
})
