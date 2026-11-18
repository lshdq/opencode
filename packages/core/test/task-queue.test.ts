import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import type { FileSystem } from "@opencode/core/filesystem"
import { Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { eq } from "drizzle-orm"
import { Agent } from "@opencode/core/agent"
import { App } from "@opencode/core/app"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Flag } from "@opencode/core/flag"
import { Form } from "@opencode/core/form"
import { Instance } from "@opencode/core/instance/service"
import { Job } from "@opencode/core/job"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Session } from "@opencode/core/session"
import { SessionErrors } from "@opencode/core/session/error"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionInboxTable, SessionMessageTable, SessionTable } from "@opencode/core/session/sql"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { Skill } from "@opencode/core/skill"
import { AbsolutePath } from "@opencode/core/schema"
import { TaskQueue } from "@opencode/core/task-queue"
import { TaskQueueTable, TaskQueueTaskTable } from "@opencode/core/task-queue/sql"
import { TaskQueueOwnership } from "@opencode/core/task-queue/ownership"
import { Shell } from "@opencode/core/shell"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { daemonShells } from "./fixture/shell-daemon"

// The fake judge drives the review state machine without an LLM.
let judge: TaskQueue.Judge = () => Effect.succeed({ verdict: "done", reason: "tests pass" })
const judgeCalls: TaskQueue.JudgeInput[] = []
const node = TaskQueue.configured({
  judge: (input) =>
    Effect.suspend(() => {
      judgeCalls.push(input)
      return judge(input)
    }),
})

// Fake execution: succeed, fail, fail once then succeed, or hang until interrupted, recording every
// resume and interrupt.
const executionState = {
  mode: "succeed" as "succeed" | "fail" | "fail-first" | "hang",
  resumes: [] as Session.ID[],
  interrupts: [] as Session.ID[],
  children: new Map<Session.ID, { idle: Deferred.Deferred<void>; interrupted: Deferred.Deferred<void> }>(),
}
let queueShell: Shell.Interface | undefined
const hanging = new Map<Session.ID, Deferred.Deferred<void>>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set([...hanging.keys(), ...executionState.children.keys()])),
    isActive: (sessionID) => Effect.sync(() => hanging.has(sessionID) || executionState.children.has(sessionID)),
    wake: () => Effect.void,
    awaitIdle: (sessionID) => Effect.suspend(() => {
      const child = executionState.children.get(sessionID)
      return child ? Deferred.await(child.idle).pipe(Effect.tap(() => Effect.sync(() => executionState.children.delete(sessionID)))) : Effect.void
    }),
    resume: (sessionID) =>
      Effect.suspend(() => {
        executionState.resumes.push(sessionID)
        if (executionState.mode === "fail-first") {
          executionState.mode = "succeed"
          return Effect.fail(
            new SessionErrors.StepFailedError({ error: { type: "test_failure", message: "the model run failed" } }),
          )
        }
        if (executionState.mode === "fail")
          return Effect.fail(
            new SessionErrors.StepFailedError({ error: { type: "test_failure", message: "the model run failed" } }),
          )
        if (executionState.mode === "hang")
          return Effect.gen(function* () {
            const deferred = yield* Deferred.make<void, never>()
            hanging.set(sessionID, deferred)
            yield* Deferred.await(deferred)
          })
        return Effect.void
      }),
    interrupt: (sessionID) =>
      Effect.gen(function* () {
        const child = executionState.children.get(sessionID)
        if (child) {
          executionState.interrupts.push(sessionID)
          yield* Deferred.succeed(child.interrupted, undefined)
          return true
        }
        const deferred = hanging.get(sessionID)
        if (!deferred) return false
        executionState.interrupts.push(sessionID)
        hanging.delete(sessionID)
        yield* Deferred.interrupt(deferred)
        return true
      }),
  }),
)

// Every session's permission asks and forms must reach the real location-scoped services.
const configureAgent = Layer.effectDiscard(
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.defaultID, (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
      }),
    )
  }),
)
const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const app = yield* App.Service
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const saved = yield* PermissionSaved.Service
      return yield* LayerMap.make(
        (ref: Location.Ref) =>
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          Layer.mergeAll(
            configureAgent.pipe(
              Layer.provideMerge(
                LayerNode.compile(
                  LayerNode.group([
                    App.node,
                    Config.node,
                    Flag.node,
                    Location.node,
                    PluginHooks.node,
                    Skill.node,
                    Agent.node,
                    Permission.node,
                    Form.node,
                  ]),
                  {
                    replacements: [
                      App.node.replace(Layer.succeed(App.Service, app)),
                      Bus.node.replace(Layer.succeed(Bus.Service, bus)),
                      Config.node.replace(Config.testLayer([])),
                      Location.node.replace(Layer.succeed(Location.Service, location(ref))),
                      SessionStore.node.replace(Layer.succeed(SessionStore.Service, store)),
                      PermissionSaved.node.replace(Layer.succeed(PermissionSaved.Service, saved)),
                    ],
                  },
                ),
              ),
            ),
            Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
            Layer.unwrap(Effect.sync(() => queueShell ? Layer.succeed(Shell.Service, queueShell) : Layer.empty)),
          ).pipe(Layer.fresh) as unknown as Layer.Layer<LocationServices, FileSystem.DirectoryNotFoundError>,
      )
    }),
  ),
  deps: [App.node, Bus.node, SessionStore.node, PermissionSaved.node],
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionExecution.node,
      Job.node,
      Instance.node,
      node,
    ]),
    [SessionExecution.node.replace(execution), LocationServiceMap.node.replace(locations)],
  ),
)

const setup = () =>
  Effect.gen(function* () {
    executionState.mode = "succeed"
    executionState.resumes = []
    executionState.interrupts = []
    executionState.children.clear()
    queueShell = undefined
    hanging.clear()
    judge = () => Effect.succeed({ verdict: "done", reason: "tests pass" })
    judgeCalls.length = 0
    return yield* TaskQueue.Service
  })

const anotherService = (session?: Session.Interface, database?: Database.Interface) => Effect.gen(function* () {
  return yield* TaskQueue.make.pipe(
    Effect.provideService(Database.Service, database ?? (yield* Database.Service)),
    Effect.provideService(Bus.Service, yield* Bus.Service),
    Effect.provideService(Session.Service, session ?? (yield* Session.Service)),
    Effect.provideService(SessionExecution.Service, yield* SessionExecution.Service),
    Effect.provideService(Job.Service, yield* Job.Service),
    Effect.provideService(SessionStore.Service, yield* SessionStore.Service),
    Effect.provideService(Instance.Service, yield* Instance.Service),
  )
})

/** Retries a query across cooperative yields, so background scheduler fibers can make progress first. */
function eventually<A, E>(effect: Effect.Effect<A, E>, check: (value: A) => boolean): Effect.Effect<A, E> {
  return Effect.gen(function* () {
    const deadline = performance.now() + 10_000
    while (true) {
      const value = yield* effect
      if (check(value)) return value
      if (performance.now() >= deadline) return yield* Effect.die(new Error(`condition was not met in time: ${JSON.stringify(value)}`))
      yield* Effect.yieldNow
    }
  })
}

const withQueueDirectory = <A, E, R>(body: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  tmpdirScoped("task-queue-test-").pipe(Effect.flatMap((tmp) => body(AbsolutePath.make(tmp.path))))

const threeTasks = [
  { title: "One", prompt: "do the first thing" },
  { title: "Two", prompt: "do the second thing" },
  { title: "Three", prompt: "do the third thing" },
] as const

/** An assistant message with a tool call, so a review round counts as progress. */
const seedAssistantTool = (
  db: Database.Interface["db"],
  sessionID: Session.ID,
  seq: number,
  text: string,
) => {
  const { id: _id, type, ...data } = Schema.encodeSync(SessionMessage.Info)(
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
      content: [
        {
          type: "tool",
          id: `call_${seq}`,
          name: "bash",
          executed: true,
          state: { status: "completed", input: {}, content: [{ type: "text", text }] },
          time: { created: DateTime.makeUnsafe(0) },
        },
      ],
      time: { created: DateTime.makeUnsafe(0) },
    }),
  )
  return db
    .insert(SessionMessageTable)
    .values({ id: SessionMessage.ID.create(), session_id: sessionID, type, seq, time_created: seq, data })
    .run()
    .pipe(Effect.orDie)
}

const runningTaskSession = (queues: TaskQueue.Interface, queueID: TaskQueue.ID) =>
  eventually(
    queues.get(queueID),
    (info) => info.status === "running" && info.tasks.some((task) => task.status === "running" && task.sessionID && executionState.resumes.includes(task.sessionID)),
  ).pipe(
    Effect.map((info) => {
      const task = info.tasks.find((item) => item.status === "running" && item.sessionID)
      return { sessionID: task!.sessionID!, taskID: task!.id, position: task!.position }
    }),
  )

