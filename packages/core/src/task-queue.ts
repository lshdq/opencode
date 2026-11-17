export * as TaskQueue from "./task-queue.js"

import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { AbsolutePath } from "@opencode/schema/schema"
import { CreateInput, Event, ID, Info, Status, TaskID, TaskInput, TaskStatus, type Task } from "@opencode/schema/task-queue"
import { Form } from "./form.js"
import { Permission } from "./permission.js"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { Instance } from "./instance/service.js"
import { Job } from "./job.js"
import { LocationServiceMap } from "./location-service-map.js"
import { Session } from "./session.js"
import { SessionBackground } from "./session/background.js"
import { SessionExecution } from "./session/execution.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { Shell } from "./shell.js"
import { TaskQueueOwnership } from "./task-queue/ownership.js"
import { TaskQueueTable, TaskQueueTaskTable } from "./task-queue/sql.js"
import CONTINUATION from "./task-queue/continuation.txt"
import JUDGE from "./task-queue/judge.txt"
import KICKOFF from "./task-queue/kickoff.txt"

export { CreateInput, Event, ID, Info, Status, TaskID, TaskInput, TaskStatus }
export type { Task }

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("TaskQueue.NotFoundError", { queueID: ID }) {
  override get message() {
    return `Task queue not found: ${this.queueID}`
  }
}
export class InvalidError extends Schema.TaggedError<InvalidError>()("TaskQueue.InvalidError", { reason: Schema.String }) {
  override get message() {
    return this.reason
  }
}

export type Verdict = {
  readonly verdict: "done" | "continue" | "blocked" | "wait"
  readonly reason: string
  readonly next_step?: string
}
export type JudgeInput = {
  readonly session: SessionSchema.Info
  readonly task: Task
  readonly shells: ReadonlyArray<string>
}
export type Judge = (input: JudgeInput) => Effect.Effect<Verdict | undefined>
const Judge = Context.Reference<Judge | undefined>("@opencode/TaskQueue/Judge", { defaultValue: () => undefined })

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidError>
  readonly list: (input?: { readonly directory?: AbsolutePath }) => Effect.Effect<Info[]>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: ID) => Effect.Effect<void, NotFoundError | InvalidError>
  readonly start: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidError>
  readonly heartbeat: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidError>
  readonly stop: (id: ID, reason?: string) => Effect.Effect<Info, NotFoundError | InvalidError>
  /** Explicitly retries unfinished tasks, including blocked/failed tasks in a finished batch, in their original Sessions. */
  readonly resume: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/TaskQueue") {}
type QueueRow = typeof TaskQueueTable.$inferSelect
type TaskRow = typeof TaskQueueTaskTable.$inferSelect
type Run = { readonly id: ID; readonly token: string }
const LEASE_TTL = 30_000
const LEASE_SCAN = 5_000
const MAX_ROUNDS = 20
const MAX_STALLS = 3
const BACKGROUND_WAIT = 120_000
const BACKGROUND_POLL = 5_000
const REJECT_MESSAGE = "Batch task queue runs unattended: this approval was not granted. Skip or work around it if possible, finish the remaining work, and report what needs approval."
const CANCEL_MESSAGE = "Batch task queue runs unattended: questions cannot be answered. Continue with reasonable defaults or report what is blocked."

