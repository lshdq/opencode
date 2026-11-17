import { TaskQueue } from "@opencode/schema/task-queue"
import { AbsolutePath } from "@opencode/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"
import {
  ForbiddenError,
  InvalidRequestError,
  LocationNotFoundError,
  TaskQueueNotFoundError,
} from "../errors.js"

const EXPERIMENTAL =
  "Experimental: needs experimental.task_queue in the directory's config and may change without compatibility guarantees."
const errors = [InvalidRequestError, TaskQueueNotFoundError, ForbiddenError, LocationNotFoundError] as const
const params = { queueID: TaskQueue.ID }
const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    // CamelCase like `experimental.persistentPty.*`: the generated SDK nests one level per identifier segment,
    // so this spelling is what makes the client surface `client.experimental.taskQueue.*`.
    identifier: `experimental.taskQueue.${identifier}`,
    summary,
    description: `${description} ${EXPERIMENTAL}`,
    // The routes share the `server.experimental` group with the persistent PTY prototype; tag them on their own.
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
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

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const TaskQueueEndpoints = [
  HttpApiEndpoint.post("taskQueue.create", "/api/experimental/task-queue", {
    payload: TaskQueue.CreateInput,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: [InvalidRequestError, ForbiddenError, LocationNotFoundError],
  }).annotateMerge(
    annotations(
      "create",
      "Create task queue",
      "Create a queue of tasks that run serially and unattended, each task in its own session in the queue's directory.",
    ),
  ),
  HttpApiEndpoint.get("taskQueue.list", "/api/experimental/task-queue", {
    query: ListQuery,
    success: Schema.Struct({ data: Schema.Array(TaskQueue.Info) }),
    error: [ForbiddenError, LocationNotFoundError],
  }).annotateMerge(annotations("list", "List task queues", "List a directory's queues, oldest first.")),
  HttpApiEndpoint.get("taskQueue.get", "/api/experimental/task-queue/:queueID", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(annotations("get", "Get task queue", "Read one queue with its tasks.")),
  HttpApiEndpoint.post("taskQueue.start", "/api/experimental/task-queue/:queueID/start", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(
    annotations("start", "Start task queue", "Start a queued queue: its tasks run one at a time until done or stopped."),
  ),
  HttpApiEndpoint.post("taskQueue.heartbeat", "/api/experimental/task-queue/:queueID/heartbeat", {
    params,
    success: Schema.Struct({ data: TaskQueue.Info }),
    error: errors,
  }).annotateMerge(
    annotations(
      "heartbeat",
      "Renew task queue lease",
      "Extend a running queue's owner lease; a lease the owner stops renewing stops the queue like a user stop.",
    ),
  ),
  HttpApiEndpoint.post("taskQueue.stop", "/api/experimental/task-queue/:queueID/stop", {
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
  HttpApiEndpoint.post("taskQueue.resume", "/api/experimental/task-queue/:queueID/resume", {
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
  HttpApiEndpoint.delete("taskQueue.delete", "/api/experimental/task-queue/:queueID", {
    params,
    success: HttpApiSchema.NoContent,
    error: errors,
  }).annotateMerge(
    annotations("delete", "Delete task queue", "Delete a queue and its tasks. A running queue must be stopped first."),
  ),
] as const
