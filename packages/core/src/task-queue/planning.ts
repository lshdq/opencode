export * as TaskQueuePlanning from "./planning.js"

import { and, asc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { TaskQueue } from "@opencode/schema/task-queue"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { Form } from "../form.js"
import type { SessionSchema } from "../session/schema.js"
import { TaskQueueTable, TaskQueueTaskTable } from "./sql.js"
import { toInfo } from "./state.js"

// Deliberately independent of Session, plugins and the scheduler: plugin activation must not
// introduce TaskQueue -> Session -> internal plugins -> TaskQueue cycles.
export class InvalidError extends Schema.TaggedError<InvalidError>()("TaskQueuePlanning.InvalidError", { reason: Schema.String }) {
  override get message() { return this.reason }
}
export interface Interface {
  readonly submit: (sessionID: SessionSchema.ID, input: TaskQueue.PlanInput, forms: Form.Interface) => Effect.Effect<TaskQueue.Plan, InvalidError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/TaskQueuePlanning") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const current = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const task = yield* db.select().from(TaskQueueTaskTable).where(eq(TaskQueueTaskTable.session_id, sessionID)).get().pipe(Effect.orDie)
    const queue = task && (yield* db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, task.queue_id)).get().pipe(Effect.orDie))
    if (!task || !queue || queue.workflow_version !== 2 || queue.phase !== "planning" || queue.status !== "running" ||
      queue.closing || queue.owner_pid !== process.pid || !queue.run_id || queue.current_task_id !== task.id ||
      queue.lease_expires_at === null || queue.lease_expires_at <= (yield* Clock.currentTimeMillis) || task.status !== "planning" || !task.accepting)
      return yield* new InvalidError({ reason: "Only the active planning root Session may submit a plan" })
    return { task, queue }
  })
  const publish = Effect.fnUntraced(function* (id: TaskQueue.ID) {
    const queue = yield* db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, id)).get().pipe(Effect.orDie)
    if (!queue) return
    const tasks = yield* db.select().from(TaskQueueTaskTable).where(eq(TaskQueueTaskTable.queue_id, id)).orderBy(asc(TaskQueueTaskTable.position)).all().pipe(Effect.orDie)
    yield* bus.publish(TaskQueue.Event.Updated, toInfo(queue, tasks))
  })
  return Service.of({ submit: Effect.fn("TaskQueuePlanning.submit")(function* (sessionID, input, forms) {
    const formID = Form.ID.create()
    const saved = yield* db.transaction(() => Effect.gen(function* () {
      const { task, queue } = yield* current(sessionID)
      if ((task.plan?.version ?? 0) !== input.version) return yield* new InvalidError({ reason: "The plan version changed; reload before submitting" })
      const rows = yield* db.select().from(TaskQueueTaskTable).where(eq(TaskQueueTaskTable.queue_id, queue.id)).orderBy(asc(TaskQueueTaskTable.position)).all().pipe(Effect.orDie)
      if (input.stage === "requirements" && (new Set(input.dependencies).size !== input.dependencies.length || input.dependencies.some((id) => !rows.some((row) => row.id === id && row.position < task.position))))
        return yield* new InvalidError({ reason: "Dependencies must be distinct earlier tasks in this batch" })
      const previous = task.plan
      if (input.stage === "proposal" && (!previous || previous.requirementsApproval?.choice !== "confirm" || previous.requirementsApproval.version !== previous.requirementsVersion))
        return yield* new InvalidError({ reason: "Confirm requirements with the user before submitting a proposal" })
      const version = input.version + 1
      const plan: TaskQueue.Plan = input.stage === "requirements"
        ? { version, requirementsVersion: version, type: input.type, requirements: input.requirements, acceptance: input.acceptance, dependencies: input.dependencies }
        : previous ? { ...previous, version, proposal: input.proposal, approval: undefined, mode: undefined } : yield* new InvalidError({ reason: "Missing requirements" })
      // Invalidation propagates through the ordered DAG, in the same write reservation as revision.
      const invalid = new Set([task.id])
      for (const row of rows) {
        if (row.id === task.id || !row.plan?.dependencies.some((id) => invalid.has(id))) continue
        invalid.add(row.id)
        const { approval: _approval, requirementsApproval: _requirementsApproval, mode: _mode, ...previous } = row.plan
        yield* db.update(TaskQueueTaskTable).set({ plan: { ...previous, version: previous.version + 1 }, status: "pending", reason: "An upstream plan changed; reconfirm this task", time_updated: yield* Clock.currentTimeMillis }).where(eq(TaskQueueTaskTable.id, row.id)).run().pipe(Effect.orDie)
      }
      yield* db.update(TaskQueueTaskTable).set({ plan, time_updated: yield* Clock.currentTimeMillis }).where(eq(TaskQueueTaskTable.id, task.id)).run().pipe(Effect.orDie)
      return { plan, task, queue }
    }), { behavior: "immediate" }).pipe(Effect.catchTag("SqlError", Effect.die))
    yield* publish(saved.queue.id)
    const state = yield* forms.ask({ id: formID, sessionID, title: input.stage === "requirements" ? "确认需求" : "确认方案与执行模式",
      metadata: { kind: "taskqueue.plan", queueID: saved.queue.id, taskID: saved.task.id, version: saved.plan.version, stage: input.stage },
      fields: [{ key: "decision", type: "string", required: true, custom: false,
        description: input.stage === "requirements" ? `任务类型：${saved.plan.type}\n依赖：${saved.plan.dependencies.join(", ")}\n\n${saved.plan.requirements}\n\n验收标准：\n${saved.plan.acceptance.join("\n")}` : saved.plan.proposal,
        options: input.stage === "requirements"
          ? [{ value: "confirm", label: "确认需求" }, { value: "revise", label: "不通过，继续澄清" }]
          : [{ value: "auto", label: "确认方案并使用 Auto 模式" }, { value: "interactive", label: "确认方案并使用交互决策模式" }, { value: "revise", label: "不通过，继续修改方案" }] }],
    }).pipe(Effect.orDie)
    const decision = state.status === "answered" ? state.answer.decision : "cancelled"
    const choice = decision === "auto" || decision === "interactive" || decision === "confirm" || decision === "cancelled" ? decision : "revise"
    const plan = yield* db.transaction(() => Effect.gen(function* () {
      const fresh = yield* current(sessionID)
      if (fresh.queue.run_id !== saved.queue.run_id || fresh.task.plan?.version !== saved.plan.version)
        return yield* new InvalidError({ reason: "This approval is for an obsolete plan or owner run" })
      const approval: TaskQueue.Approval = { version: saved.plan.version, formID, choice, ...(state.status === "answered" ? { answer: state.answer } : {}), time: yield* Clock.currentTimeMillis }
      // Choices are interpreted by stage, never by matching natural-language text.
      const plan: TaskQueue.Plan = input.stage === "requirements"
        ? { ...saved.plan, requirementsApproval: { ...approval, choice: choice === "confirm" ? "confirm" : choice === "cancelled" ? "cancelled" : "revise" } }
        : { ...saved.plan, approval: { ...approval, choice: choice === "auto" || choice === "interactive" || choice === "cancelled" ? choice : "revise" },
          ...(choice === "auto" || choice === "interactive" ? { mode: choice } : {}) }
      yield* db.update(TaskQueueTaskTable).set({ plan, time_updated: yield* Clock.currentTimeMillis }).where(and(eq(TaskQueueTaskTable.id, fresh.task.id), eq(TaskQueueTaskTable.accepting, true))).run().pipe(Effect.orDie)
      return plan
    }), { behavior: "immediate" }).pipe(Effect.catchTag("SqlError", Effect.die))
    yield* publish(saved.queue.id)
    return plan
  }) })
}))
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })

/** Closed read-only catalog: no shell, subagents, Code Mode or arbitrary plugin tools in planning. */
export const readOnlyTools = new Set(["read", "glob", "grep", "webfetch", "websearch", "skill", "question", "task_queue_plan"])
