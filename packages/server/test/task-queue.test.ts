import fs from "node:fs/promises"
import path from "node:path"
import Sqlite from "bun:sqlite"
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionRunnerLLM } from "@opencode/core/session/runner/llm"
import { TaskQueue } from "@opencode/core/task-queue"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Deferred, Effect, Layer, Queue } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const client = (handler: (request: Request) => Promise<Response>) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })
type Api = Awaited<ReturnType<typeof client>>

// Existing execution API regressions intentionally exercise historical persisted queues.
// This test-only fixture seeds the legacy marker through SQLite; no API accepts it.
const legacyClient = (handler: (request: Request) => Promise<Response>, databasePath: string): Api => {
  const api = client(handler)
  return { ...api, taskQueue: { ...api.taskQueue, create: async (...args: Parameters<Api["taskQueue"]["create"]>) => {
    const queue = await api.taskQueue.create(...args)
    using database = new Sqlite(databasePath)
    database.query("UPDATE task_queue SET workflow_version = 1, phase = 'execution' WHERE id = ?").run(queue.id)
    return api.taskQueue.get({ queueID: queue.id })
  } } }
}

// Fake execution: every resume hangs until interrupted, so a started queue stays deterministically
// running without an LLM and stop/resume follow the real scheduler state machine.
type ExecutionState = {
  resumes: Array<Session.ID>
  interrupts: Array<Session.ID>
  hanging?: { readonly sessionID: Session.ID; readonly deferred: Deferred.Deferred<void, never> }
  started?: Queue.Queue<Session.ID>
}
let executionState: ExecutionState = { resumes: [], interrupts: [] }
const resetExecution = (): ExecutionState => (executionState = { resumes: [], interrupts: [] })

const execution = Layer.effect(
  SessionExecution.Service,
  Effect.sync(() => {
    // Capture this server's observer. A Bun timeout does not cancel the returned
    // Promise, so resetting for the next test must not redirect a late fake drain.
    const state = executionState
    return SessionExecution.Service.of({
      active: Effect.sync(() => new Set(state.hanging ? [state.hanging.sessionID] : [])),
      isActive: (sessionID) => Effect.sync(() => state.hanging?.sessionID === sessionID),
      wake: () => Effect.void,
      awaitIdle: () => Effect.void,
      resume: (sessionID) =>
        Effect.gen(function* () {
          state.resumes.push(sessionID)
          const deferred = yield* Deferred.make<void, never>()
          state.hanging = { sessionID, deferred }
          if (state.started) yield* Queue.offer(state.started, sessionID)
          yield* Deferred.await(deferred)
        }),
      interrupt: (sessionID) =>
        Effect.gen(function* () {
          if (state.hanging?.sessionID !== sessionID) return false
          state.interrupts.push(sessionID)
          const deferred = state.hanging.deferred
          state.hanging = undefined
          yield* Deferred.interrupt(deferred)
          return true
        }),
    })
  }),
)

const twoTasks = [
  { title: "First", prompt: "do the first thing" },
  { title: "Second", prompt: "do the second thing" },
] as const

