export * as TaskQueue from "./task-queue.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { AbsolutePath, NonNegativeInt, optional, PositiveInt, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const ID = Schema.String.check(Schema.isStartingWith("tq_")).pipe(
  Schema.brand("TaskQueue.ID"),
  Schema.annotate({ identifier: "TaskQueue.ID" }),
  statics((schema) => ({
    create: () => schema.make("tq_" + ascending()),
  })),
)
export type ID = typeof ID.Type

export const TaskID = Schema.String.check(Schema.isStartingWith("tqt_")).pipe(
  Schema.brand("TaskQueue.TaskID"),
  Schema.annotate({ identifier: "TaskQueue.TaskID" }),
  statics((schema) => ({
    create: () => schema.make("tqt_" + ascending()),
  })),
)
export type TaskID = typeof TaskID.Type

/** queued → running → done (all tasks handled) | stopped (user or owner loss) | interrupted (server restart). */
export const Status = Schema.Literals(["queued", "running", "done", "stopped", "interrupted"]).annotate({
  identifier: "TaskQueue.Status",
})
export type Status = typeof Status.Type

/** pending → running → interrupted (resumable) | completed | failed | blocked | cancelled. */
export const TaskStatus = Schema.Literals([
  "pending",
  "running",
  "interrupted",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]).annotate({ identifier: "TaskQueue.TaskStatus" })
export type TaskStatus = typeof TaskStatus.Type

export interface Task extends Schema.Schema.Type<typeof Task> {}
export const Task = Schema.Struct({
  id: TaskID,
  title: Schema.String,
  prompt: Schema.String,
  status: TaskStatus,
  /** 1-based execution order within the queue. */
  position: PositiveInt,
  /** The Session this task runs in; set once the task first starts. */
  sessionID: SessionID.pipe(optional),
  /** Continuation rounds the completion review has requested. */
  rounds: NonNegativeInt,
  /** Why the task blocked or failed. */
  reason: Schema.String.pipe(optional),
  /** Evidence summary recorded when the task completed. */
  summary: Schema.String.pipe(optional),
  time: Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt }),
}).annotate({ identifier: "TaskQueue.Task" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  title: Schema.String.pipe(optional),
  /** Every task session is created in this directory, so later tasks see earlier tasks' file changes. */
  directory: AbsolutePath,
  status: Status,
  reason: Schema.String.pipe(optional),
  currentTaskID: TaskID.pipe(optional),
  tasks: Schema.Array(Task),
  time: Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt }),
}).annotate({ identifier: "TaskQueue.Info" })

export interface TaskInput extends Schema.Schema.Type<typeof TaskInput> {}
export const TaskInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1)),
  prompt: Schema.String.check(Schema.isMinLength(1)),
}).annotate({ identifier: "TaskQueue.TaskInput" })

/** A queue as callers describe it: an ordered task list to run serially in one directory. */
export const CreateInput = Schema.Struct({
  title: Schema.String.pipe(optional),
  directory: AbsolutePath,
  tasks: Schema.NonEmptyArray(TaskInput),
}).annotate({ identifier: "TaskQueue.CreateInput" })
export type CreateInput = typeof CreateInput.Type

const Updated = ephemeral({ type: "taskqueue.updated", schema: Info.fields })

/** Published on every queue or task state change with the complete queue Info. */
export const Event = { Updated, Definitions: inventory(Updated) }
