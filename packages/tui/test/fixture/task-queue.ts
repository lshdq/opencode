import type { TaskQueueInfo, TaskQueueTask } from "@opencode/client"

export function taskQueue(input: Partial<TaskQueueInfo> = {}): TaskQueueInfo {
  return {
    id: "tq_fixture", directory: "D:\\project", title: "Fixture batch", status: "queued",
    // Existing lifecycle regressions deliberately model historical execution-only queues.
    workflowVersion: 1, phase: "execution",
    tasks: [{
      id: "tqt_one", title: "First task", prompt: "First line\n第二行", status: "pending", position: 0,
      rounds: 0, time: { created: 1, updated: 1 },
    }],
    time: { created: 1, updated: 1 },
    ...input,
  }
}

export function planningTaskQueue(input: Partial<TaskQueueInfo> = {}): TaskQueueInfo {
  return taskQueue({ workflowVersion: 2, phase: "planning",
    tasks: taskQueue().tasks.map((task, index) => ({ ...task, position: index + 1 })), ...input })
}

export function approvedTaskPlan(input: Partial<NonNullable<TaskQueueTask["plan"]>> = {}): NonNullable<TaskQueueTask["plan"]> {
  return {
    version: 2, requirementsVersion: 1, type: "development", requirements: "完整需求", acceptance: ["全部验收通过"], dependencies: [],
    proposal: "完整实施方案", mode: "auto",
    requirementsApproval: { version: 1, formID: "frm_requirements", choice: "confirm", answer: { decision: "confirm" }, time: 2 },
    approval: { version: 2, formID: "frm_proposal", choice: "auto", answer: { decision: "auto" }, time: 3 },
    ...input,
  }
}