/** Polls until the queue has a running task with its session, then returns that session ID. */
async function waitForTaskSession(api: Api, queueID: string, generation = 1) {
  const deadline = Date.now() + 5_000
  const state = executionState
  while (true) {
    const info = await api.taskQueue.get({ queueID })
    const running = info.tasks.find((task) => task.status === "running" && task.sessionID)
    if (running?.sessionID && state.resumes.filter((id) => id === running.sessionID).length >= generation)
      return running.sessionID
    if (Date.now() > deadline) throw new Error(`task never started running: ${JSON.stringify(info)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const bootDirs = (dirs: ReadonlyArray<{ readonly name: string; readonly flag: boolean }>, rootFlag?: boolean, project = true) =>
  Effect.fnUntraced(function* (root: string) {
    yield* Effect.promise(async () => {
      if (rootFlag !== undefined)
        await fs.writeFile(path.join(root, "opencode.json"), JSON.stringify({ experimental: { task_queue: rootFlag } }))
      await Promise.all(
        dirs.map((dir) =>
          fs
            .mkdir(path.join(root, dir.name), { recursive: true })
            .then(() =>
              fs.writeFile(
                path.join(root, dir.name, "opencode.json"),
                JSON.stringify({ experimental: { task_queue: dir.flag } }),
              ),
            ),
        ),
      )
    })
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: path.join(root, "opencode.db") },
        config: { directory: root, project, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      { overrides: [SessionExecution.node.replace(execution)] },
    )
    return legacyClient(handler, path.join(root, "opencode.db"))
  })

it.live("runs the historical task-queue lifecycle without an experimental flag", () =>
  Effect.gen(function* () {
    const state = resetExecution()
    const started = yield* Queue.unbounded<Session.ID>()
    state.started = started
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      if (state.started === started) state.started = undefined
    }))
    const run = Effect.runPromiseWith(yield* Effect.context())
    const began = performance.now()
    const timings: Array<{ stage: string; elapsedMs: number }> = []
    const mark = (stage: string) => timings.push({ stage, elapsedMs: Math.round(performance.now() - began) })
    const root = (yield* tmpdirScoped("opencode-task-queue-api-")).path
    // This lifecycle contract does not exercise project config discovery; the flag and
    // junction cases below own it. Keep unrelated cold filesystem discovery out of here.
    const api = yield* bootDirs([], undefined, false)(root)
    mark("server-built")
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))

    yield* Effect.promise(async (signal) => {
      const events = api.event
        .subscribe({ types: ["taskqueue.updated"], signal: controller.signal })
        [Symbol.asyncIterator]()
      expect((await events.next()).value?.type).toBe("server.connected")
      mark("event-stream-connected")
      const nextQueue = async (status: "queued" | "running" | "stopped") => {
        while (true) {
          const event = await events.next()
          if (event.done) throw new Error("queue event stream ended early")
          if (event.value.type === "taskqueue.updated" && event.value.data.status === status) return event.value.data
        }
      }
      const created = await api.taskQueue.create({
        directory: root,
        title: "Release",
        tasks: twoTasks,
      })
      mark("queue-created")
      expect((await nextQueue("queued")).id).toBe(created.id)
      expect(created).toMatchObject({
        title: "Release",
        directory: root,
        status: "queued",
        tasks: [
          { title: "First", status: "pending", position: 1 },
          { title: "Second", status: "pending", position: 2 },
        ],
      })
      expect(await api.taskQueue.list({ directory: root })).toMatchObject([
        { id: created.id, status: "queued" },
      ])
      expect(await api.taskQueue.get({ queueID: created.id })).toMatchObject({ id: created.id })

      // A queued queue refuses the running-only routes.
      await expect(api.taskQueue.heartbeat({ queueID: created.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })
      await expect(api.taskQueue.resume({ queueID: created.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })
      mark("queued-contract-checked")

      // Start makes it running; a second start is refused, a heartbeat renews.
      expect(await api.taskQueue.start({ queueID: created.id })).toMatchObject({ status: "running" })
      mark("start-response")
      await expect(api.taskQueue.start({ queueID: created.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })
      expect(await api.taskQueue.heartbeat({ queueID: created.id })).toMatchObject({ status: "running" })

      // The first task hangs mid-run; a running queue cannot be removed.
      // The fake executor's handshake observes actual execution, without repeatedly rebuilding
      // the HTTP/Location read path while a cold server and other checks compete for CPU.
      mark("waiting-first-execution")
      const first = await run(Queue.take(started), { signal })
      mark("first-execution-started")
      expect((await api.taskQueue.get({ queueID: created.id })).tasks[0]).toMatchObject({ status: "running", sessionID: first })
      expect(state.hanging?.sessionID).toBe(first)
      await expect(api.taskQueue.delete({ queueID: created.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })

      // Stop records its reason, interrupts the current task, keeps the pending task, and is idempotent.
      const stopped = await api.taskQueue.stop({ queueID: created.id, reason: "the TUI exited" })
      mark("first-execution-stopped")
      expect(state.hanging).toBeUndefined()
      expect(await nextQueue("stopped")).toEqual(stopped)
      expect(stopped).toMatchObject({ status: "stopped", reason: "the TUI exited" })
      expect(stopped.tasks[0]).toMatchObject({ status: "interrupted", sessionID: first })
      expect(stopped.tasks[1]).toMatchObject({ status: "pending" })
      expect(await api.taskQueue.stop({ queueID: created.id })).toMatchObject({ status: "stopped" })

      // Resume continues the interrupted task in its own session, not a new one.
      expect(await api.taskQueue.resume({ queueID: created.id })).toMatchObject({ status: "running" })
      mark("waiting-second-execution")
      expect(await run(Queue.take(started), { signal })).toBe(first)
      mark("second-execution-started")
      expect((await api.taskQueue.get({ queueID: created.id })).tasks[0]).toMatchObject({ status: "running", sessionID: first })
      expect(state.hanging?.sessionID).toBe(first)
      expect(state.resumes.filter((id) => id === first)).toHaveLength(2)
      expect(await api.taskQueue.stop({ queueID: created.id })).toMatchObject({ status: "stopped" })

      // A stopped queue can be removed and then reads as gone.
      await api.taskQueue.delete({ queueID: created.id })
      await expect(api.taskQueue.get({ queueID: created.id })).rejects.toMatchObject({
        _tag: "TaskQueueNotFoundError",
      })

      // Every execution the scheduler drove belonged to the first task's session.
      expect(state.resumes.length).toBeGreaterThanOrEqual(2)
      expect(state.resumes.every((id) => id === first)).toBe(true)
      expect(state.interrupts.map(() => first)).toEqual([first, first])
      await events.return?.()
      mark("completed-and-closed-stream")
      console.log(`TASK_QUEUE_SERVER_LIFECYCLE ${JSON.stringify({ timings, resumes: state.resumes.length, interrupts: state.interrupts.length, active: !!state.hanging })}`)
    })
  }).pipe(Effect.scoped),
)

it.live("new SDK queues require planning, retain interactive Forms and cannot start or resume before all plans are approved", () => Effect.gen(function* () {
  resetExecution()
  const root = (yield* tmpdirScoped("qp-")).path
  const handler = yield* ServerFetch.make({ app: { version: "test" }, database: { path: path.join(root, "opencode.db") },
    config: { directory: root, project: false, claude: false }, models: { fetch: false }, fs: { filewatcher: false },
  }, { overrides: [SessionExecution.node.replace(execution)] })
  const api = client(handler)
  yield* Effect.promise(async () => {
    const queue = await api.taskQueue.create({ directory: root, tasks: twoTasks })
    expect(queue).toMatchObject({ workflowVersion: 2, phase: "planning", status: "queued" })
    for (const operation of [api.taskQueue.start, api.taskQueue.resume])
      await expect(operation({ queueID: queue.id })).rejects.toMatchObject({ _tag: "InvalidRequestError", kind: "task_queue" })
    expect(executionState.resumes).toEqual([])
    expect(await api.taskQueue.plan({ queueID: queue.id })).toMatchObject({ phase: "planning", status: "running" })
    const deadline = Date.now() + 10_000
    const sessionID = await (async () => {
      while (true) {
        const info = await api.taskQueue.get({ queueID: queue.id })
        const task = info.tasks[0]
        if (task?.status === "planning" && task.sessionID && executionState.resumes.includes(Session.ID.make(task.sessionID))) return task.sessionID
        if (Date.now() >= deadline) throw new Error("planning root did not become active")
        await Bun.sleep(1)
      }
    })()
    const form = await api.session.form.create({ sessionID, title: "需求澄清", fields: [{ key: "answer", type: "string" }] })
    expect(await api.session.form.get({ sessionID, formID: form.id })).toMatchObject({ state: { status: "pending" } })
    await api.session.form.reply({ sessionID, formID: form.id, answer: { answer: "用户真实回答" } })
    expect(await api.taskQueue.heartbeat({ queueID: queue.id })).toMatchObject({ phase: "planning", status: "running" })
    await api.taskQueue.stop({ queueID: queue.id })
    await expect(api.taskQueue.resume({ queueID: queue.id })).rejects.toMatchObject({ _tag: "InvalidRequestError" })
    await api.taskQueue.plan({ queueID: queue.id })
    expect((await api.taskQueue.get({ queueID: queue.id })).tasks[0]?.sessionID).toBe(sessionID)
    await api.taskQueue.stop({ queueID: queue.id })
  })
}).pipe(Effect.scoped))

it.live("accepts title-less tasks with legacy false config and reports missing queues", () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("opencode-task-queue-flag-")).path
    const api = yield* bootDirs(
      [
        { name: "enabled", flag: true },
        { name: "disabled", flag: false },
      ],
      true,
    )(root)

    yield* Effect.promise(async () => {
      const prompt = "\r\n \t\r\n  修复接口 😀  \r\n保留完整内容和空白  "
      const longPrompt = `\n${"中".repeat(78)}😀😀😀\r\n不能丢弃的完整内容  `
      const created = await api.taskQueue.create({
        directory: path.join(root, "disabled"),
        tasks: [{ prompt }, { prompt: longPrompt }, { title: "  旧调用方标题  ", prompt }],
      })
      expect(created.status).toBe("queued")
      expect(created.tasks[0]).toMatchObject({ title: "修复接口 😀", prompt })
      expect(created.tasks[1]).toMatchObject({ title: `${"中".repeat(78)}😀…`, prompt: longPrompt })
      expect(created.tasks[2]).toMatchObject({ title: "  旧调用方标题  ", prompt })
      expect(await api.taskQueue.list({ directory: path.join(root, "disabled") })).toEqual([created])
      expect(await api.taskQueue.get({ queueID: created.id })).toEqual(created)
      await api.taskQueue.start({ queueID: created.id })
      await waitForTaskSession(api, created.id)
      expect(await api.taskQueue.heartbeat({ queueID: created.id })).toMatchObject({ status: "running" })
      await api.taskQueue.stop({ queueID: created.id })
      await api.taskQueue.resume({ queueID: created.id })
      await waitForTaskSession(api, created.id, 2)
      await api.taskQueue.stop({ queueID: created.id })
      await api.taskQueue.delete({ queueID: created.id })
      // Listing another directory does not leak the queue into it.
      expect(await api.taskQueue.list({ directory: root })).toEqual([])

      // Unknown queues read as 404 on every route.
      for (const call of [
        () => api.taskQueue.get({ queueID: "tq_none" }),
        () => api.taskQueue.start({ queueID: "tq_none" }),
        () => api.taskQueue.heartbeat({ queueID: "tq_none" }),
        () => api.taskQueue.stop({ queueID: "tq_none" }),
        () => api.taskQueue.resume({ queueID: "tq_none" }),
        () => api.taskQueue.delete({ queueID: "tq_none" }),
      ]) {
        await expect(call()).rejects.toMatchObject({ _tag: "TaskQueueNotFoundError" })
      }
    })
  }).pipe(Effect.scoped),
)

it.live("keeps all ID-based methods' location errors when the queue directory disappears", () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("qf-")).path
    const api = yield* bootDirs([{ name: "project", flag: false }])(root)
    const created = yield* Effect.promise(() =>
      api.taskQueue.create({ directory: path.join(root, "project"), tasks: twoTasks }),
    )
    // Keep this same server's cached Location alive while its directory disappears.
    yield* Effect.promise(() => fs.rm(path.join(root, "project"), { recursive: true }))
    yield* Effect.promise(async () => {
      const queueID = created.id
      for (const call of [
        () => api.taskQueue.create({ directory: created.directory, tasks: twoTasks }),
        () => api.taskQueue.list({ directory: created.directory }),
        () => api.taskQueue.get({ queueID }),
        () => api.taskQueue.start({ queueID }),
        () => api.taskQueue.heartbeat({ queueID }),
        () => api.taskQueue.stop({ queueID }),
        () => api.taskQueue.resume({ queueID }),
        () => api.taskQueue.delete({ queueID }),
      ])
        await expect(call()).rejects.toMatchObject({ _tag: "LocationNotFoundError" })
      expect(executionState.hanging).toBeUndefined()
    })
  }).pipe(Effect.scoped),
)

// TC-026/029: use an actual Windows junction (directory symlink on other hosts),
// not a manually lowercased string standing in for server-side filesystem identity.
it.live("canonicalizes junction create/list and prevents alias and case variants from running a second batch", () =>
  Effect.gen(function* () {
    resetExecution()
    const root = (yield* tmpdirScoped("qa-")).path
    const api = yield* bootDirs([{ name: "project", flag: true }])(root)
    const directory = path.join(root, "project")
    const alias = path.join(root, "alias")
    yield* Effect.acquireRelease(
      Effect.promise(() => fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir")),
      // Remove the link itself before the fixture's recursive cleanup; never traverse it.
      () => Effect.promise(() => fs.unlink(alias)),
    )
    yield* Effect.promise(async () => {
      const real = await fs.realpath(directory)
      const first = await api.taskQueue.create({ directory: alias, tasks: twoTasks })
      expect(first.directory).toBe(real)
      const variants = [directory, alias, process.platform === "win32" ? alias.toUpperCase() : path.join(alias, ".")]
      for (const value of variants) {
        expect(await api.taskQueue.list({ directory: value })).toMatchObject([
          { id: first.id, directory: real },
        ])
      }
      const second = await api.taskQueue.create({ directory, tasks: twoTasks })
      await api.taskQueue.start({ queueID: first.id })
      await waitForTaskSession(api, first.id)
      await expect(api.taskQueue.start({ queueID: second.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })
      expect((await api.taskQueue.get({ queueID: first.id })).directory).toBe(real)
      await api.taskQueue.stop({ queueID: first.id })
      await api.taskQueue.delete({ queueID: first.id })
      expect(await api.taskQueue.list({ directory: alias })).toMatchObject([
        { id: second.id, status: "queued" },
      ])
      await api.taskQueue.delete({ queueID: second.id })
      expect(await api.taskQueue.list({ directory })).toEqual([])
    })
  }).pipe(Effect.scoped),
)

// R-API-01: exercise the generated SDK and declared error mapping, not just direct Core admission.
it.live("rejects start and resume through the formal API after a stored directory is replaced by a junction", () =>
  Effect.gen(function* () {
    resetExecution()
    const root = (yield* tmpdirScoped("qd-")).path
    const api = yield* bootDirs([])(root)
    const directory = path.join(root, "original")
    const target = path.join(root, "target")
    yield* Effect.promise(() => Promise.all([fs.mkdir(directory), fs.mkdir(target)]))
    const queued = yield* Effect.promise(() => api.taskQueue.create({ directory, tasks: twoTasks }))
    const stopped = yield* Effect.promise(async () => {
      const queue = await api.taskQueue.create({ directory, tasks: twoTasks })
      await api.taskQueue.start({ queueID: queue.id })
      await waitForTaskSession(api, queue.id)
      return api.taskQueue.stop({ queueID: queue.id })
    })
    yield* Effect.promise(() => fs.rmdir(directory))
    yield* Effect.acquireRelease(
      Effect.promise(() => fs.symlink(target, directory, process.platform === "win32" ? "junction" : "dir")),
      // Remove this fixture's link itself, never its canonical target.
      () => Effect.promise(() => fs.unlink(directory)),
    )
    yield* Effect.promise(async () => {
      const other = await api.taskQueue.create({ directory: target, tasks: twoTasks })
      await api.taskQueue.start({ queueID: other.id })
      const running = await waitForTaskSession(api, other.id)
      expect(await fs.realpath(directory)).toBe(other.directory)
      using database = new Sqlite(path.join(root, "opencode.db"), { readonly: true })
      const queues = database.query("SELECT * FROM task_queue ORDER BY id").all()
      const tasks = database.query("SELECT * FROM task_queue_task ORDER BY id").all()
      const sessions = database.query("SELECT * FROM session_v2 ORDER BY id").all()
      const inboxes = database.query("SELECT * FROM session_inbox ORDER BY id").all()
      const resumes = [...executionState.resumes]
      for (const [action, queue] of [["start", queued], ["resume", stopped]] as const) {
        await expect(api.taskQueue[action]({ queueID: queue.id })).rejects.toMatchObject({
          _tag: "InvalidRequestError", kind: "task_queue",
          message: "The queue directory now resolves to a different location; restore the original directory or create a new queue",
        })
        expect(await api.taskQueue.get({ queueID: queue.id })).toEqual(queue)
      }
      expect(database.query("SELECT * FROM task_queue ORDER BY id").all()).toEqual(queues)
      expect(database.query("SELECT * FROM task_queue_task ORDER BY id").all()).toEqual(tasks)
      expect(database.query("SELECT * FROM session_v2 ORDER BY id").all()).toEqual(sessions)
      expect(database.query("SELECT * FROM session_inbox ORDER BY id").all()).toEqual(inboxes)
      expect(executionState.resumes).toEqual(resumes)
      expect(executionState.hanging).toMatchObject({ sessionID: running })
      expect(await api.taskQueue.list({ directory: target })).toEqual([await api.taskQueue.get({ queueID: other.id })])
      expect(await api.taskQueue.stop({ queueID: stopped.id })).toEqual(stopped)
      await api.taskQueue.stop({ queueID: other.id })
      expect(executionState.hanging).toBeUndefined()
    })
  }).pipe(Effect.scoped),
)

// TC-012: real non-ASCII rename before either start, through the formal generated client.
for (const phase of ["start and same-Session resume", "done-resume"] as const) {
it.live(`keeps Unicode directory ${phase} and list consistent through the formal API`, () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("qu-")).path
    const active = new Map<Session.ID, Deferred.Deferred<void>>()
    const resumed = yield* Queue.unbounded<Session.ID>()
    const run = Effect.runPromiseWith(yield* Effect.context())
    const state = { finish: phase === "done-resume", maximum: 0 }
    const unicodeExecution = Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
      active: Effect.sync(() => new Set(active.keys())),
      isActive: (id) => Effect.sync(() => active.has(id)),
      wake: () => Effect.void,
      awaitIdle: () => Effect.void,
      resume: (id) => Effect.gen(function* () {
        if (state.finish) return
        const gate = yield* Deferred.make<void>()
        active.set(id, gate)
        state.maximum = Math.max(state.maximum, active.size)
        yield* Queue.offer(resumed, id)
        yield* Deferred.await(gate)
      }),
      interrupt: (id) => Effect.gen(function* () {
        const gate = active.get(id)
        if (!gate) return false
        active.delete(id)
        yield* Deferred.interrupt(gate)
        return true
      }),
    }))
    const handler = yield* ServerFetch.make({
      app: { version: "test" }, database: { path: path.join(root, "opencode.db") },
      config: { directory: root, project: false, claude: false }, models: { fetch: false }, fs: { filewatcher: false },
    }, { overrides: [
      SessionExecution.node.replace(unicodeExecution),
      TaskQueue.node.replace(TaskQueue.configured({ judge: () => Effect.succeed({ verdict: "blocked", reason: "approval missing" }) })),
    ] })
    const api = legacyClient(handler, path.join(root, "opencode.db"))
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
    yield* Effect.promise(async (signal) => {
      const events = phase === "done-resume"
        ? api.event.subscribe({ types: ["taskqueue.updated"], signal: controller.signal })[Symbol.asyncIterator]()
        : undefined
      if (events) expect((await events.next()).value?.type).toBe("server.connected")
      const directory = path.join(root, "project-Ä")
      const renamed = process.platform === "win32" ? path.join(root, "project-ä") : directory
      await fs.mkdir(directory)
      const first = await api.taskQueue.create({ directory, tasks: [{ prompt: "旧目录任务" }] })
      if (process.platform === "win32") await fs.rename(directory, renamed)
      const second = await api.taskQueue.create({ directory: renamed, tasks: [{ prompt: "新目录任务" }] })
      const read = async (queueID: string, status: "running" | "done") => {
        // Resume follows real Session/inbox admission. Observe it instead of polling the full HTTP stack.
        if (status === "running") {
          const id = await run(Queue.take(resumed), { signal })
          const info = await api.taskQueue.get({ queueID })
          expect(info.status).toBe("running")
          expect(info.tasks.find((task) => task.status === "running")?.sessionID).toBe(id)
          expect(active.has(id)).toBe(true)
          return info
        }
        if (!events) throw new Error("done observation requires a queue event subscription")
        while (true) {
          const event = await events.next()
          if (event.done) throw new Error("queue event stream ended before completion")
          if (event.value.type === "taskqueue.updated" && event.value.data.id === queueID && event.value.data.status === "done") break
        }
        const info = await api.taskQueue.get({ queueID })
        expect(info.status).toBe("done")
        return info
      }
      await api.taskQueue.start({ queueID: first.id })
      const running = await read(first.id, phase === "done-resume" ? "done" : "running")
      const sessionID = running.tasks[0]?.sessionID
      if (!sessionID) throw new Error("the running queue has no Session")
      for (const input of [directory, renamed])
        expect(new Set((await api.taskQueue.list({ directory: input })).map((queue) => queue.id))).toEqual(new Set([first.id, second.id]))
      using database = new Sqlite(path.join(root, "opencode.db"), { readonly: true })
      const sessionDirectory = database.query<{ directory: string }, [string]>("SELECT directory FROM session_v2 WHERE id = ?").get(sessionID)?.directory
      expect(sessionDirectory && path.normalize(sessionDirectory)).toBe(first.directory)
      const snapshot = () => ["task_queue", "task_queue_task", "session_v2", "session_inbox"].map((table) => database.query(`SELECT * FROM ${table} ORDER BY id`).all())
      if (phase === "start and same-Session resume") {
        const before = snapshot()
        await expect(api.taskQueue.start({ queueID: second.id })).rejects.toMatchObject({ _tag: "InvalidRequestError", kind: "task_queue" })
        expect(snapshot()).toEqual(before)
        expect([...active.keys()]).toEqual([Session.ID.make(sessionID)])
        await api.taskQueue.stop({ queueID: first.id })
      }
      if (phase === "done-resume") expect(running.tasks[0]).toMatchObject({ status: "blocked", sessionID })
      state.finish = false
      await api.taskQueue.start({ queueID: second.id })
      await read(second.id, "running")
      const before = snapshot()
      const refused = await api.taskQueue.get({ queueID: first.id })
      await expect(api.taskQueue.resume({ queueID: first.id })).rejects.toMatchObject({ _tag: "InvalidRequestError", kind: "task_queue" })
      expect(await api.taskQueue.get({ queueID: first.id })).toEqual(refused)
      expect(snapshot()).toEqual(before)
      await api.taskQueue.stop({ queueID: second.id })
      await api.taskQueue.resume({ queueID: first.id })
      expect((await read(first.id, "running")).tasks[0]?.sessionID).toBe(sessionID)
      expect(database.query<{ directory: string }, [string]>("SELECT directory FROM task_queue WHERE id = ?").get(first.id)?.directory).toBe(first.directory)
      expect(database.query<{ directory: string }, [string]>("SELECT directory FROM session_v2 WHERE id = ?").get(sessionID)?.directory).toBe(sessionDirectory)
      expect((await api.taskQueue.get({ queueID: second.id })).directory).toBe(second.directory)
      await api.taskQueue.stop({ queueID: first.id })
      expect(active.size).toBe(0)
      expect(state.maximum).toBe(1)
      controller.abort()
      await events?.return?.()
    })
  }).pipe(Effect.scoped),
  // Real FS/SQLite, cold Locations, two Sessions and start/stop/resume share this budget.
  // High-frequency HTTP polling was removed first; cold create alone measured ~5s before start (DEC-011).
  { timeout: 15_000 },
)
}

// Opposite legacy configs no longer gate either alias or canonical target.
for (const enabled of [false, true]) {
  it.live(`canonicalizes a cross-parent junction regardless of legacy target flag ${enabled}`, () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped("qg-")).path
      const api = yield* bootDirs([
        { name: "off", flag: false },
        { name: "on", flag: true },
      ], false)(root)
      const directory = path.join(root, enabled ? "on" : "off", "project")
      const alias = path.join(root, enabled ? "off" : "on", "alias")
      yield* Effect.promise(() => fs.mkdir(directory))
      yield* Effect.acquireRelease(
        Effect.promise(() => fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir")),
        // Unlink the junction itself before tmpdirScoped recursively removes its own root.
        () => Effect.promise(() => fs.unlink(alias)),
      )
      yield* Effect.promise(async () => {
        using database = new Sqlite(path.join(root, "opencode.db"), { readonly: true })
        const created = await api.taskQueue.create({ directory: alias, tasks: twoTasks })
        expect(created.directory).toBe(await fs.realpath(directory))
        for (const value of [alias, directory])
          expect(await api.taskQueue.list({ directory: value })).toEqual([created])
        expect(await api.taskQueue.get({ queueID: created.id })).toEqual(created)
        expect(await api.taskQueue.stop({ queueID: created.id })).toEqual(created)
        await api.taskQueue.delete({ queueID: created.id })
        await expect(api.taskQueue.get({ queueID: created.id })).rejects.toMatchObject({ _tag: "TaskQueueNotFoundError" })
        expect(await api.taskQueue.list({ directory: alias })).toEqual([])
        expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM task_queue").get()?.count).toBe(0)
        expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM task_queue_task").get()?.count).toBe(0)
      })
    }).pipe(Effect.scoped),
  )
}

it.live("keeps authentication on all formal task-queue routes and removes experimental HTTP routes", () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("task-queue-auth-")).path
    const handler = yield* ServerFetch.make({
      password: "task-queue-test-only",
      app: { version: "test" }, database: { path: path.join(root, "opencode.db") },
      config: { directory: root, project: false, claude: false }, models: { fetch: false }, fs: { filewatcher: false },
    })
    yield* Effect.promise(async () => {
      for (const [method, suffix] of [["POST", ""], ["GET", ""], ["GET", "/tq_test"], ["DELETE", "/tq_test"],
        ["POST", "/tq_test/start"], ["POST", "/tq_test/plan"], ["POST", "/tq_test/heartbeat"], ["POST", "/tq_test/stop"], ["POST", "/tq_test/resume"]]) {
        const response = await handler(new Request(`http://opencode.local/api/task-queue${suffix}`, { method }))
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({ _tag: "UnauthorizedError" })
        const old = await handler(new Request(`http://opencode.local/api/experimental/task-queue${suffix}`, { method }))
        expect(old.status).toBe(404)
      }
      const response = await handler(new Request("http://opencode.local/api/task-queue", {
        method: "POST", headers: {
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from("opencode:task-queue-test-only").toString("base64")}`,
        }, body: JSON.stringify({ directory: root, tasks: [{ prompt: "Authenticated work" }] }),
      }))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ data: { tasks: [{ title: "Authenticated work" }] } })
    })
  }).pipe(Effect.scoped),
)

it.live("keeps missing task-queue directories and malformed inputs as declared API errors", () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("qe-")).path
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: path.join(root, "opencode.db") },
      config: { directory: root, project: true, claude: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const api = legacyClient(handler, path.join(root, "opencode.db"))
    yield* Effect.promise(async () => {
      for (const directory of [path.join(root, "missing"), path.join(root, "opencode.db"), path.join(root, "opencode.db", "child"), path.join(root, "invalid\u0000directory")]) {
        const missing = { _tag: "LocationNotFoundError", location: { directory }, message: `Location not found: ${directory}` }
        await expect(api.taskQueue.create({ directory, tasks: twoTasks })).rejects.toMatchObject(missing)
        await expect(api.taskQueue.list({ directory })).rejects.toMatchObject(missing)
      }
      const requests = [
        new Request("http://opencode.local/api/task-queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: 123, tasks: twoTasks }),
        }),
        new Request("http://opencode.local/api/task-queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: root, tasks: [] }),
        }),
        new Request("http://opencode.local/api/task-queue", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: root, tasks: [{ prompt: " \t\r\n　" }] }),
        }),
        new Request("http://opencode.local/api/task-queue", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: root, tasks: [{ prompt: "valid first task" }, { prompt: "\n\t　" }] }),
        }),
        new Request("http://opencode.local/api/task-queue"),
      ]
      for (const request of requests) {
        const response = await handler(request)
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ _tag: "InvalidRequestError" })
      }
      using database = new Sqlite(path.join(root, "opencode.db"), { readonly: true })
      expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM task_queue").get()?.count).toBe(0)
      expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM task_queue_task").get()?.count).toBe(0)
    })
  }).pipe(Effect.scoped),
)

// The transport contract after deletion is currently successful durable admission, not a
// Forbidden response. The real execution fence parks it. A normal Session still starts.
it.live("a deleted batch's Session accepts manual API input but remains fenced while ordinary input executes", () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("qm-")).path
    const drains: string[] = []
    const runner = Layer.effect(
      SessionRunner.Service,
      Effect.gen(function* () {
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        return SessionRunner.Service.of({
          drain: ({ sessionID }) =>
            SessionInbox.promote(database.db, bus, sessionID, "input").pipe(
              Effect.tap(() => Effect.sync(() => drains.push(sessionID))),
              Effect.as(SessionRunner.DrainResult.Complete()),
            ),
        })
      }),
    )
    const handler = yield* ServerFetch.make(
      {
        app: { version: "test" },
        database: { path: path.join(root, "opencode.db") },
        config: { directory: root, project: true, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      {
        overrides: [
          SessionRunnerLLM.node.replace(makeLocationNode({ service: SessionRunner.Service, layer: runner, deps: [Database.node, Bus.node] })),
          TaskQueue.node.replace(
            TaskQueue.configured({ judge: () => Effect.succeed({ verdict: "done", reason: "scripted review" }) }),
          ),
        ],
      },
    )
    const api = legacyClient(handler, path.join(root, "opencode.db"))
    yield* Effect.promise(async () => {
      const queue = await api.taskQueue.create({
        directory: root,
        tasks: [{ title: "Owned", prompt: "work" }],
      })
      await api.taskQueue.start({ queueID: queue.id })
      const deadline = Date.now() + 5_000
      const done = await (async () => {
        while (true) {
          const info = await api.taskQueue.get({ queueID: queue.id })
          if (info.status === "done") return info
          if (Date.now() >= deadline) throw new Error(`queue did not finish: ${JSON.stringify(info)}`)
          await Bun.sleep(1)
        }
      })()
      const sessionID = done.tasks[0]?.sessionID
      if (!sessionID) throw new Error("task has no Session")
      expect(drains).toEqual([sessionID])
      await api.taskQueue.delete({ queueID: queue.id })
      const admitted = await api.session.prompt({ sessionID, text: "Manual after deletion" })
      expect(admitted).toMatchObject({ type: "user", payload: { text: "Manual after deletion" } })
      await api.experimental.session.wait({ sessionID })
      expect(await api.session.inbox.list({ sessionID })).toMatchObject([{ id: admitted.id, type: "user" }])
      expect(drains).toEqual([sessionID])
      const ordinary = await api.session.create({ location: { directory: root }, title: "Ordinary" })
      await api.session.prompt({ sessionID: ordinary.id, text: "Manual ordinary work" })
      await api.experimental.session.wait({ sessionID: ordinary.id })
      expect(drains).toEqual([sessionID, ordinary.id])
      expect(await api.session.inbox.list({ sessionID: ordinary.id })).toEqual([])
    })
  }).pipe(Effect.scoped),
)
