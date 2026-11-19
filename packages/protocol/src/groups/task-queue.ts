import { TaskQueue } from "@opencode/schema/task-queue"
import { AbsolutePath, optional } from "@opencode/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import {
  InvalidRequestError,
  LocationNotFoundError,
  TaskQueueNotFoundError,
} from "../errors.js"

const errors = [InvalidRequestError, TaskQueueNotFoundError, LocationNotFoundError] as const
const params = { queueID: TaskQueue.ID }
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `taskQueue.${identifier}`,
    summary,
    description,
  })

export const ListQuery = Schema.Struct({
  directory: AbsolutePath.annotate({ description: "List the queues created for this directory." }),
}).annotate({ identifier: "TaskQueue.ListQuery" })
export type ListQuery = typeof ListQuery.Type

export const StopPayload = Schema.Struct({
  reason: Schema.optional(Schema.String).annotate({
    description: "Why the queue stopped, recorded on the queue; defaults to a user stop.",
  }),
}).annotate({ identifier: "TaskQueue.StopPayload" })
export type StopPayload = typeof StopPayload.Type

export const PlanPayload = Schema.Struct({ taskID: TaskQueue.TaskID.pipe(optional) }).annotate({ identifier: "TaskQueue.PlanPayload" })
export type PlanPayload = typeof PlanPayload.Type

export const TaskQueueGroup = HttpApiGroup.make("server.taskQueue").add(
  HttpApiEndpoint.post("taskQueue.create", "/api/task-queue", {
    payload: TaskQueue.CreateInput,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: [InvalidRequestError, LocationNotFoundError],
  }).annotateMerge(
    annotations(
      "create",
      "Create task queue",
      "Create an ordered batch requiring interactive per-task planning and real approval before manual start. Each task plans and executes in the same independent session.",
    ),
  ),
  HttpApiEndpoint.get("taskQueue.list", "/api/task-queue", {
    query: ListQuery,
    success: Schema.Struct({ data: Schema.Array(TaskQueue.Info) }),
    error: [LocationNotFoundError],
  }).annotateMerge(annotations("list", "List task queues", "List a directory's queues, oldest first.")),
  HttpApiEndpoint.get("taskQueue.get", "/api/task-queue/:queueID", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(annotations("get", "Get task queue", "Read one queue with its tasks.")),
  HttpApiEndpoint.post("taskQueue.start", "/api/task-queue/:queueID/start", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(
    annotations("start", "Start task queue", "Manually start a fully Auto-approved ready batch. The server saves a unique project plan snapshot before serial execution; incomplete or stale approvals are rejected."),
  ),
  HttpApiEndpoint.post("taskQueue.plan", "/api/task-queue/:queueID/plan", {
    params, payload: PlanPayload, success: Schema.Struct({ data: TaskQueue.Info }), error: errors,
  }).annotateMerge(annotations("plan", "Plan task queue", "Acquire the owner lease and interactively plan tasks in order. Optional taskID reopens a plan before execution. Planning never starts execution; use heartbeat and stop for its owner lifecycle. Ready queues wait for manual start.")),
  HttpApiEndpoint.post("taskQueue.heartbeat", "/api/task-queue/:queueID/heartbeat", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(
    annotations(
      "heartbeat",
      "Renew task queue lease",
      "Extend a running planning or execution queue's owner lease; missing renewals stop its entire task tree. Ready queues have no active lease and still require manual start.",
    ),
  ),
  HttpApiEndpoint.post("taskQueue.stop", "/api/task-queue/:queueID/stop", {
    params,
    payload: StopPayload,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(
    annotations(
      "stop",
      "Stop task queue",
      "Stop a queue owned by this server and wait for its task tree and background work to stop. The interrupted task keeps its session for a later resume. A non-running queue is returned unchanged.",
    ),
  ),
  HttpApiEndpoint.post("taskQueue.resume", "/api/task-queue/:queueID/resume", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(
    annotations(
      "resume",
      "Resume task queue",
      "Continue the interrupted and pending tasks of a stopped or interrupted queue without revisiting earlier blocked tasks. Explicitly resuming a done queue retries its blocked and failed tasks in their original sessions; completed tasks are never repeated. Only one batch may run in a canonical directory.",
    ),
  ),
  HttpApiEndpoint.delete("taskQueue.delete", "/api/task-queue/:queueID", {
    params,
    success: HttpApiSchema.NoContent,
    error: errors,
  }).annotateMerge(
    annotations("delete", "Delete task queue", "Delete a queue and its tasks. A running queue must be stopped first."),
  ),
).annotateMerge(OpenApi.annotations({ title: "taskQueue", description: "Serial task queues." }))
