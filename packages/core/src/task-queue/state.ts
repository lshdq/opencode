import type { TaskQueue } from "@opencode/schema/task-queue"
import type { TaskQueueTable, TaskQueueTaskTable } from "./sql.js"

export function toTask(row: typeof TaskQueueTaskTable.$inferSelect): TaskQueue.Task {
  return { id: row.id, title: row.title, prompt: row.prompt, status: row.status, position: row.position,
    ...(row.session_id === null ? {} : { sessionID: row.session_id }), rounds: row.rounds,
    ...(row.reason === null ? {} : { reason: row.reason }), ...(row.summary === null ? {} : { summary: row.summary }),
    ...(row.plan === null ? {} : { plan: row.plan }), time: { created: row.time_created, updated: row.time_updated } }
}
export function toInfo(row: typeof TaskQueueTable.$inferSelect, tasks: readonly (typeof TaskQueueTaskTable.$inferSelect)[]): TaskQueue.Info {
  return { id: row.id, ...(row.title === null ? {} : { title: row.title }), directory: row.directory, status: row.status,
    workflowVersion: row.workflow_version, phase: row.phase, ...(row.snapshot === null ? {} : { snapshot: row.snapshot }),
    ...(row.reason === null ? {} : { reason: row.reason }), ...(row.current_task_id === null ? {} : { currentTaskID: row.current_task_id }),
    tasks: tasks.map(toTask), time: { created: row.time_created, updated: row.time_updated } }
}