export const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const sessions = yield* Session.Service
  const execution = yield* SessionExecution.Service
  const jobs = yield* Job.Service
  const store = yield* SessionStore.Service
  const instances = yield* Instance.Service
  const scope = yield* Scope.Scope
  const boot = randomUUID()
  const locks = yield* KeyedMutex.make<ID>()
  const fibers = new Map<ID, Fiber.Fiber<void>>()
  const injected = yield* Judge
  const judge = injected ?? defaultJudge(sessions)

  const findQueue = (id: ID) => db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, id)).get().pipe(
    Effect.orDie,
    Effect.flatMap((row) => row ? Effect.succeed(row) : Effect.fail(new NotFoundError({ queueID: id }))),
  )
  const findTask = (id: TaskID) => db.select().from(TaskQueueTaskTable).where(eq(TaskQueueTaskTable.id, id)).get().pipe(Effect.orDie)
  const taskRows = (id: ID) => db.select().from(TaskQueueTaskTable).where(eq(TaskQueueTaskTable.queue_id, id)).orderBy(asc(TaskQueueTaskTable.position)).all().pipe(Effect.orDie)
  const info = Effect.fnUntraced(function* (id: ID) { return toInfo(yield* findQueue(id), yield* taskRows(id)) })
  const publish = (id: ID) => info(id).pipe(Effect.orDie, Effect.flatMap((value) => bus.publish(Event.Updated, value)))
  const owns = (run: Run) => and(
    eq(TaskQueueTable.id, run.id),
    eq(TaskQueueTable.run_id, run.token),
    eq(TaskQueueTable.owner_boot, boot),
    eq(TaskQueueTable.status, "running"),
  )
  const eligible = Effect.fnUntraced(function* (run: Run) {
    const queue = yield* findQueue(run.id).pipe(Effect.orDie)
    return queue.status === "running" && !queue.closing && queue.run_id === run.token && queue.owner_boot === boot &&
      queue.lease_expires_at !== null && queue.lease_expires_at > (yield* Clock.currentTimeMillis)
  })
  // Creation/admission and state transitions share this lock, never model execution or review.
  // Stop can always close admission before interrupting a long-running judge or drain.
  const boundary = <A, E>(run: Run, effect: Effect.Effect<A, E>) => locks.withLock(run.id)(
    eligible(run).pipe(Effect.flatMap((allowed) => allowed ? effect : Effect.succeed(undefined))),
  )
  const admit = (run: Run, input: Parameters<Session.Interface["synthetic"]>[0]) =>
    locks.withLock(run.id)(
      db.transaction(
        () => eligible(run).pipe(
          Effect.flatMap((allowed) => allowed ? sessions.synthetic(input) : Effect.succeed(undefined)),
        ),
        { behavior: "immediate" },
      ).pipe(Effect.orDie),
    )
  const taskTree = Effect.fnUntraced(function* (root: SessionSchema.ID): Effect.fn.Return<SessionSchema.ID[]> {
    const children = yield* store.list({ parentID: root })
    return [root, ...(yield* Effect.forEach(children, (child) => taskTree(child.id))).flat()]
  })
  const outstanding = (root: SessionSchema.ID) => execution.active.pipe(
    Effect.flatMap((active) => SessionBackground.outstanding(jobs, store, root, active)),
  )
  const awaitBackground = Effect.fnUntraced(function* (root: SessionSchema.ID) {
    const deadline = (yield* Clock.currentTimeMillis) + BACKGROUND_WAIT
    while ((yield* execution.isActive(root)) || (yield* outstanding(root)).length > 0) {
      if ((yield* Clock.currentTimeMillis) >= deadline) return false
      yield* Effect.sleep(BACKGROUND_POLL)
    }
    return true
  })
  /** Fence first. Interrupt is only acknowledgement: wait for all executions, jobs AND daemon commands. */
  const stopTree = Effect.fnUntraced(function* (root: SessionSchema.ID) {
    // The second traversal catches a child created while its parent's interrupted tool was finalizing.
    let previous = new Set<SessionSchema.ID>()
    while (true) {
      const tree = yield* taskTree(root)
      yield* Effect.forEach(tree, (id) => execution.interrupt(id), { discard: true, concurrency: "unbounded" })
      yield* Effect.forEach(tree, (id) => jobs.cancelSession(id), { discard: true })
      yield* Effect.forEach(tree, (id) => execution.awaitIdle(id), { discard: true, concurrency: "unbounded" })
      // Shell daemon commands can outlive the server and their Job registry. Never delete a row as proof of exit.
      yield* Effect.forEach(tree, (id) => Effect.gen(function* () {
        const session = yield* store.get(id)
        if (!session) return
        yield* Effect.gen(function* () {
          const shell = Option.getOrUndefined(yield* Effect.serviceOption(Shell.Service))
          if (!shell) return
          const commands = (yield* shell.list()).filter((item) => item.metadata.sessionID === id && item.status === "running")
          yield* Effect.forEach(commands, (command) => Effect.gen(function* () {
            yield* shell.stop(command.id, "killed")
            const result = yield* shell.result(command)
            if (result.info.status === "running") return yield* Effect.die("Task shell did not stop")
          }), { discard: true })
        }).pipe(instances.provide(session), Effect.orDie)
        yield* store.release(id)
      }), { discard: true })
      const active = yield* execution.active
      if (tree.every((id) => previous.has(id) && !active.has(id)) && (yield* outstanding(root)).length === 0) return
      previous = new Set(tree)
    }
  })

  const stopQueue = (id: ID, reason: string, terminal: "stopped" | "interrupted" = "stopped") => Effect.gen(function* () {
    const intent = yield* findQueue(id)
    if (intent.status !== "running") return
    if (intent.owner_boot !== boot) return yield* new InvalidError({ reason: "This queue is owned by another live server" })
    // Do not wait for the creation/admission lock to close the gate: create may be in flight.
    const closed = yield* db
      .update(TaskQueueTable)
      .set({ closing: true, reason })
      .where(owns({ id, token: intent.run_id ?? "" }))
      .returning()
      .get()
      .pipe(Effect.orDie)
    if (!closed) return
    yield* TaskQueueOwnership.fence(db, id)
    yield* locks.withLock(id)(Effect.gen(function* () {
      const row = yield* findQueue(id)
      if (row.status !== "running" || row.run_id !== intent.run_id || row.owner_boot !== boot) return
      const now = yield* Clock.currentTimeMillis
      const fiber = fibers.get(id)
      if (fiber) yield* Fiber.interrupt(fiber)
      fibers.delete(id)
      // Includes previous tasks: a late notification from a completed task must not leave work behind.
      yield* Effect.forEach(yield* taskRows(id), (task) => Effect.gen(function* () {
        if (!task.session_id) return
        yield* stopTree(task.session_id)
        // A stop can win after ID allocation but before Session.create. Do not retain a link to a Session
        // that never existed; a manual resume will create the task's first actual Session instead.
        if (task.status === "running" && !(yield* store.get(task.session_id))) {
          yield* db.update(TaskQueueTaskTable).set({ session_id: null }).where(eq(TaskQueueTaskTable.id, task.id)).run().pipe(Effect.orDie)
        }
      }), { discard: true })
      yield* db
        .update(TaskQueueTaskTable)
        .set({ status: "interrupted", accepting: false, time_updated: now })
        .where(and(eq(TaskQueueTaskTable.queue_id, id), eq(TaskQueueTaskTable.status, "running")))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .update(TaskQueueTable)
        .set({ status: terminal, closing: false, lease_expires_at: null, time_updated: yield* Clock.currentTimeMillis })
        .where(and(eq(TaskQueueTable.id, id), eq(TaskQueueTable.run_id, row.run_id ?? "")))
        .run()
        .pipe(Effect.orDie)
      yield* publish(id)
    }))
  }).pipe(Effect.uninterruptible)
  const requestStop = (run: Run, reason: string) => boundary(run, Effect.gen(function* () {
    yield* db.update(TaskQueueTable).set({ closing: true, reason }).where(owns(run)).run().pipe(Effect.orDie)
    yield* TaskQueueOwnership.fence(db, run.id)
    yield* stopQueue(run.id, reason).pipe(Effect.orDie, Effect.forkIn(scope))
  })).pipe(Effect.asVoid)
  const finishTask = Effect.fnUntraced(function* (run: Run, task: TaskRow, root: SessionSchema.ID, status: "completed" | "blocked" | "failed", fields: { reason?: string; summary?: string }) {
    const cleared = yield* awaitBackground(root)
    // Close the wake gate before cancelling anything, including completed-job notification observers.
    if (!(yield* boundary(run, db.update(TaskQueueTaskTable).set({ accepting: false }).where(eq(TaskQueueTaskTable.id, task.id)).returning().get().pipe(Effect.orDie)))) return
    yield* stopTree(root)
    yield* boundary(run, Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* db.update(TaskQueueTaskTable).set({
        status: !cleared && status === "completed" ? "blocked" : status,
        reason: !cleared ? [fields.reason, "Timed out waiting for background work; all remaining work was stopped"].filter(Boolean).join("\n") : fields.reason ?? null,
        summary: fields.summary ?? null, accepting: false, time_updated: now,
      }).where(and(eq(TaskQueueTaskTable.id, task.id), eq(TaskQueueTaskTable.status, "running"))).run().pipe(Effect.orDie)
      yield* db.update(TaskQueueTable).set({ current_task_id: null, time_updated: now }).where(owns(run)).run().pipe(Effect.orDie)
      yield* publish(run.id)
    }))
  })
  const awaitExecution = Effect.fnUntraced(function* (root: SessionSchema.ID) {
    // An interrupted Session interrupts its joiners, not the scheduler itself.
    const fiber = yield* execution.resume(root).pipe(Effect.forkIn(scope, { startImmediately: true }))
    return SessionExecution.terminal(yield* Fiber.await(fiber))
  })
  const runTask = Effect.fnUntraced(function* (run: Run, queue: QueueRow, task: TaskRow) {
    const root = yield* boundary(run, Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const root = task.session_id ?? SessionSchema.ID.create()
      // Allocate and link before create: even interruption during creation has durable ownership.
      const claimed = yield* db
        .update(TaskQueueTaskTable)
        .set({ status: "running", session_id: root, accepting: true, time_updated: now })
        .where(and(eq(TaskQueueTaskTable.id, task.id), inArray(TaskQueueTaskTable.status, ["pending", "interrupted"])))
        .returning()
        .get()
        .pipe(Effect.orDie)
      if (!claimed) return
      yield* db.update(TaskQueueTable).set({ current_task_id: task.id, time_updated: now }).where(owns(run)).run().pipe(Effect.orDie)
      // A stop may have closed the gate while the task's durable identity was being allocated.
      if (yield* eligible(run)) yield* sessions.create({
        id: root,
        location: { directory: queue.directory },
        title: task.title,
        metadata: { source: "taskqueue", taskqueue: { queueID: run.id, taskID: task.id } },
      })
      yield* publish(run.id)
      return root
    }).pipe(Effect.uninterruptible))
    if (!root) return
    yield* admit(run, { sessionID: root,
      text: task.status === "pending" ? render(KICKOFF, { title: escape(task.title), task: escape(task.prompt) }) : continuation(task, ["The task queue resumed; continue working toward the task."]),
      description: `Task: ${truncate(task.title, 120)}`, metadata: { taskqueue: { queueID: run.id, taskID: task.id } }, delivery: "steer", resume: false,
    })
    while (yield* eligible(run)) {
      const outcome = yield* awaitExecution(root)
      if (!(yield* eligible(run))) return
      if (outcome.type === "interrupted") {
        yield* requestStop(run, "the current task was interrupted")
        return
      }
      const fresh = yield* findTask(task.id)
      if (!fresh) return
      if (outcome.type === "failed") {
        yield* finishTask(run, fresh, root, "failed", { reason: outcome.error.message })
        return
      }
      const shells = (yield* outstanding(root)).flatMap((item) => item.kind === "shell" ? [item.command] : [])
      const verdict = yield* judge({ session: yield* sessions.get(root), task: toTask(fresh), shells })
      if (!(yield* eligible(run))) return
      if (!verdict || (verdict.verdict === "wait" && shells.length === 0)) {
        yield* finishTask(run, fresh, root, "blocked", { reason: "The completion review failed" })
        return
      }
      if (verdict.verdict === "done") {
        yield* finishTask(run, fresh, root, "completed", { summary: verdict.reason })
        return
      }
      if (verdict.verdict === "blocked") {
        yield* finishTask(run, fresh, root, "blocked", { reason: verdict.reason })
        return
      }
      if (verdict.verdict === "wait") {
        if (yield* awaitBackground(root)) continue
        // The bound has already elapsed. Fence and cancel immediately; do not wait a second bound.
        yield* boundary(run, db.update(TaskQueueTaskTable).set({ accepting: false }).where(eq(TaskQueueTaskTable.id, task.id)).run().pipe(Effect.orDie))
        yield* stopTree(root)
        yield* finishTask(run, fresh, root, "blocked", { reason: "Timed out waiting for background work the task needs" })
        return
      }
      const rounds = fresh.rounds + 1
      const stalls = sameReason(fresh.reason, verdict.reason) || !(yield* usedTools(root, task.id)) ? fresh.stalls + 1 : 0
      yield* boundary(run, db.update(TaskQueueTaskTable).set({ rounds, stalls, reason: verdict.reason, time_updated: yield* Clock.currentTimeMillis }).where(eq(TaskQueueTaskTable.id, task.id)).run().pipe(Effect.orDie))
      if (stalls >= MAX_STALLS || rounds >= MAX_ROUNDS) {
        yield* finishTask(run, fresh, root, "blocked", { reason: `Stopped after ${rounds} review rounds without completing: ${verdict.reason}` })
        return
      }
      yield* admit(run, { sessionID: root, text: continuation(fresh, [verdict.reason, verdict.next_step]), metadata: { taskqueue: { queueID: run.id, taskID: task.id } }, delivery: "steer", resume: false })
    }
  })
  const drive = Effect.fnUntraced(function* (run: Run) {
    while (yield* eligible(run)) {
      const queue = yield* findQueue(run.id).pipe(Effect.orDie)
      const rows = yield* taskRows(run.id)
      const next = rows.find((row) => row.status === "interrupted") ?? rows.find((row) => row.status === "pending")
      if (!next) {
        yield* boundary(run, Effect.gen(function* () {
          const finished = yield* db.update(TaskQueueTable).set({ status: "done", current_task_id: null, lease_expires_at: null, time_updated: yield* Clock.currentTimeMillis }).where(and(owns(run), eq(TaskQueueTable.closing, false))).returning().get().pipe(Effect.orDie)
          if (finished) yield* publish(run.id)
        }))
        return
      }
      yield* runTask(run, queue, next)
    }
  })
  const spawn = Effect.fnUntraced(function* (run: Run) {
    const fiber = yield* drive(run).pipe(
      Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt :
        Effect.logError("task queue could not safely finish", { queueID: run.id, cause }).pipe(Effect.andThen(requestStop(run, `Task cleanup failed; manual recovery required: ${Cause.pretty(cause)}`)))),
      Effect.forkIn(scope),
    )
    fibers.set(run.id, fiber)
    yield* Fiber.await(fiber).pipe(
      Effect.andThen(Effect.sync(() => {
        if (fibers.get(run.id) === fiber) fibers.delete(run.id)
      })),
      Effect.forkIn(scope),
    )
  })
  const usedTools = Effect.fnUntraced(function* (root: SessionSchema.ID, taskID: TaskID) {
    const messages = yield* sessions.context(root)
    const start = messages.findLastIndex((message) => (message.type === "synthetic" || message.type === "user") && taskIDOf(message.metadata) === taskID)
    return start === -1 || messages.slice(start + 1).some((message) => message.type === "assistant" && message.content.some((part) => part.type === "tool"))
  })

  // Includes the closing/cleanup window; unrelated Sessions retain their interactive lifecycle.
  const unattended = Effect.fnUntraced(function* (id: string) {
    if (!Schema.is(SessionSchema.ID)(id)) return
    const owned = yield* TaskQueueOwnership.find(db, store, id)
    if (owned?.queue?.status !== "running" || owned.queue.owner_boot !== boot) return
    return yield* store.get(id)
  })
  yield* bus.subscribe([Permission.Event.Asked, Form.Event.Created]).pipe(Stream.runForEach((event) => Effect.gen(function* () {
    if (event.type === Permission.Event.Asked.type) {
      const session = yield* unattended(event.data.sessionID)
      if (session) yield* Permission.Service.use((permission) => permission.reply({ requestID: event.data.id, reply: "reject", message: REJECT_MESSAGE })).pipe(instances.provide(session), Effect.catchTag("Permission.NotFoundError", () => Effect.void))
      return
    }
    const session = yield* unattended(event.data.form.sessionID)
    if (session) yield* Form.Service.use((forms) => forms.cancel(event.data.form.id, { message: CANCEL_MESSAGE })).pipe(instances.provide(session), Effect.catchTags({ "Form.NotFoundError": () => Effect.void, "Form.AlreadySettledError": () => Effect.void }))
  }).pipe(Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError("unattended reply failed", { cause })))), Effect.forkIn(scope, { startImmediately: true }))

  const recoverQueue = (id: ID, reason: string, terminal: "stopped" | "interrupted") =>
    stopQueue(id, reason, terminal).pipe(
      Effect.ignoreCause({ log: "Error", message: "Task queue recovery could not finish cleanup" }),
      Effect.forkIn(scope, { startImmediately: true }),
      Effect.asVoid,
    )
  const recover = Effect.fnUntraced(function* () {
    const now = yield* Clock.currentTimeMillis
    const expired = yield* db.select().from(TaskQueueTable).where(eq(TaskQueueTable.status, "running")).all().pipe(Effect.orDie)
    yield* Effect.forEach(expired, (row) => Effect.gen(function* () {
      if (row.owner_boot === boot) {
        // One slow cleanup must not prevent the watchdog from closing other directories' expired leases.
        if (row.closing || (row.lease_expires_at !== null && row.lease_expires_at > now)) return
        return yield* recoverQueue(row.id, "owner disconnected", "stopped")
      }
      // Lease expiry alone is not permission to interrupt a different, still-live process.
      if (row.owner_pid !== null && (yield* alive(row.owner_pid))) return
      if (row.owner_pid === null && row.lease_expires_at !== null && row.lease_expires_at > now) return
      const claimed = yield* db.update(TaskQueueTable).set({ owner_boot: boot, owner_pid: process.pid, closing: true, run_id: row.run_id ?? randomUUID() }).where(and(eq(TaskQueueTable.id, row.id), eq(TaskQueueTable.status, "running"), row.owner_boot === null ? isNull(TaskQueueTable.owner_boot) : eq(TaskQueueTable.owner_boot, row.owner_boot), row.lease_expires_at === null ? isNull(TaskQueueTable.lease_expires_at) : eq(TaskQueueTable.lease_expires_at, row.lease_expires_at))).returning().get().pipe(Effect.orDie)
      if (claimed) yield* recoverQueue(row.id, row.owner_pid === null ? "server restarted; owner lease expired" : "server restarted; previous owner is no longer running", "interrupted")
    }), { discard: true })
  })
  yield* recover()
  yield* Effect.sleep(LEASE_SCAN).pipe(Effect.andThen(recover()), Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError("task queue watchdog failed", { cause })), Effect.forever, Effect.forkIn(scope, { startImmediately: true }))
  // In particular, standalone stdin ownership teardown must not hand queue work to SessionRestart.
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    const owned = yield* db.select().from(TaskQueueTable).where(and(eq(TaskQueueTable.status, "running"), eq(TaskQueueTable.owner_boot, boot))).all().pipe(Effect.orDie)
    yield* Effect.forEach(owned, (row) => stopQueue(row.id, "server stopped").pipe(Effect.ignoreCause({ log: "Error", message: "Failed to stop task queue during shutdown" })), { discard: true })
  }))

  const arm = (id: ID, resume: boolean) => locks.withLock(id)(Effect.gen(function* () {
    const row = yield* findQueue(id)
    const rows = yield* taskRows(id)
    if (!resume && row.status !== "queued") return yield* new InvalidError({ reason: `Queue is ${row.status}; only a queued queue can start` })
    if (resume && (row.status === "running" || row.status === "queued" || !rows.some((task) => ["pending", "interrupted", "blocked", "failed"].includes(task.status))))
      return yield* new InvalidError({ reason: `Queue is ${row.status}; no stopped or unfinished tasks to resume` })
    const token = randomUUID()
    const now = yield* Clock.currentTimeMillis
    // One atomic SQL statement is the directory-level CAS, also across separate connections/processes.
    const occupied = db.select({ id: TaskQueueTable.id }).from(TaskQueueTable).where(and(directoryMatch(row.directory), eq(TaskQueueTable.status, "running")))
    const won = yield* db.update(TaskQueueTable).set({ status: "running", closing: false, reason: null, owner_boot: boot, owner_pid: process.pid, run_id: token, lease_expires_at: now + LEASE_TTL, time_updated: now }).where(and(eq(TaskQueueTable.id, id), eq(TaskQueueTable.status, row.status), row.run_id === null ? isNull(TaskQueueTable.run_id) : eq(TaskQueueTable.run_id, row.run_id), notExists(occupied))).returning().get().pipe(Effect.orDie)
    if (!won) return yield* new InvalidError({ reason: "Another batch is already running in this directory, or the queue changed" })
    // Resuming an interrupted forward scan must not revisit earlier blocked tasks. Only a deliberate
    // resume of the finished batch opens a retry pass over its unfinished terminal items.
    if (resume && row.status === "done") yield* db.update(TaskQueueTaskTable).set({ status: "interrupted", accepting: false, rounds: 0, stalls: 0, reason: null, time_updated: now }).where(and(eq(TaskQueueTaskTable.queue_id, id), inArray(TaskQueueTaskTable.status, ["blocked", "failed"]))).run().pipe(Effect.orDie)
    yield* publish(id)
    yield* spawn({ id, token })
    return yield* info(id)
  }).pipe(Effect.uninterruptible))

  return Service.of({
    create: Effect.fn("TaskQueue.create")(function* (input) {
      if (!input.tasks.length) return yield* new InvalidError({ reason: "A queue needs at least one task" })
      const directory = yield* canonicalDirectory(input.directory).pipe(Effect.mapError(() => new InvalidError({ reason: "The queue directory does not exist" })))
      const id = ID.create()
      const now = yield* Clock.currentTimeMillis
      yield* db.transaction((tx) => Effect.gen(function* () {
        yield* tx.insert(TaskQueueTable).values({ id, directory, title: input.title ?? null, time_created: now, time_updated: now }).run()
        yield* tx.insert(TaskQueueTaskTable).values(input.tasks.map((task, index) => ({ id: TaskID.create(), queue_id: id, position: index + 1, title: task.title, prompt: task.prompt, time_created: now, time_updated: now }))).run()
      })).pipe(Effect.orDie)
      yield* publish(id)
      return yield* info(id).pipe(Effect.orDie)
    }),
    list: Effect.fn("TaskQueue.list")(function* (input) {
      const directory = input?.directory ? yield* canonicalDirectory(input.directory).pipe(Effect.orElseSucceed(() => input.directory)) : undefined
      const rows = yield* db.select().from(TaskQueueTable).where(directory ? directoryMatch(directory) : undefined).orderBy(asc(TaskQueueTable.time_created), asc(TaskQueueTable.id)).all().pipe(Effect.orDie)
      return yield* Effect.forEach(rows, (row) => info(row.id).pipe(Effect.orDie))
    }),
    get: (id) => info(id),
    remove: (id) => locks.withLock(id)(Effect.gen(function* () {
      const row = yield* findQueue(id)
      if (row.status === "running") return yield* new InvalidError({ reason: "Stop the queue before removing it" })
      const removed = yield* db.delete(TaskQueueTable).where(and(eq(TaskQueueTable.id, id), eq(TaskQueueTable.status, row.status))).returning().get().pipe(Effect.orDie)
      if (!removed) return yield* new InvalidError({ reason: "The queue changed; stop it before removing it" })
    })),
    start: (id) => arm(id, false),
    resume: (id) => arm(id, true),
    heartbeat: (id) => locks.withLock(id)(Effect.gen(function* () {
      const row = yield* findQueue(id)
      const now = yield* Clock.currentTimeMillis
      if (row.status !== "running" || row.closing || row.owner_boot !== boot || row.lease_expires_at === null || row.lease_expires_at <= now)
        return yield* new InvalidError({ reason: "Queue is not running on this server or its lease expired" })
      const renewed = yield* db.update(TaskQueueTable).set({ lease_expires_at: now + LEASE_TTL, time_updated: now }).where(and(owns({ id, token: row.run_id ?? "" }), eq(TaskQueueTable.closing, false))).returning().get().pipe(Effect.orDie)
      if (!renewed) return yield* new InvalidError({ reason: "Queue ownership changed" })
      return yield* info(id)
    })),
    stop: (id, reason = "stopped by the user") => stopQueue(id, reason).pipe(Effect.andThen(info(id))),
  })
})