describe("TaskQueue", () => {
  it.live("stores generated names without rewriting prompts or explicit historical titles", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      const prompt = "\r\n \t\r\n  修复接口 😀  \r\n保留完整内容和空白  "
      const queue = yield* queues.create({ directory, tasks: [{ prompt }, { title: "Existing title", prompt }] })
      expect(queue.tasks.map((task) => ({ title: task.title, prompt: task.prompt }))).toEqual([
        { title: "修复接口 😀", prompt }, { title: "Existing title", prompt },
      ])
      expect((yield* queues.get(queue.id)).tasks).toEqual(queue.tasks)
      for (const tasks of [[{ prompt: " \t\r\n　" }], [{ prompt: "valid" }, { title: "Old", prompt: "\n " }]] as const) {
        const error = yield* queues.create({ directory, tasks }).pipe(Effect.flip)
        expect(error).toMatchObject({ _tag: "TaskQueue.InvalidError", reason: "A task needs non-blank content" })
      }
      expect(yield* queues.list({ directory })).toEqual([queue])
    })),
  )

  // TC-002/005: an existing stored title is not input to the new naming policy, even after rebuilding the service.
  it.live("preserves a persisted legacy title across service reconstruction and same-session resume", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "hang"
      const prompt = "\n不同于历史名称的首行\r\n完整任务内容  "
      const queue = yield* queues.create({ directory, tasks: [{ prompt }] })
      const title = `  历史标题${"😀".repeat(81)}  `
      const database = yield* Database.Service
      // Seed a pre-existing record independently of create's current title normalization.
      yield* database.db.update(TaskQueueTaskTable).set({ title }).where(eq(TaskQueueTaskTable.queue_id, queue.id)).run().pipe(Effect.orDie)
      const reopened = yield* anotherService()
      expect((yield* reopened.get(queue.id)).tasks[0]).toMatchObject({ title, prompt })
      expect((yield* reopened.list({ directory }))[0]?.tasks[0]).toMatchObject({ title, prompt })
      yield* reopened.start(queue.id)
      const running = yield* runningTaskSession(reopened, queue.id)
      const sessions = yield* Session.Service
      expect((yield* sessions.get(running.sessionID)).title).toBe(title)
      yield* reopened.stop(queue.id)
      const resumed = yield* anotherService()
      yield* resumed.resume(queue.id)
      expect((yield* runningTaskSession(resumed, queue.id)).sessionID).toBe(running.sessionID)
      expect((yield* resumed.get(queue.id)).tasks[0]).toMatchObject({ title, prompt, sessionID: running.sessionID })
      expect((yield* database.db.select().from(TaskQueueTaskTable).where(eq(TaskQueueTaskTable.queue_id, queue.id)).get())?.title).toBe(title)
      yield* resumed.stop(queue.id)
    })),
  )

  it.effect("resuming a stopped forward scan does not revisit blocked tasks until a later explicit done resume", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      const state = { blocked: false }
      judge = (input) => Effect.sync(() => {
        if (input.task.position !== 1) return { verdict: "done" as const, reason: "finished" }
        if (!state.blocked) {
          state.blocked = true
          executionState.mode = "hang"
        }
        return { verdict: "blocked" as const, reason: "credentials still missing" }
      })
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      // Wait for the first review to block and the second task to become the active Session.
      yield* eventually(queues.get(queue.id), (info) => {
        const second = info.tasks[1]
        return info.tasks[0]?.status === "blocked" && second?.status === "running" &&
          second.sessionID !== undefined && executionState.resumes.includes(second.sessionID)
      })
      const second = yield* runningTaskSession(queues, queue.id)
      yield* queues.stop(queue.id)
      executionState.mode = "succeed"
      yield* queues.resume(queue.id)
      const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(done.tasks.map((task) => task.status)).toEqual(["blocked", "completed", "completed"])
      expect(done.tasks[1]?.sessionID).toBe(second.sessionID)
      expect(judgeCalls.map((input) => input.task.position)).toEqual([1, 2, 3])
      yield* queues.resume(queue.id)
      yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(judgeCalls.map((input) => input.task.position)).toEqual([1, 2, 3, 1])
    })),
  )

  it.effect("an independent fork and its children do not inherit queue ownership from copied metadata", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "hang"
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const root = yield* runningTaskSession(queues, queue.id)
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const { db } = yield* Database.Service
      const fork = yield* sessions.create({ location: { directory } })
      // Match SessionProjector's independent fork projection: copied metadata, fork provenance, no parentID.
      yield* db.update(SessionTable).set({
        metadata: { source: "taskqueue" },
        fork_session_id: root.sessionID,
        fork_boundary: { type: "through", messageID: SessionMessage.ID.create() },
      }).where(eq(SessionTable.id, fork.id)).run().pipe(Effect.orDie)
      const child = yield* sessions.create({ parentID: fork.id })
      expect(yield* TaskQueueOwnership.admitted(db, store, fork.id)).toBe(true)
      expect(yield* TaskQueueOwnership.admitted(db, store, child.id)).toBe(true)
      yield* queues.stop(queue.id)
      yield* queues.remove(queue.id)
      expect(yield* TaskQueueOwnership.admitted(db, store, root.sessionID)).toBe(false)
      expect(yield* TaskQueueOwnership.admitted(db, store, fork.id)).toBe(true)
      expect(yield* TaskQueueOwnership.admitted(db, store, child.id)).toBe(true)
    })),
  )

  it.effect("a failed Session creation releases its unused reservation and remains explicitly resumable", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      yield* setup()
      executionState.mode = "hang"
      const sessions = yield* Session.Service
      const state = { fail: true }
      const queues = yield* anotherService({
        ...sessions,
        create: (input) => state.fail ? Effect.die(new Error("Session creation failed")) : sessions.create(input),
      })
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const stopped = yield* eventually(queues.get(queue.id), (info) => info.status === "stopped")
      expect(stopped.tasks[0]?.status).toBe("interrupted")
      expect(stopped.tasks[0]?.sessionID).toBeUndefined()
      expect(executionState.resumes).toHaveLength(0)
      state.fail = false
      yield* queues.resume(queue.id)
      const running = yield* runningTaskSession(queues, queue.id)
      expect((yield* sessions.get(running.sessionID)).metadata?.source).toBe("taskqueue")
      yield* queues.stop(queue.id)
    })),
  )

  it.effect("an unfinished cleanup does not block lease expiry in a different directory", () =>
    withQueueDirectory((directory) => withQueueDirectory((otherDirectory) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "hang"
      const first = yield* queues.create({ directory, tasks: threeTasks })
      const second = yield* queues.create({ directory: otherDirectory, tasks: threeTasks })
      yield* queues.start(first.id)
      yield* queues.start(second.id)
      const root = yield* runningTaskSession(queues, first.id)
      yield* runningTaskSession(queues, second.id)
      const sessions = yield* Session.Service
      const child = yield* sessions.create({ parentID: root.sessionID })
      const idle = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      executionState.children.set(child.id, { idle, interrupted })
      yield* TestClock.adjust("20 seconds")
      yield* queues.heartbeat(second.id)
      yield* TestClock.adjust("15 seconds")
      yield* Deferred.await(interrupted)
      expect((yield* queues.get(first.id)).status).toBe("running")
      yield* TestClock.adjust("20 seconds")
      const stopped = yield* eventually(queues.get(second.id), (info) => info.status === "stopped")
      expect(stopped.reason).toBe("owner disconnected")
      expect((yield* queues.get(first.id)).status).toBe("running")
      yield* Deferred.succeed(idle, undefined)
      yield* eventually(queues.get(first.id), (info) => info.status === "stopped")
    }))),
  )

  it.effect("stop/resume and remove cannot bypass a grandchild Job's in-flight cancellation", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      const sessions = yield* Session.Service
      const jobs = yield* Job.Service
      const started = yield* Deferred.make<Session.ID>()
      const cancelling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      judge = (input) => Effect.gen(function* () {
        const child = yield* sessions.create({ parentID: input.session.id })
        const grandchild = yield* sessions.create({ parentID: child.id })
        yield* jobs.start({ id: "stopping-grandchild", type: "shell", background: true,
          recovery: { kind: "shell", sessionID: grandchild.id, shellID: "sh_stopping", command: "build" },
          run: Deferred.succeed(started, input.session.id).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.await(release))),
          cancel: Deferred.succeed(cancelling, undefined).pipe(Effect.asVoid),
        })
        return { verdict: "done" as const, reason: "finished" }
      }).pipe(Effect.orDie)
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const root = yield* Deferred.await(started)
      const stopping = yield* queues.stop(queue.id).pipe(Effect.forkScoped)
      yield* Deferred.await(cancelling)
      expect(stopping.pollUnsafe()).toBeUndefined()
      expect((yield* queues.get(queue.id)).tasks[1]?.sessionID).toBeUndefined()
      const other = yield* anotherService()
      expect(yield* Effect.flip(other.remove(queue.id))).toMatchObject({ _tag: "TaskQueue.InvalidError" })
      const resumed = yield* queues.resume(queue.id).pipe(Effect.forkScoped)
      expect(resumed.pollUnsafe()).toBeUndefined()
      judge = () => Effect.succeed({ verdict: "done", reason: "new generation" })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopping)
      yield* Fiber.join(resumed)
      const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(done.tasks[0]?.sessionID).toBe(root)
      expect(done.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"])
      expect(done.currentTaskID).toBeUndefined()
      expect(yield* jobs.runningBackground).toHaveLength(0)
    })),
  )

  // R-API-01: a durable path can be replaced between create/stop and admission, without any race.
  for (const action of ["start", "resume"] as const) {
    it.live(`rejects ${action} when the stored directory has become a junction to another queue's directory`, () =>
      withQueueDirectory((root) => Effect.gen(function* () {
        const queues = yield* setup()
        executionState.mode = "hang"
        const directory = AbsolutePath.make(path.join(root, "original"))
        const target = AbsolutePath.make(path.join(root, "target"))
        yield* Effect.promise(() => Promise.all([fs.mkdir(directory), fs.mkdir(target)]))
        const queue = yield* queues.create({ directory, tasks: threeTasks })
        if (action === "resume") {
          yield* queues.start(queue.id)
          yield* runningTaskSession(queues, queue.id)
          yield* queues.stop(queue.id)
        }
        const before = yield* queues.get(queue.id)
        const database = yield* Database.Service
        const stored = yield* database.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, queue.id)).get()
        yield* Effect.promise(() => fs.rmdir(directory))
        yield* Effect.acquireRelease(
          Effect.promise(() => fs.symlink(target, directory, process.platform === "win32" ? "junction" : "dir")),
          // This fixture owns this exact link; unlink never traverses its target.
          () => Effect.promise(() => fs.unlink(directory)),
        )
        const other = yield* queues.create({ directory: target, tasks: threeTasks })
        yield* queues.start(other.id)
        const running = yield* runningTaskSession(queues, other.id)
        expect(yield* TaskQueue.canonicalDirectory(directory)).toBe(other.directory)
        const sessions = yield* Session.Service
        const tasks = yield* database.db.select().from(TaskQueueTaskTable).all()
        const sessionRows = yield* database.db.select().from(SessionTable).all()
        const inboxRows = yield* database.db.select().from(SessionInboxTable).all()
        const inboxes = yield* Effect.forEach(sessionRows, (row) => sessions.inbox(row.id))
        const resumes = [...executionState.resumes]
        const reopened = yield* anotherService()
        expect(yield* reopened[action](queue.id).pipe(Effect.flip)).toMatchObject({
          _tag: "TaskQueue.InvalidError",
          reason: "The queue directory now resolves to a different location; restore the original directory or create a new queue",
        })
        expect(yield* reopened.get(queue.id)).toEqual(before)
        expect(yield* database.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, queue.id)).get()).toEqual(stored)
        expect(yield* database.db.select().from(TaskQueueTaskTable).all()).toEqual(tasks)
        expect(yield* database.db.select().from(SessionTable).all()).toEqual(sessionRows)
        expect(yield* database.db.select().from(SessionInboxTable).all()).toEqual(inboxRows)
        expect(yield* Effect.forEach(sessionRows, (row) => sessions.inbox(row.id))).toEqual(inboxes)
        expect(executionState.resumes).toEqual(resumes)
        expect([...hanging.keys()]).toEqual([running.sessionID])
        expect((yield* queues.list({ directory: target })).map((item) => item.id)).toEqual([other.id])
        expect(before.tasks.slice(action === "resume" ? 1 : 0).every((task) => !task.sessionID)).toBe(true)
        yield* queues.stop(other.id)
      })),
    )

    it.live(`rejects ${action} when the stored directory is missing or replaced by a file without changing durable state`, () =>
      withQueueDirectory((root) => Effect.gen(function* () {
        const queues = yield* setup()
        executionState.mode = "hang"
        const directory = AbsolutePath.make(path.join(root, "original"))
        yield* Effect.promise(() => fs.mkdir(directory))
        const queue = yield* queues.create({ directory, tasks: threeTasks })
        if (action === "resume") {
          yield* queues.start(queue.id)
          yield* runningTaskSession(queues, queue.id)
          yield* queues.stop(queue.id)
        }
        const before = yield* queues.get(queue.id)
        const database = yield* Database.Service
        const stored = yield* database.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, queue.id)).get()
        const tasks = yield* database.db.select().from(TaskQueueTaskTable).all()
        const sessions = yield* database.db.select().from(SessionTable).all()
        const inboxes = yield* database.db.select().from(SessionInboxTable).all()
        const resumes = [...executionState.resumes]
        yield* Effect.promise(() => fs.rmdir(directory))
        for (const file of [false, true]) {
          if (file) yield* Effect.promise(() => fs.writeFile(directory, "not a directory"))
          expect(yield* queues[action](queue.id).pipe(Effect.flip)).toMatchObject({
            _tag: "TaskQueue.InvalidError", reason: "The queue directory does not exist or is not a directory",
          })
          expect(yield* queues.get(queue.id)).toEqual(before)
          expect(yield* database.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, queue.id)).get()).toEqual(stored)
          expect(yield* database.db.select().from(TaskQueueTaskTable).all()).toEqual(tasks)
          expect(yield* database.db.select().from(SessionTable).all()).toEqual(sessions)
          expect(yield* database.db.select().from(SessionInboxTable).all()).toEqual(inboxes)
          expect(executionState.resumes).toEqual(resumes)
          expect(hanging.size).toBe(0)
        }
      })),
    )
  }

  // TC-008: done-resume has its own failed/blocked reset writes; refusal must precede those too.
  it.live("rejects a finished batch's retry after directory drift without resetting failed or blocked tasks", () =>
    withQueueDirectory((root) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "fail-first"
      judge = (input) => Effect.succeed(input.task.position === 2
        ? { verdict: "blocked", reason: "approval missing" }
        : { verdict: "done", reason: "finished" })
      const directory = AbsolutePath.make(path.join(root, "original"))
      const target = AbsolutePath.make(path.join(root, "target"))
      yield* Effect.promise(() => Promise.all([fs.mkdir(directory), fs.mkdir(target)]))
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const before = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(before.tasks.map((task) => task.status)).toEqual(["failed", "blocked", "completed"])
      yield* Effect.promise(() => fs.rmdir(directory))
      yield* Effect.acquireRelease(
        Effect.promise(() => fs.symlink(target, directory, process.platform === "win32" ? "junction" : "dir")),
        () => Effect.promise(() => fs.unlink(directory)),
      )
      executionState.mode = "hang"
      const other = yield* queues.create({ directory: target, tasks: threeTasks })
      yield* queues.start(other.id)
      const running = yield* runningTaskSession(queues, other.id)
      const database = yield* Database.Service
      const rows = yield* database.db.select().from(TaskQueueTable).all()
      const tasks = yield* database.db.select().from(TaskQueueTaskTable).all()
      const sessions = yield* database.db.select().from(SessionTable).all()
      const inboxes = yield* database.db.select().from(SessionInboxTable).all()
      const resumes = [...executionState.resumes]
      const reopened = yield* anotherService()
      expect(yield* reopened.resume(queue.id).pipe(Effect.flip)).toMatchObject({
        _tag: "TaskQueue.InvalidError",
        reason: "The queue directory now resolves to a different location; restore the original directory or create a new queue",
      })
      expect(yield* reopened.get(queue.id)).toEqual(before)
      expect(yield* database.db.select().from(TaskQueueTable).all()).toEqual(rows)
      expect(yield* database.db.select().from(TaskQueueTaskTable).all()).toEqual(tasks)
      expect(yield* database.db.select().from(SessionTable).all()).toEqual(sessions)
      expect(yield* database.db.select().from(SessionInboxTable).all()).toEqual(inboxes)
      expect(executionState.resumes).toEqual(resumes)
      expect([...hanging.keys()]).toEqual([running.sessionID])
      yield* queues.stop(other.id)
    })),
  )

  for (const [name, renamed] of [["project", "PROJECT"], ["project-Ä", "project-ä"], ["项目", "项目"]] as const) {
  it.live(`admits canonicalized junction aliases and case-only directory renames for ${name} without migrating stored paths or losing exclusion`, () =>
    withQueueDirectory((root) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "hang"
      const directory = AbsolutePath.make(path.join(root, name))
      const alias = path.join(root, "alias")
      yield* Effect.promise(() => fs.mkdir(directory))
      yield* Effect.acquireRelease(
        Effect.promise(() => fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir")),
        () => Effect.promise(() => fs.unlink(alias)),
      )
      const queue = yield* queues.create({ directory: AbsolutePath.make(alias + "/./"), tasks: threeTasks })
      expect(queue.directory).toBe(directory)
      if (process.platform === "win32" && name !== renamed) {
        yield* Effect.promise(() => fs.rename(directory, path.join(root, renamed)))
        // Exercise admission's case equivalence, not just create's realpath normalization.
        const current = yield* TaskQueue.canonicalDirectory(queue.directory)
        expect(current).not.toBe(queue.directory)
        expect(current.toLowerCase()).toBe(queue.directory.toLowerCase())
      }
      const other = yield* queues.create({
        directory: AbsolutePath.make(process.platform === "win32" ? alias.toUpperCase() : alias + "/./"), tasks: threeTasks,
      })
      for (const input of [directory, other.directory])
        expect(new Set((yield* queues.list({ directory: input })).map((item) => item.id))).toEqual(new Set([queue.id, other.id]))
      yield* queues.start(queue.id)
      const running = yield* runningTaskSession(queues, queue.id)
      expect(yield* queues.start(other.id).pipe(Effect.flip)).toMatchObject({ _tag: "TaskQueue.InvalidError" })
      expect([...hanging.keys()]).toEqual([running.sessionID])
      yield* queues.stop(queue.id)
      yield* queues.start(other.id)
      const otherRunning = yield* runningTaskSession(queues, other.id)
      expect(yield* queues.resume(queue.id).pipe(Effect.flip)).toMatchObject({ _tag: "TaskQueue.InvalidError" })
      expect([...hanging.keys()]).toEqual([otherRunning.sessionID])
      yield* queues.stop(other.id)
      yield* queues.resume(queue.id)
      expect((yield* runningTaskSession(queues, queue.id)).sessionID).toBe(running.sessionID)
      const sessions = yield* Session.Service
      expect((yield* queues.get(queue.id)).directory).toBe(queue.directory)
      expect((yield* sessions.get(running.sessionID)).location.directory).toBe(queue.directory)
      const database = yield* Database.Service
      expect((yield* database.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, queue.id)).get())?.directory).toBe(queue.directory)
      expect((yield* database.db.select().from(SessionTable).where(eq(SessionTable.id, running.sessionID)).get())?.directory).toBe(queue.directory)
      yield* queues.stop(queue.id)
    })),
  )
  }

  it.live("keeps Unicode case variants exclusive on Windows and independent on POSIX", () =>
    withQueueDirectory((root) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "hang"
      const directory = AbsolutePath.make(path.join(root, "project-Ä"))
      const renamed = AbsolutePath.make(path.join(root, "project-ä"))
      yield* Effect.promise(() => fs.mkdir(directory))
      const first = yield* queues.create({ directory, tasks: threeTasks })
      yield* Effect.promise(() => process.platform === "win32" ? fs.rename(directory, renamed) : fs.mkdir(renamed))
      const second = yield* queues.create({ directory: renamed, tasks: threeTasks })
      yield* queues.start(first.id)
      const running = yield* runningTaskSession(queues, first.id)
      if (process.platform === "win32") {
        expect(yield* queues.start(second.id).pipe(Effect.flip)).toMatchObject({ _tag: "TaskQueue.InvalidError" })
        expect([...hanging.keys()]).toEqual([running.sessionID])
        for (const input of [directory, renamed])
          expect(new Set((yield* queues.list({ directory: input })).map((queue) => queue.id))).toEqual(new Set([first.id, second.id]))
      }
      if (process.platform !== "win32") {
        yield* queues.start(second.id)
        const other = yield* runningTaskSession(queues, second.id)
        expect(new Set(hanging.keys())).toEqual(new Set([running.sessionID, other.sessionID]))
        expect((yield* queues.list({ directory })).map((queue) => queue.id)).toEqual([first.id])
        expect((yield* queues.list({ directory: renamed })).map((queue) => queue.id)).toEqual([second.id])
        yield* queues.stop(second.id)
      }
      yield* queues.stop(first.id)
      expect(hanging.size).toBe(0)
    })),
  )

  it.live("preserves Unicode directory and Sessions on done-resume and rejects occupied retries before resetting tasks", () =>
    withQueueDirectory((root) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "fail-first"
      judge = (input) => Effect.succeed(input.task.position === 2
        ? { verdict: "blocked", reason: "approval missing" }
        : { verdict: "done", reason: "finished" })
      const directory = AbsolutePath.make(path.join(root, "project-Ä"))
      yield* Effect.promise(() => fs.mkdir(directory))
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      if (process.platform === "win32") yield* Effect.promise(() => fs.rename(directory, path.join(root, "project-ä")))
      yield* queues.start(queue.id)
      const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(done.tasks.map((task) => task.status)).toEqual(["failed", "blocked", "completed"])
      executionState.mode = "hang"
      const other = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(other.id)
      const running = yield* runningTaskSession(queues, other.id)
      const database = yield* Database.Service
      const rows = yield* database.db.select().from(TaskQueueTable).all()
      const before = yield* database.db.select().from(TaskQueueTaskTable).all()
      const sessionRows = yield* database.db.select().from(SessionTable).all()
      const inboxes = yield* database.db.select().from(SessionInboxTable).all()
      const resumes = [...executionState.resumes]
      expect(yield* queues.resume(queue.id).pipe(Effect.flip)).toMatchObject({ _tag: "TaskQueue.InvalidError" })
      expect(yield* queues.get(queue.id)).toEqual(done)
      expect(yield* database.db.select().from(TaskQueueTable).all()).toEqual(rows)
      expect(yield* database.db.select().from(TaskQueueTaskTable).all()).toEqual(before)
      expect(yield* database.db.select().from(SessionTable).all()).toEqual(sessionRows)
      expect(yield* database.db.select().from(SessionInboxTable).all()).toEqual(inboxes)
      expect(executionState.resumes).toEqual(resumes)
      expect([...hanging.keys()]).toEqual([running.sessionID])
      yield* queues.stop(other.id)
      executionState.mode = "succeed"
      judge = () => Effect.succeed({ verdict: "done", reason: "retry finished" })
      yield* queues.resume(queue.id)
      const resumed = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(resumed.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"])
      expect(resumed.tasks.map((task) => task.sessionID)).toEqual(done.tasks.map((task) => task.sessionID))
      expect(resumed.directory).toBe(queue.directory)
      const sessions = yield* Session.Service
      for (const task of resumed.tasks) {
        if (!task.sessionID) return yield* Effect.die("the retried task lost its Session")
        expect((yield* sessions.get(task.sessionID)).location.directory).toBe(queue.directory)
      }
      expect((yield* database.db.select().from(SessionTable).all()).map((row) => ({ id: row.id, directory: row.directory })))
        .toEqual(sessionRows.map((row) => ({ id: row.id, directory: row.directory })))
    })),
  )

  for (const action of ["stop", "shutdown"] as const) {
    it.live(`${action} still cleans up already running work after its stored directory becomes a junction`, () =>
      withQueueDirectory((root) => Effect.gen(function* () {
        yield* setup()
        executionState.mode = "hang"
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const queues = yield* anotherService().pipe(Scope.provide(scope))
        const directory = AbsolutePath.make(path.join(root, "original"))
        const target = path.join(root, "target")
        yield* Effect.promise(() => Promise.all([fs.mkdir(directory), fs.mkdir(target)]))
        const queue = yield* queues.create({ directory, tasks: threeTasks })
        yield* queues.start(queue.id)
        const running = yield* runningTaskSession(queues, queue.id)
        yield* Effect.promise(() => fs.rmdir(directory))
        yield* Effect.acquireRelease(
          Effect.promise(() => fs.symlink(target, directory, process.platform === "win32" ? "junction" : "dir")),
          () => Effect.promise(() => fs.unlink(directory)),
        )
        expect((yield* queues.get(queue.id)).status).toBe("running")
        yield* queues.heartbeat(queue.id)
        if (action === "stop") yield* queues.stop(queue.id)
        if (action === "shutdown") yield* Scope.close(scope, Exit.void)
        const stopped = yield* queues.get(queue.id)
        expect(stopped).toMatchObject({
          status: "stopped", directory: queue.directory,
          reason: action === "stop" ? "stopped by the user" : "server stopped",
        })
        expect(stopped.tasks.map((task) => task.status)).toEqual(["interrupted", "pending", "pending"])
        expect(stopped.tasks[0]?.sessionID).toBe(running.sessionID)
        expect(stopped.tasks.slice(1).every((task) => !task.sessionID)).toBe(true)
        expect(executionState.interrupts).toEqual([running.sessionID])
        expect(hanging.size).toBe(0)
      })),
    )
  }

  for (const name of ["project", "project-Ä"] as const) {
  it.live(`directory admission is atomic across two independent SQLite connections for ${name}`, () =>
    withQueueDirectory((root) => Effect.gen(function* () {
      yield* setup()
      executionState.mode = "hang"
      const directory = AbsolutePath.make(path.join(root, name))
      yield* Effect.promise(() => fs.mkdir(directory))
      const databaseNode = Database.configured({ path: root + "/queues.sqlite" })
      const firstDB = Context.get(yield* Layer.build(AppNodeBuilder.build(databaseNode).pipe(Layer.fresh)), Database.Service)
      const secondDB = Context.get(yield* Layer.build(AppNodeBuilder.build(databaseNode).pipe(Layer.fresh)), Database.Service)
      expect(firstDB.db.$client).not.toBe(secondDB.db.$client)
      const first = yield* anotherService(undefined, firstDB)
      const second = yield* anotherService(undefined, secondDB)
      const a = yield* first.create({ directory, tasks: threeTasks })
      if (process.platform === "win32") yield* Effect.promise(() => fs.rename(directory, path.join(root, name === "project" ? "PROJECT" : "project-ä")))
      const b = yield* second.create({ directory: AbsolutePath.make(process.platform === "win32" ? directory.toUpperCase() : directory + "/./"), tasks: threeTasks })
      const queuedRows = yield* firstDB.db.select().from(TaskQueueTable).all()
      const queuedTasks = yield* firstDB.db.select().from(TaskQueueTaskTable).all()
      const sessionDatabase = yield* Database.Service
      // Queue storage uses the two file connections; the shared Session service owns these other two tables.
      const snapshot = Effect.all([
        firstDB.db.select().from(TaskQueueTable).orderBy(TaskQueueTable.id).all(),
        secondDB.db.select().from(TaskQueueTaskTable).orderBy(TaskQueueTaskTable.id).all(),
        sessionDatabase.db.select().from(SessionTable).orderBy(SessionTable.id).all(),
        sessionDatabase.db.select().from(SessionInboxTable).orderBy(SessionInboxTable.id).all(),
      ])
      const results = yield* Effect.all([first.start(a.id).pipe(Effect.result), second.start(b.id).pipe(Effect.result)], { concurrency: "unbounded" })
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
      expect((yield* first.list()).filter((queue) => queue.status === "running")).toHaveLength(1)
      const winner = results[0]?._tag === "Success" ? { queues: first, queue: a } : { queues: second, queue: b }
      const loser = results[0]?._tag === "Success" ? { queues: second, queue: b } : { queues: first, queue: a }
      const running = yield* runningTaskSession(winner.queues, winner.queue.id)
      expect([...hanging.keys()]).toEqual([running.sessionID])
      expect((yield* firstDB.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, loser.queue.id)).get()))
        .toEqual(queuedRows.find((row) => row.id === loser.queue.id))
      expect(yield* firstDB.db.select().from(TaskQueueTaskTable).where(eq(TaskQueueTaskTable.queue_id, loser.queue.id)).all())
        .toEqual(queuedTasks.filter((row) => row.queue_id === loser.queue.id))
      const beforeStartRefusal = yield* snapshot
      const startResumes = [...executionState.resumes]
      expect(yield* loser.queues.start(loser.queue.id).pipe(Effect.flip)).toMatchObject({ _tag: "TaskQueue.InvalidError" })
      expect(yield* snapshot).toEqual(beforeStartRefusal)
      expect(executionState.resumes).toEqual(startResumes)
      for (const input of [a.directory, b.directory])
        expect(new Set((yield* second.list({ directory: input })).map((queue) => queue.id))).toEqual(new Set([a.id, b.id]))
      expect((yield* firstDB.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, a.id)).get())?.directory).toBe(a.directory)
      expect((yield* secondDB.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, b.id)).get())?.directory).toBe(b.directory)
      // A newly built service on another connection must neither steal nor interrupt this live owner.
      yield* anotherService(undefined, secondDB)
      expect((yield* first.get(winner.queue.id)).status).toBe("running")
      yield* winner.queues.stop(winner.queue.id)
      yield* loser.queues.start(loser.queue.id)
      const previous = yield* runningTaskSession(loser.queues, loser.queue.id)
      yield* loser.queues.stop(loser.queue.id)
      const stoppedRows = yield* firstDB.db.select().from(TaskQueueTable).all()
      const stoppedTasks = yield* firstDB.db.select().from(TaskQueueTaskTable).all()
      const sessionDirectories = (yield* sessionDatabase.db.select().from(SessionTable).all()).map((row) => ({ id: row.id, directory: row.directory }))
      const resumed = yield* Effect.all([first.resume(a.id).pipe(Effect.result), second.resume(b.id).pipe(Effect.result)], { concurrency: "unbounded" })
      expect(resumed.filter((result) => result._tag === "Success")).toHaveLength(1)
      const owner = resumed[0]?._tag === "Success" ? { queues: first, queue: a } : { queues: second, queue: b }
      const refused = resumed[0]?._tag === "Success" ? { queues: second, queue: b } : { queues: first, queue: a }
      const current = yield* runningTaskSession(owner.queues, owner.queue.id)
      expect(current.sessionID).toBe(owner.queue.id === winner.queue.id ? running.sessionID : previous.sessionID)
      expect([...hanging.keys()]).toEqual([current.sessionID])
      expect(yield* firstDB.db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, refused.queue.id)).get())
        .toEqual(stoppedRows.find((row) => row.id === refused.queue.id))
      expect(yield* firstDB.db.select().from(TaskQueueTaskTable).where(eq(TaskQueueTaskTable.queue_id, refused.queue.id)).all())
        .toEqual(stoppedTasks.filter((row) => row.queue_id === refused.queue.id))
      const beforeResumeRefusal = yield* snapshot
      const resumeResumes = [...executionState.resumes]
      expect(yield* refused.queues.resume(refused.queue.id).pipe(Effect.flip)).toMatchObject({ _tag: "TaskQueue.InvalidError" })
      expect(yield* snapshot).toEqual(beforeResumeRefusal)
      expect(executionState.resumes).toEqual(resumeResumes)
      expect((yield* sessionDatabase.db.select().from(SessionTable).all()).map((row) => ({ id: row.id, directory: row.directory })))
        .toEqual(sessionDirectories)
      // A similar prefix is a genuinely different directory, not another spelling of the occupied one.
      const independentDirectory = AbsolutePath.make(path.join(root, name + "-other"))
      yield* Effect.promise(() => fs.mkdir(independentDirectory))
      const independent = yield* refused.queues.create({ directory: independentDirectory, tasks: threeTasks })
      yield* refused.queues.start(independent.id)
      const parallel = yield* runningTaskSession(refused.queues, independent.id)
      expect(new Set(hanging.keys())).toEqual(new Set([current.sessionID, parallel.sessionID]))
      expect((yield* second.list()).filter((queue) => queue.status === "running")).toHaveLength(2)
      expect((yield* first.list({ directory: independentDirectory })).map((queue) => queue.id)).toEqual([independent.id])
      for (const input of [a.directory, b.directory])
        expect(new Set((yield* second.list({ directory: input })).map((queue) => queue.id))).toEqual(new Set([a.id, b.id]))
      yield* refused.queues.stop(independent.id)
      expect([...hanging.keys()]).toEqual([current.sessionID])
      yield* owner.queues.stop(owner.queue.id)
      expect(hanging.size).toBe(0)
    })),
  )
  }

  it.effect("service scope shutdown stops its owned batch and leaves ordinary Session ownership untouched", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      yield* setup()
      executionState.mode = "hang"
      const scope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
      const queues = yield* anotherService().pipe(Scope.provide(scope))
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const { sessionID } = yield* runningTaskSession(queues, queue.id)
      const sessions = yield* Session.Service
      const ordinary = yield* sessions.create({ location: { directory } })
      const execution = yield* SessionExecution.Service
      const pending = yield* execution.resume(ordinary.id).pipe(Effect.forkScoped)
      yield* eventually(execution.isActive(ordinary.id), Boolean)
      yield* Scope.close(scope, Exit.void)
      expect((yield* queues.get(queue.id)).status).toBe("stopped")
      expect((yield* queues.get(queue.id)).reason).toBe("server stopped")
      expect(executionState.interrupts).toEqual([sessionID])
      expect(yield* execution.isActive(ordinary.id)).toBe(true)
      yield* execution.interrupt(ordinary.id)
      yield* Fiber.await(pending)
    })),
  )

  it.effect("a timed-out grandchild Job must finish its cancellation before any next task, and is never called completed", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      const sessions = yield* Session.Service
      const jobs = yield* Job.Service
      const started = yield* Deferred.make<void>()
      const cancelling = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      judge = (input) => Effect.gen(function* () {
        if (input.task.position === 1) {
          const child = yield* sessions.create({ parentID: input.session.id })
          const grandchild = yield* sessions.create({ parentID: child.id })
          yield* jobs.start({ id: "grandchild-shell", type: "shell", background: true,
            recovery: { kind: "shell", sessionID: grandchild.id, shellID: "sh_grandchild", command: "build" },
            run: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Deferred.await(release))),
            cancel: Deferred.succeed(cancelling, undefined).pipe(Effect.asVoid),
          })
        }
        return { verdict: "done" as const, reason: "review says done" }
      }).pipe(Effect.orDie)
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      yield* Deferred.await(started)
      for (const _ of [1, 2, 3, 4, 5, 6, 7]) {
        yield* TestClock.adjust("20 seconds")
        yield* queues.heartbeat(queue.id)
      }
      yield* Deferred.await(cancelling)
      const pending = yield* queues.get(queue.id)
      expect(pending.tasks.map((task) => task.status)).toEqual(["running", "pending", "pending"])
      expect(pending.tasks[1]?.sessionID).toBeUndefined()
      expect(judgeCalls.map((input) => input.task.position)).toEqual([1])
      yield* Deferred.succeed(release, undefined)
      const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(done.tasks.map((task) => task.status)).toEqual(["blocked", "completed", "completed"])
      expect(done.tasks[0]?.reason).toContain("Timed out waiting")
    })),
  )

  it.effect("manual resume retries blocked and failed tasks in their original Sessions, never completed tasks", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "fail-first"
      judge = (input) => Effect.succeed(input.task.position === 2 ? { verdict: "blocked", reason: "credentials" } : { verdict: "done", reason: "finished" })
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      const original = done.tasks.map((task) => task.sessionID)
      expect(done.tasks.map((task) => task.status)).toEqual(["failed", "blocked", "completed"])
      expect(judgeCalls.map((input) => input.task.position)).toEqual([2, 3])
      judge = () => Effect.succeed({ verdict: "done", reason: "credentials supplied" })
      yield* queues.resume(queue.id)
      const resumed = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(resumed.tasks.map((task) => task.sessionID)).toEqual(original)
      expect(resumed.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"])
      expect(judgeCalls.map((input) => input.task.position)).toEqual([2, 3, 1, 2])
      expect(yield* Effect.flip(queues.resume(queue.id))).toMatchObject({ _tag: "TaskQueue.InvalidError" })
    })),
  )

  it.effect("only the CAS winner starts, and a canonical directory holds one batch across service instances", () =>
    withQueueDirectory((directory) => withQueueDirectory((otherDirectory) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "hang"
      const other = yield* anotherService()
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      const results = yield* Effect.all([queues.start(queue.id).pipe(Effect.result), other.start(queue.id).pipe(Effect.result)], { concurrency: "unbounded" })
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1)
      const winner = results[0]?._tag === "Success" ? queues : other
      yield* runningTaskSession(queues, queue.id)
      expect(executionState.resumes).toHaveLength(1)
      const same = yield* queues.create({ directory: AbsolutePath.make(directory + "/./"), tasks: threeTasks })
      expect(same.directory).toBe(queue.directory)
      expect(yield* Effect.flip(other.start(same.id))).toMatchObject({ _tag: "TaskQueue.InvalidError" })
      const independent = yield* queues.create({ directory: otherDirectory, tasks: threeTasks })
      expect((yield* queues.start(independent.id)).status).toBe("running")
      yield* runningTaskSession(queues, independent.id)
      expect(hanging.size).toBe(2)
      yield* winner.stop(queue.id)
      expect((yield* other.start(same.id)).status).toBe("running")
      yield* other.stop(same.id)
      yield* queues.stop(independent.id)
    }))),
  )

  it.effect("a descendant without a Job record prevents the next task until it is actually idle", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      const sessions = yield* Session.Service
      const ready = yield* Deferred.make<Session.ID>()
      const idle = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      judge = (input) => Effect.gen(function* () {
        if (input.task.position === 1) {
          const child = yield* sessions.create({ parentID: input.session.id })
          const grandchild = yield* sessions.create({ parentID: child.id })
          executionState.children.set(grandchild.id, { idle, interrupted })
          yield* Deferred.succeed(ready, grandchild.id)
        }
        return { verdict: "done" as const, reason: "finished" }
      }).pipe(Effect.orDie)
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const grandchild = yield* Deferred.await(ready)
      expect((yield* queues.get(queue.id)).tasks.map((task) => task.status)).toEqual(["running", "pending", "pending"])
      expect(judgeCalls.map((input) => input.task.position)).toEqual([1])
      executionState.children.delete(grandchild)
      yield* Deferred.succeed(idle, undefined)
      yield* TestClock.adjust("5 seconds")
      const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(done.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"])
    })),
  )

  it.effect("stop closes admission, cancels review and awaits descendant cleanup before a new run", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const { db } = yield* Database.Service
      const reviewed = yield* Deferred.make<Session.ID>()
      const releaseReview = yield* Deferred.make<void>()
      const idle = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      judge = (input) => Effect.gen(function* () {
        const child = yield* sessions.create({ parentID: input.session.id })
        const grandchild = yield* sessions.create({ parentID: child.id })
        executionState.children.set(grandchild.id, { idle, interrupted })
        yield* Deferred.succeed(reviewed, grandchild.id)
        yield* Deferred.await(releaseReview)
        return { verdict: "continue" as const, reason: "late review must not write" }
      }).pipe(Effect.orDie)
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const grandchild = yield* Deferred.await(reviewed)
      const stopped = yield* queues.stop(queue.id).pipe(Effect.forkScoped)
      yield* Deferred.await(interrupted)
      expect(stopped.pollUnsafe()).toBeUndefined()
      expect(yield* TaskQueueOwnership.admitted(db, store, grandchild)).toBe(false)
      expect((yield* queues.get(queue.id)).tasks[1]?.status).toBe("pending")
      const resume = yield* queues.resume(queue.id).pipe(Effect.forkScoped)
      expect(resume.pollUnsafe()).toBeUndefined()
      judge = () => Effect.succeed({ verdict: "done", reason: "new run" })
      yield* Deferred.succeed(releaseReview, undefined)
      yield* Deferred.succeed(idle, undefined)
      yield* Fiber.join(stopped)
      yield* Fiber.join(resume)
      const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
      expect(done.tasks.every((task) => task.status === "completed")).toBe(true)
      expect(done.tasks[0]?.rounds).toBe(0)
      expect(done.currentTaskID).toBeUndefined()
    })),
  )

  it.effect("stop during Session creation does not admit a kickoff or create the next Session", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      yield* setup()
      const sessions = yield* Session.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const queues = yield* anotherService({ ...sessions, create: (input) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(sessions.create(input))) })
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      yield* Deferred.await(entered)
      const stopping = yield* queues.stop(queue.id).pipe(Effect.forkScoped)
      const { db } = yield* Database.Service
      yield* eventually(db.select().from(TaskQueueTable).where(eq(TaskQueueTable.id, queue.id)).get(), (row) => row?.closing === true)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(stopping)
      const stopped = yield* queues.get(queue.id)
      const root = stopped.tasks[0]?.sessionID
      if (!root) return yield* Effect.die("the created Session was not linked")
      expect(yield* sessions.inbox(root)).toHaveLength(0)
      expect(stopped.tasks.slice(1).every((task) => task.status === "pending" && !task.sessionID)).toBe(true)
      expect(executionState.resumes).toHaveLength(0)
      executionState.mode = "hang"
      yield* queues.resume(queue.id)
      const resumed = yield* runningTaskSession(queues, queue.id)
      expect(resumed.sessionID).toBe(root)
      expect(yield* sessions.inbox(root)).toHaveLength(1)
      yield* queues.stop(queue.id)
    })),
  )

  it.effect("a proven-dead owner is fenced and recovered without driving its old Session", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      executionState.mode = "hang"
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const { sessionID } = yield* runningTaskSession(queues, queue.id)
      const execution = yield* SessionExecution.Service
      yield* execution.interrupt(sessionID)
      const { db } = yield* Database.Service
      yield* db.update(TaskQueueTable).set({ owner_boot: "dead-boot", owner_pid: 2147483647 }).where(eq(TaskQueueTable.id, queue.id)).run().pipe(Effect.orDie)
      const recovered = yield* anotherService()
      yield* eventually(queues.get(queue.id), (info) => info.status === "interrupted")
      expect(executionState.resumes).toEqual([sessionID])
      // A manual resume on the recovering owner adopts the original Session.
      executionState.mode = "hang"
      yield* recovered.resume(queue.id)
      yield* runningTaskSession(recovered, queue.id)
      expect((yield* recovered.get(queue.id)).tasks[0]?.sessionID).toBe(sessionID)
      yield* recovered.stop(queue.id)
    })),
  )

  it.live("stop waits for a grandchild daemon shell, even without a Job row", () =>
    withQueueDirectory((directory) => Effect.gen(function* () {
      const queues = yield* setup()
      const daemon = yield* daemonShells()
      queueShell = yield* daemon.openShell(directory)
      executionState.mode = "hang"
      const queue = yield* queues.create({ directory, tasks: threeTasks })
      yield* queues.start(queue.id)
      const { sessionID } = yield* runningTaskSession(queues, queue.id)
      const sessions = yield* Session.Service
      const child = yield* sessions.create({ parentID: sessionID })
      const grandchild = yield* sessions.create({ parentID: child.id })
      const command = yield* queueShell.create({ command: "a long build", metadata: { sessionID: grandchild.id } })
      const stopped = yield* queues.stop(queue.id)
      expect(stopped.status).toBe("stopped")
      expect((yield* queueShell.get(command.id)).status).toBe("killed")
      expect(yield* queueShell.list()).toHaveLength(0)
      expect(executionState.resumes).toEqual([sessionID])
    })),
  )

  it.effect(
    "creates a queue with ordered tasks and validates input",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          const queue = yield* queues.create({ title: "Release", directory, tasks: threeTasks })
          expect(queue.title).toBe("Release")
          expect(queue.status).toBe("queued")
          expect(queue.tasks.map((task) => [task.title, task.prompt, task.position, task.status])).toEqual([
            ["One", "do the first thing", 1, "pending"],
            ["Two", "do the second thing", 2, "pending"],
            ["Three", "do the third thing", 3, "pending"],
          ])

          const error = yield* Effect.flip(
            // The schema makes this unreachable for decoded input; the service still guards unknown callers.
            queues.create({ directory, tasks: [] as unknown as [TaskQueue.TaskInput] }),
          )
          expect(error).toMatchObject({ _tag: "TaskQueue.InvalidError", reason: "A queue needs at least one task" })

          expect(yield* queues.list()).toHaveLength(1)
          expect(yield* queues.list({ directory })).toHaveLength(1)
          expect(yield* queues.list({ directory: AbsolutePath.make("/somewhere-else") })).toHaveLength(0)
        }),
      ),
  )

  // TC-034: HTTP resolves missing directories to LocationNotFoundError, but Core list
  // must retain its fallback so removing a directory does not hide its stored queues.
  it.live("lists stored queues after their directory disappears without admitting new queues there", () =>
    withQueueDirectory((root) =>
      Effect.gen(function* () {
        const queues = yield* setup()
        const directory = AbsolutePath.make(path.join(root, "removed"))
        yield* Effect.promise(() => fs.mkdir(directory))
        const queue = yield* queues.create({ directory, tasks: threeTasks })
        yield* Effect.promise(() => fs.rmdir(directory))

        expect(yield* queues.list({ directory })).toEqual([queue])
        expect(yield* queues.get(queue.id)).toEqual(queue)
        expect(yield* queues.create({ directory, tasks: threeTasks }).pipe(Effect.flip)).toMatchObject({
          _tag: "TaskQueue.InvalidError",
          reason: "The queue directory does not exist",
        })
        expect(yield* queues.list()).toEqual([queue])
        yield* queues.remove(queue.id)
        expect(yield* queues.list({ directory })).toEqual([])
      }),
    ),
  )

  it.effect(
    "runs tasks serially, each in its own session, and finishes the queue",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")

          // Reviews happen one task at a time, in order.
          expect(judgeCalls.map((input) => input.task.position)).toEqual([1, 2, 3])
          const sessions = done.tasks.map((task) => task.sessionID)
          expect(new Set(sessions).size).toBe(3)
          expect(done.tasks.map((task) => [task.status, task.summary])).toEqual([
            ["completed", "tests pass"],
            ["completed", "tests pass"],
            ["completed", "tests pass"],
          ])

          // The kickoff carries the task text and the unattended guidance.
          const sessionService = yield* Session.Service
          const inbox = yield* sessionService.inbox(sessions[0]!)
          const kickoff = inbox.find((item) => item.type === "synthetic")
          expect(kickoff?.type === "synthetic" && kickoff.payload.text).toContain("do the first thing")
          expect(kickoff?.type === "synthetic" && kickoff.payload.text).toContain("without a human watching")
          const session = yield* sessionService.get(sessions[0]!)
          expect(session.title).toBe("One")
          expect(session.metadata).toMatchObject({ source: "taskqueue" })
        }),
      ),
  )

  it.effect(
    "moves on after a blocked task and reports the reason",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          judge = (input) =>
            Effect.succeed(
              input.task.position === 1
                ? { verdict: "blocked", reason: "needs credentials only the user has" }
                : { verdict: "done", reason: "tests pass" },
            )
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
          expect(done.tasks.map((task) => task.status)).toEqual(["blocked", "completed", "completed"])
          expect(done.tasks[0]!.reason).toBe("needs credentials only the user has")
        }),
      ),
  )

  it.effect(
    "marks a task failed when its execution fails, then continues",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          executionState.mode = "fail-first"
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
          expect(done.tasks[0]!.status).toBe("failed")
          expect(done.tasks[0]!.reason).toContain("the model run failed")
          expect(done.tasks.slice(1).map((task) => task.status)).toEqual(["completed", "completed"])
        }),
      ),
  )

  it.effect(
    "continues a task after a review round and completes it",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          const { db } = yield* Database.Service
          judge = (input) =>
            Effect.gen(function* () {
              if (input.task.rounds === 0) {
                yield* seedAssistantTool(db, input.session.id, 1, "ran the tests")
                return { verdict: "continue", reason: "tests are missing", next_step: "run the tests" }
              }
              return { verdict: "done", reason: "tests pass" }
            })
          const queue = yield* queues.create({ directory, tasks: [{ title: "One", prompt: "do one" }] })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
          expect(done.tasks[0]).toMatchObject({ status: "completed", rounds: 1, summary: "tests pass" })
          // The continuation reached the same session with the review's reason.
          const sessionService = yield* Session.Service
          const inbox = yield* sessionService.inbox(done.tasks[0]!.sessionID!)
          expect(
            inbox.filter((item) => item.type === "synthetic" && item.payload.text.includes("tests are missing")),
          ).toHaveLength(1)
        }),
      ),
  )

  it.effect(
    "blocks a stalled task after three rounds without progress",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          judge = () => Effect.succeed({ verdict: "continue", reason: "still not done" })
          const queue = yield* queues.create({ directory, tasks: [{ title: "One", prompt: "do one" }] })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const blocked = yield* eventually(
            queues.get(queue.id),
            (info) => info.status === "done" && info.tasks[0]!.status === "blocked",
          )
          // The kickoff sits undelivered in the inbox, so no round shows tools: the same review
          // reason repeats, and the third stalled round in a row blocks the task.
          expect(blocked.tasks[0]!.rounds).toBe(4)
          expect(blocked.tasks[0]!.reason).toContain("4 review rounds")
          expect(judgeCalls).toHaveLength(4)
        }),
      ),
  )

  it.effect(
    "blocks a task after twenty review rounds even with progress",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          const { db } = yield* Database.Service
          judge = (input) =>
            Effect.gen(function* () {
              yield* seedAssistantTool(db, input.session.id, input.task.rounds + 1, "made progress")
              return { verdict: "continue", reason: `missing round ${input.task.rounds + 1}` }
            })
          const queue = yield* queues.create({ directory, tasks: [{ title: "One", prompt: "do one" }] })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const blocked = yield* eventually(
            queues.get(queue.id),
            (info) => info.status === "done" && info.tasks[0]!.status === "blocked",
          )
          expect(blocked.tasks[0]!.rounds).toBe(20)
          expect(blocked.tasks[0]!.reason).toContain("20 review rounds")
          expect(judgeCalls).toHaveLength(20)
        }),
      ),
  )

  it.effect(
    "stops the current task as interrupted and keeps pending tasks",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          executionState.mode = "hang"
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const { sessionID } = yield* runningTaskSession(queues, queue.id)
          const stopped = yield* queues.stop(queue.id).pipe(Effect.orDie)
          yield* eventually(queues.get(queue.id), (info) => info.tasks[0]!.status === "interrupted")

          expect(stopped.status).toBe("stopped")
          expect(stopped.reason).toBe("stopped by the user")
          expect(stopped.tasks.map((task) => task.status)).toEqual(["interrupted", "pending", "pending"])
          expect(executionState.interrupts).toEqual([sessionID])
          // Stop is idempotent.
          expect((yield* queues.stop(queue.id).pipe(Effect.orDie)).status).toBe("stopped")
        }),
      ),
  )

  it.effect(
    "resumes a stopped queue and reuses the interrupted task's session",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          executionState.mode = "hang"
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const { sessionID } = yield* runningTaskSession(queues, queue.id)
          yield* queues.stop(queue.id).pipe(Effect.orDie)
          yield* eventually(queues.get(queue.id), (info) => info.tasks[0]!.status === "interrupted")

          // Resume runs the interrupted task first, on its own session, then the rest.
          executionState.mode = "succeed"
          const resumed = yield* queues.resume(queue.id).pipe(Effect.orDie)
          expect(resumed.status).toBe("running")
          const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
          expect(done.tasks[0]!.sessionID).toBe(sessionID)
          expect(done.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"])
          expect(judgeCalls.map((input) => input.task.position)).toEqual([1, 2, 3])
          // The resume continuation went to the same session.
          const sessionService = yield* Session.Service
          const inbox = yield* sessionService.inbox(sessionID)
          expect(inbox.filter((item) => item.type === "synthetic")).toHaveLength(2)
        }),
      ),
  )

  it.effect(
    "stops a queue when the owner lease expires without heartbeats",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          executionState.mode = "hang"
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          yield* runningTaskSession(queues, queue.id)

          yield* TestClock.adjust("35 seconds")
          const stopped = yield* eventually(
            queues.get(queue.id),
            (info) => info.status === "stopped" && info.tasks[0]!.status === "interrupted",
          )
          expect(stopped.reason).toBe("owner disconnected")
          expect(stopped.tasks.map((task) => task.status)).toEqual(["interrupted", "pending", "pending"])
        }),
      ),
  )

  it.effect(
    "keeps a heartbeated queue alive and extends its lease",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          executionState.mode = "hang"
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const { db } = yield* Database.Service
          const lease = () =>
            db
              .select({ lease: TaskQueueTable.lease_expires_at })
              .from(TaskQueueTable)
              .where(eq(TaskQueueTable.id, queue.id))
              .get()
              .pipe(Effect.map((row) => row?.lease))

          // TC-011: maintain the owner for four TTLs, not just a single renewal.
          for (const _ of [1, 2, 3, 4, 5, 6]) {
            const before = yield* lease()
            yield* TestClock.adjust("20 seconds")
            yield* queues.heartbeat(queue.id).pipe(Effect.orDie)
            const after = yield* lease()
            expect(after).toBeGreaterThan(before!)
            expect(yield* queues.get(queue.id).pipe(Effect.map((info) => info.status))).toBe("running")
          }
          expect(yield* Effect.flip(queues.heartbeat(TaskQueue.ID.create()))).toMatchObject({
            _tag: "TaskQueue.NotFoundError",
          })
        }),
      ),
  )

  it.effect(
    "preserves a foreign owner's valid lease when another service starts",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          executionState.mode = "hang"
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          yield* runningTaskSession(queues, queue.id)

          // A different process's boot: the queue row claims another owner.
          const { db } = yield* Database.Service
          yield* db
            .update(TaskQueueTable)
            .set({ owner_boot: "boot-another-process" })
            .where(eq(TaskQueueTable.id, queue.id))
            .run()
            .pipe(Effect.orDie)

          const database = yield* Database.Service
          const bus = yield* Bus.Service
          const sessions = yield* Session.Service
          const jobs = yield* Job.Service
          const store = yield* SessionStore.Service
          const instances = yield* Instance.Service
          const scope = yield* Effect.scope
          yield* TaskQueue.make.pipe(
            Effect.provideService(Database.Service, database),
            Effect.provideService(Bus.Service, bus),
            Effect.provideService(Session.Service, sessions),
            Effect.provideService(SessionExecution.Service, SessionExecution.Service.of({
              active: Effect.succeed(new Set()),
              isActive: () => Effect.succeed(false),
              resume: () => Effect.die("a restarted server must not drive the old queue"),
              wake: () => Effect.void,
              interrupt: () => Effect.succeed(false),
              awaitIdle: () => Effect.void,
            })),
            Effect.provideService(Job.Service, jobs),
            Effect.provideService(SessionStore.Service, store),
            Effect.provideService(Instance.Service, instances),
            Effect.provideService(Scope.Scope, scope),
          )

          const interrupted = yield* queues.get(queue.id)
          expect(interrupted.status).toBe("running")
          expect(interrupted.tasks.map((task) => task.status)).toEqual(["running", "pending", "pending"])
          expect(yield* Effect.flip(queues.resume(queue.id))).toMatchObject({ _tag: "TaskQueue.InvalidError" })
          // Even an expired client lease is not proof that a foreign server finished its side effects.
          yield* db.update(TaskQueueTable).set({ lease_expires_at: 0 }).where(eq(TaskQueueTable.id, queue.id)).run().pipe(Effect.orDie)
          yield* anotherService()
          expect((yield* queues.get(queue.id)).status).toBe("running")
        }),
      ),
  )

  it.effect(
    "rejects permission asks and cancels forms only for queue task sessions",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          executionState.mode = "hang"
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          const { sessionID } = yield* runningTaskSession(queues, queue.id)

          const instances = yield* Instance.Service
          const sessionService = yield* Session.Service
          const root = yield* sessionService.get(sessionID)
          const child = yield* sessionService.create({ parentID: root.id })
          const grandchild = yield* sessionService.create({ parentID: child.id })
          for (const queueSession of [root, child, grandchild]) {
          const approval = yield* (instances.provide(queueSession))(
            Permission.Service.use((permission) =>
              permission.assert({
                action: "file_write",
                resources: ["secret.txt"],
                sessionID: queueSession.id,
                agent: Agent.defaultID,
              }),
            ),
          ).pipe(Effect.flip)
          expect(approval).toMatchObject({ _tag: "Permission.CorrectedError" })
          expect(approval._tag === "Permission.CorrectedError" && approval.feedback).toContain("runs unattended")

          const question = yield* (instances.provide(queueSession))(
            Form.Service.use((forms) =>
              forms.ask({
                sessionID: queueSession.id,
                title: "Which database?",
                fields: [{ key: "choice", type: "string" }],
              }),
            ),
          )
          expect(question).toMatchObject({ status: "cancelled" })
          expect(question.status === "cancelled" && question.message).toContain("runs unattended")
          }

          // A session outside the queue keeps waiting for a human.
          const other = yield* sessionService.create({ location: { directory } })
          const waiting = yield* (instances.provide(other))(
            Permission.Service.use((permission) =>
              permission.assert({
                action: "file_write",
                resources: ["secret.txt"],
                sessionID: other.id,
                agent: Agent.defaultID,
              }),
            ),
          ).pipe(Effect.forkScoped)
          yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))
          expect(
            yield* (instances.provide(other))(Permission.Service.use((permission) => permission.forSession(other.id))),
          ).toHaveLength(1)
          expect(waiting.pollUnsafe()).toBeUndefined()
          // A human can still answer it.
          yield* (instances.provide(other))(
            Permission.Service.use((permission) => permission.forSession(other.id)),
          ).pipe(
            Effect.flatMap((pending) =>
              (instances.provide(other))(
                Permission.Service.use((permission) =>
                  permission.reply({ requestID: pending[0]!.id, reply: "once" }),
                ),
              ),
            ),
            Effect.orDie,
          )
          yield* Fiber.join(waiting)
          const form = yield* instances.provide(other)(Form.Service.use((forms) => forms.ask({ sessionID: other.id, title: "Normal question", fields: [{ key: "answer", type: "string" }] }))).pipe(Effect.forkScoped)
          yield* Effect.yieldNow.pipe(Effect.repeat({ times: 20 }))
          expect(form.pollUnsafe()).toBeUndefined()
          yield* queues.stop(queue.id)
          yield* Fiber.interrupt(form)
        }),
      ),
  )

  it.effect(
    "waits bounded for a wait verdict's background shell, then cancels it and blocks the task",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          const jobs = yield* Job.Service
          const { db } = yield* Database.Service
          judge = (input) =>
            Effect.gen(function* () {
              if (input.task.position > 1) return { verdict: "done", reason: "tests pass" }
              if (input.task.rounds > 0) return { verdict: "wait", reason: "needs the running shell" }
              // The first review sees no shell yet: ask for more work, leaving one behind.
              yield* jobs.start({
                id: `shell-${input.task.id}`,
                type: "shell",
                background: true,
                recovery: {
                  kind: "shell",
                  sessionID: input.session.id,
                  shellID: `sh_${input.task.id}`,
                  command: "npm run build",
                },
                run: Effect.never,
              })
              yield* seedAssistantTool(db, input.session.id, 1, "started the build")
              return { verdict: "continue", reason: "the build must finish" }
            })
          const queue = yield* queues.create({ directory, tasks: threeTasks })
          yield* queues.start(queue.id).pipe(Effect.orDie)

          // Interleave real progress (yields) with virtual time: the wait polls every five seconds for
          // two minutes, while heartbeats keep the lease alive.
          let blocked: TaskQueue.Info | undefined
          for (let step = 0; step < 800 && blocked === undefined; step++) {
            const info = yield* queues.get(queue.id).pipe(Effect.orElseSucceed(() => undefined))
            if (info !== undefined && info.tasks[0]!.status === "blocked") blocked = info
            if (step % 4 === 3) {
              yield* TestClock.adjust("5 seconds")
              yield* queues.heartbeat(queue.id).pipe(Effect.ignore)
            }
            yield* Effect.yieldNow
          }
          expect(blocked).toBeDefined()
          expect(blocked!.tasks[0]!.reason).toContain("Timed out waiting for background work")
          // Cancelling the session's background work also removes it from the registry.
          expect(yield* jobs.get(`shell-${blocked!.tasks[0]!.id}`)).toBeUndefined()
          // The queue still finishes everything else.
          const done = yield* eventually(queues.get(queue.id), (info) => info.status === "done")
          expect(done.tasks.map((task) => task.status)).toEqual(["blocked", "completed", "completed"])
        }),
      ),
  )

  it.effect(
    "publishes taskqueue.updated with the full queue info on every change",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const seen: TaskQueue.Info[] = []
          const unsubscribe = yield* bus.listen((event) =>
            event.type === TaskQueue.Event.Updated.type
              ? Effect.sync(() => seen.push(event.data as TaskQueue.Info))
              : Effect.void,
          )
          yield* Effect.addFinalizer(() => unsubscribe)

          const queues = yield* setup()
          const queue = yield* queues.create({ directory, tasks: [{ title: "One", prompt: "do one" }] })
          yield* queues.start(queue.id).pipe(Effect.orDie)
          yield* eventually(queues.get(queue.id), (info) => info.status === "done")

          const mine = seen.filter((info) => info.id === queue.id)
          expect(mine.at(0)!.status).toBe("queued")
          expect(mine.at(-1)!.status).toBe("done")
          // Queue-level transitions arrive in order, with task-level publishes in between.
          const transitions = mine
            .map((info) => info.status)
            .filter((status, index, all) => index === 0 || status !== all[index - 1])
          expect(transitions).toEqual(["queued", "running", "done"])
          expect(mine.every((info) => info.directory === queue.directory)).toBe(true)
          expect(mine.some((info) => info.tasks[0]!.status === "running")).toBe(true)
          expect(mine.at(-1)!.tasks[0]).toMatchObject({ status: "completed", summary: "tests pass" })
        }),
      ),
  )

  it.effect(
    "removes only queues that are not running",
    () =>
      withQueueDirectory((directory) =>
        Effect.gen(function* () {
          const queues = yield* setup()
          const queue = yield* queues.create({ directory, tasks: [{ title: "One", prompt: "do one" }] })
          yield* queues.remove(queue.id).pipe(Effect.orDie)
          expect(yield* Effect.flip(queues.get(queue.id))).toMatchObject({ _tag: "TaskQueue.NotFoundError" })

          executionState.mode = "hang"
          const running = yield* queues.create({ directory, tasks: [{ title: "Two", prompt: "do two" }] })
          yield* queues.start(running.id).pipe(Effect.orDie)
          const { sessionID } = yield* runningTaskSession(queues, running.id)
          expect(yield* Effect.flip(queues.remove(running.id))).toMatchObject({ _tag: "TaskQueue.InvalidError" })
          yield* queues.stop(running.id).pipe(Effect.orDie)
          yield* queues.remove(running.id).pipe(Effect.orDie)
          expect(yield* queues.list()).toHaveLength(0)
          const { db } = yield* Database.Service
          const store = yield* SessionStore.Service
          expect(yield* TaskQueueOwnership.admitted(db, store, sessionID)).toBe(false)
        }),
      ),
  )
})
