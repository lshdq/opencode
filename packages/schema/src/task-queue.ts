export * as TaskQueue from "./task-queue.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { AbsolutePath, NonNegativeInt, optional, PositiveInt, statics } from "./schema.js"
import { SessionID } from "./session-id.js"
import { Form } from "./form.js"

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

/** Lifecycle independent of phase: planning owns a running lease; ready parks as queued until manual start. */
export const Status = Schema.Literals(["queued", "running", "done", "stopped", "interrupted"]).annotate({
  identifier: "TaskQueue.Status",
})
export type Status = typeof Status.Type

/** New tasks plan before becoming ready; execution then retains the historical running/terminal states. */
export const TaskStatus = Schema.Literals([
  "pending",
  "planning",
  "ready",
  "running",
  "interrupted",
  "completed",
  "failed",
  "blocked",
  "cancelled",
]).annotate({ identifier: "TaskQueue.TaskStatus" })
export type TaskStatus = typeof TaskStatus.Type

export const Phase = Schema.Literals(["planning", "ready", "execution"]).annotate({ identifier: "TaskQueue.Phase" })
export type Phase = typeof Phase.Type
export const TaskType = Schema.Literals(["development", "other"]).annotate({ identifier: "TaskQueue.TaskType" })
export type TaskType = typeof TaskType.Type
export const Approval = Schema.Struct({
  version: PositiveInt,
  formID: Form.ID,
  choice: Schema.Literals(["confirm", "auto", "interactive", "revise", "cancelled"]),
  answer: Form.Answer.pipe(optional),
  time: NonNegativeInt,
}).annotate({ identifier: "TaskQueue.Approval" })
export interface Approval extends Schema.Schema.Type<typeof Approval> {}
export const Plan = Schema.Struct({
  version: PositiveInt,
  requirementsVersion: PositiveInt,
  type: TaskType,
  requirements: Schema.String,
  acceptance: Schema.Array(Schema.String),
  dependencies: Schema.Array(TaskID),
  proposal: Schema.String.pipe(optional),
  requirementsApproval: Approval.pipe(optional),
  approval: Approval.pipe(optional),
  mode: Schema.Literals(["auto", "interactive"]).pipe(optional),
}).annotate({ identifier: "TaskQueue.Plan" })
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

/** Only the current planning root can submit these through task_queue_plan. No caller-supplied approval. */
export const PlanInput = Schema.Union([
  Schema.Struct({ stage: Schema.Literal("requirements"), version: NonNegativeInt, type: TaskType,
    requirements: Schema.String.check(Schema.isPattern(/\S/u)),
    acceptance: Schema.NonEmptyArray(Schema.String.check(Schema.isPattern(/\S/u))), dependencies: Schema.Array(TaskID) }),
  Schema.Struct({ stage: Schema.Literal("proposal"), version: PositiveInt, proposal: Schema.String.check(Schema.isPattern(/\S/u)) }),
]).annotate({ identifier: "TaskQueue.PlanInput" })
export type PlanInput = typeof PlanInput.Type

export function approved(plan: Plan | undefined) {
  return !!plan && plan.requirementsApproval?.choice === "confirm" &&
    plan.requirementsApproval.version === plan.requirementsVersion && !!plan.proposal &&
    plan.approval?.version === plan.version && plan.approval.choice === "auto" && plan.mode === "auto"
}

export interface Task extends Schema.Schema.Type<typeof Task> {}
export const Task = Schema.Struct({
  id: TaskID,
  title: Schema.String,
  prompt: Schema.String,
  status: TaskStatus,
  /** 1-based execution order within the queue. */
  position: PositiveInt,
  /** Stable Session shared by planning and execution; allocated when planning first starts. */
  sessionID: SessionID.pipe(optional),
  /** Continuation rounds the completion review has requested. */
  rounds: NonNegativeInt,
  /** Why the task blocked or failed. */
  reason: Schema.String.pipe(optional),
  /** Evidence summary recorded when the task completed. */
  summary: Schema.String.pipe(optional),
  plan: Plan.pipe(optional),
  time: Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt }),
}).annotate({ identifier: "TaskQueue.Task" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  title: Schema.String.pipe(optional),
  /** Every task session is created in this directory, so later tasks see earlier tasks' file changes. */
  directory: AbsolutePath,
  status: Status,
  /** Absent on old clients; version 1 queues retain their historical execution semantics. */
  workflowVersion: PositiveInt.pipe(optional),
  phase: Phase.pipe(optional),
  snapshot: AbsolutePath.pipe(optional),
  reason: Schema.String.pipe(optional),
  currentTaskID: TaskID.pipe(optional),
  tasks: Schema.Array(Task),
  time: Schema.Struct({ created: NonNegativeInt, updated: NonNegativeInt }),
}).annotate({ identifier: "TaskQueue.Info" })

export interface TaskInput extends Schema.Schema.Type<typeof TaskInput> {}
export const TaskInput = Schema.Struct({
  /** Omit to derive a short name from the first non-empty prompt line. */
  title: Schema.String.check(Schema.isMinLength(1)).pipe(optional),
  prompt: Schema.String.check(Schema.isPattern(/\S/u)),
}).annotate({ identifier: "TaskQueue.TaskInput" })

/** Display-only name; the full prompt is stored unchanged. Empty prompts have no name. */
export function titleFromPrompt(prompt: string) {
  const line = prompt.split(/\r\n|[\n\r\u2028\u2029]/u).find((line) => line.trim())?.trim() ?? ""
  const characters = Array.from(line)
  return characters.length > 80 ? `${characters.slice(0, 79).join("")}…` : line
}

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