function toTask(row: TaskRow): Task {
  return { id: row.id, title: row.title, prompt: row.prompt, status: row.status, position: row.position,
    ...(row.session_id === null ? {} : { sessionID: row.session_id }), rounds: row.rounds,
    ...(row.reason === null ? {} : { reason: row.reason }), ...(row.summary === null ? {} : { summary: row.summary }),
    time: { created: row.time_created, updated: row.time_updated } }
}
function toInfo(row: QueueRow, tasks: readonly TaskRow[]): Info {
  return { id: row.id, ...(row.title === null ? {} : { title: row.title }), directory: row.directory, status: row.status,
    ...(row.reason === null ? {} : { reason: row.reason }), ...(row.current_task_id === null ? {} : { currentTaskID: row.current_task_id }), tasks: tasks.map(toTask), time: { created: row.time_created, updated: row.time_updated } }
}
/** Shared local directory identity for queue storage, locking, and the server's flag gate. */
export const canonicalDirectory = (directory: AbsolutePath) => Effect.tryPromise(() => realpath(directory)).pipe(
  Effect.map((value) => LocationServiceMap.canonical({ directory: AbsolutePath.make(value) }).directory),
)
const directoryMatch = (directory: AbsolutePath) => process.platform === "win32"
  ? sql`${TaskQueueTable.directory} = ${directory} COLLATE NOCASE`
  : eq(TaskQueueTable.directory, directory)
