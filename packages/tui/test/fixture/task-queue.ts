import type { TaskQueueInfo } from "@opencode/client"

export function taskQueue(input: Partial<TaskQueueInfo> = {}): TaskQueueInfo {
  return {
    id: "tq_fixture", directory: "D:\\project", title: "Fixture batch", status: "queued",
    tasks: [{
      id: "tqt_one", title: "First task", prompt: "First line\n第二行", status: "pending", position: 0,
      rounds: 0, time: { created: 1, updated: 1 },
    }],
    time: { created: 1, updated: 1 },
    ...input,
  }
}