// EPERM/unknown errors mean "possibly alive", never permission to take over.
const alive = (pid: number) => Effect.try({ try: () => { process.kill(pid, 0); return true }, catch: (error) => error }).pipe(Effect.orElseSucceed((error) => !(error instanceof Error && "code" in error && error.code === "ESRCH")))
function taskIDOf(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.taskqueue
  return typeof value === "object" && value !== null && "taskID" in value && typeof value.taskID === "string" ? value.taskID : undefined
}
const VerdictSchema = Schema.Struct({ verdict: Schema.Literals(["done", "continue", "blocked", "wait"]), reason: Schema.String, next_step: Schema.optionalKey(Schema.String) })
const decodeVerdict = Schema.decodeUnknownOption(Schema.fromJsonString(VerdictSchema))
function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  return start === -1 || end < start ? undefined : Option.getOrUndefined(decodeVerdict(text.slice(start, end + 1)))
}
const defaultJudge = (sessions: Session.Interface): Judge => (input) => Effect.gen(function* () {
  const attempt = sessions.generate({ sessionID: input.session.id, prompt: render(JUDGE, {
    title: escape(input.task.title), task: escape(input.task.prompt),
    background: input.shells.length === 0 ? "No background shells are running." : ["Background shells still running:", ...input.shells.map((command) => `- ${command}`)].join("\n"),
    wait: input.shells.length === 0 ? "" : '{"verdict":"wait","reason":"<the running shell whose result the task needs>"}\n',
  }) }).pipe(
    Effect.map((result) => {
      const verdict = parseVerdict(result.text)
      return verdict?.verdict === "wait" && input.shells.length === 0 ? undefined : verdict
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  )
  return (yield* attempt) ?? (yield* attempt)
})
function continuation(task: TaskRow, feedback: ReadonlyArray<string | undefined>) {
  return render(CONTINUATION, { title: escape(task.title), task: escape(task.prompt), feedback: feedback.filter(Boolean).join("\n") })
}
function render(template: string, values: Record<string, string>) { return template.replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match) }
function truncate(text: string, length: number) { const line = text.replace(/\s+/g, " "); return line.length > length ? `${line.slice(0, length - 1)}…` : line }
function escape(text: string) { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") }
function sameReason(previous: string | null | undefined, next: string) { const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " "); return previous !== null && previous !== undefined && normalize(previous) === normalize(next) }
const layer = Layer.effect(Service, make)
export function configured(options?: { readonly judge?: Judge }) {
  return makeGlobalNode({ service: Service, layer: options?.judge === undefined ? layer : layer.pipe(Layer.provide(Layer.succeed(Judge, options.judge))), deps: [Database.node, Bus.node, Session.node, SessionExecution.node, Job.node, SessionStore.node, Instance.node] })
}
export const node = configured()
