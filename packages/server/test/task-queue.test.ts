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
import { Deferred, Effect, Layer } from "effect"
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

// Fake execution: every resume hangs until interrupted, so a started queue stays deterministically
// running without an LLM and stop/resume follow the real scheduler state machine.
const executionState: {
  resumes: Array<Session.ID>
  interrupts: Array<Session.ID>
  hanging?: { readonly sessionID: Session.ID; readonly deferred: Deferred.Deferred<void, never> }
} = { resumes: [], interrupts: [] }

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(executionState.hanging ? [executionState.hanging.sessionID] : [])),
    isActive: (sessionID) => Effect.sync(() => executionState.hanging?.sessionID === sessionID),
    wake: () => Effect.void,
    awaitIdle: () => Effect.void,
    resume: (sessionID) =>
      Effect.gen(function* () {
        executionState.resumes.push(sessionID)
        const deferred = yield* Deferred.make<void, never>()
        executionState.hanging = { sessionID, deferred }
        yield* Deferred.await(deferred)
      }),
    interrupt: (sessionID) =>
      Effect.gen(function* () {
        if (executionState.hanging?.sessionID !== sessionID) return false
        executionState.interrupts.push(sessionID)
        const deferred = executionState.hanging.deferred
        executionState.hanging = undefined
        yield* Deferred.interrupt(deferred)
        return true
      }),
  }),
)

const twoTasks = [
  { title: "First", prompt: "do the first thing" },
  { title: "Second", prompt: "do the second thing" },
] as const

/** Polls until the queue has a running task with its session, then returns that session ID. */
async function waitForTaskSession(api: Api, queueID: string, generation = 1) {
  const deadline = Date.now() + 5_000
  while (true) {
    const info = await api.experimental.taskQueue.get({ queueID })
    const running = info.tasks.find((task) => task.status === "running" && task.sessionID)
    if (running?.sessionID && executionState.resumes.filter((id) => id === running.sessionID).length >= generation)
      return running.sessionID
    if (Date.now() > deadline) throw new Error(`task never started running: ${JSON.stringify(info)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const bootDirs = (dirs: ReadonlyArray<{ readonly name: string; readonly flag: boolean }>, rootFlag?: boolean) =>
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
        config: { directory: root, project: true, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      },
      { overrides: [SessionExecution.node.replace(execution)] },
    )
    return client(handler)
  })

it.live("runs the task-queue lifecycle through the experimental API", () =>
  Effect.gen(function* () {
    executionState.resumes = []
    executionState.interrupts = []
    executionState.hanging = undefined
    const root = (yield* tmpdirScoped("opencode-task-queue-api-")).path
    const api = yield* bootDirs([{ name: "enabled", flag: true }])(root)
    const controller = new AbortController()
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))

    yield* Effect.promise(async () => {
      const events = api.event
        .subscribe({ types: ["taskqueue.updated"], signal: controller.signal })
        [Symbol.asyncIterator]()
      expect((await events.next()).value?.type).toBe("server.connected")
      const nextQueue = async (status: "queued" | "running" | "stopped") => {
        while (true) {
          const event = await events.next()
          if (event.done) throw new Error("queue event stream ended early")
          if (event.value.type === "taskqueue.updated" && event.value.data.status === status) return event.value.data
        }
      }
      const created = await api.experimental.taskQueue.create({
        directory: path.join(root, "enabled"),
        title: "Release",
        tasks: twoTasks,
      })
      expect(await nextQueue("queued")).toEqual(created)
      expect(created).toMatchObject({
        title: "Release",
        directory: path.join(root, "enabled"),
        status: "queued",
        tasks: [
          { title: "First", status: "pending", position: 1 },
          { title: "Second", status: "pending", position: 2 },
        ],
      })
      expect(await api.experimental.taskQueue.list({ directory: path.join(root, "enabled") })).toMatchObject([
        { id: created.id, status: "queued" },
      ])
      expect(await api.experimental.taskQueue.get({ queueID: created.id })).toMatchObject({ id: created.id })

      // A queued queue refuses the running-only routes.
      await expect(api.experimental.taskQueue.heartbeat({ queueID: created.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })
      await expect(api.experimental.taskQueue.resume({ queueID: created.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })

      // Start makes it running; a second start is refused, a heartbeat renews.
      expect(await api.experimental.taskQueue.start({ queueID: created.id })).toMatchObject({ status: "running" })
      await expect(api.experimental.taskQueue.start({ queueID: created.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })
      expect(await api.experimental.taskQueue.heartbeat({ queueID: created.id })).toMatchObject({ status: "running" })

      // The first task hangs mid-run; a running queue cannot be removed.
      const first = await waitForTaskSession(api, created.id)
      await expect(api.experimental.taskQueue.delete({ queueID: created.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })

      // Stop records its reason, interrupts the current task, keeps the pending task, and is idempotent.
      const stopped = await api.experimental.taskQueue.stop({ queueID: created.id, reason: "the TUI exited" })
      expect(await nextQueue("stopped")).toEqual(stopped)
      expect(stopped).toMatchObject({ status: "stopped", reason: "the TUI exited" })
      expect(stopped.tasks[0]).toMatchObject({ status: "interrupted", sessionID: first })
      expect(stopped.tasks[1]).toMatchObject({ status: "pending" })
      expect(await api.experimental.taskQueue.stop({ queueID: created.id })).toMatchObject({ status: "stopped" })

      // Resume continues the interrupted task in its own session, not a new one.
      expect(await api.experimental.taskQueue.resume({ queueID: created.id })).toMatchObject({ status: "running" })
      expect(await waitForTaskSession(api, created.id, 2)).toBe(first)
      expect(await api.experimental.taskQueue.stop({ queueID: created.id })).toMatchObject({ status: "stopped" })

      // A stopped queue can be removed and then reads as gone.
      await api.experimental.taskQueue.delete({ queueID: created.id })
      await expect(api.experimental.taskQueue.get({ queueID: created.id })).rejects.toMatchObject({
        _tag: "TaskQueueNotFoundError",
      })

      // Every execution the scheduler drove belonged to the first task's session.
      expect(executionState.resumes.length).toBeGreaterThanOrEqual(2)
      expect(executionState.resumes.every((id) => id === first)).toBe(true)
      expect(executionState.interrupts.map(() => first)).toEqual([first, first])
      await events.return?.()
    })
  }).pipe(Effect.scoped),
)

it.live("gates every task-queue route on experimental.task_queue and reports missing queues", () =>
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
      const created = await api.experimental.taskQueue.create({
        directory: path.join(root, "enabled"),
        tasks: [{ title: "Only", prompt: "the one task" }],
      })
      expect(created.status).toBe("queued")

      // Off where the queue would run: nothing can be created or listed there.
      await expect(
        api.experimental.taskQueue.create({
          directory: path.join(root, "disabled"),
          tasks: [{ title: "Nope", prompt: "never runs" }],
        }),
      ).rejects.toMatchObject({ _tag: "ForbiddenError" })
      await expect(api.experimental.taskQueue.list({ directory: path.join(root, "disabled") })).rejects.toMatchObject({
        _tag: "ForbiddenError",
      })
      // Listing another directory does not leak the queue into it.
      expect(await api.experimental.taskQueue.list({ directory: root })).toEqual([])

      // Unknown queues read as 404 on every route.
      for (const call of [
        () => api.experimental.taskQueue.get({ queueID: "tq_none" }),
        () => api.experimental.taskQueue.start({ queueID: "tq_none" }),
        () => api.experimental.taskQueue.heartbeat({ queueID: "tq_none" }),
        () => api.experimental.taskQueue.stop({ queueID: "tq_none" }),
        () => api.experimental.taskQueue.resume({ queueID: "tq_none" }),
        () => api.experimental.taskQueue.delete({ queueID: "tq_none" }),
      ]) {
        await expect(call()).rejects.toMatchObject({ _tag: "TaskQueueNotFoundError" })
      }
    })
  }).pipe(Effect.scoped),
)

// TC-016: checking only unknown IDs cannot prove the ID-based routes enforce the flag.
it.live("forbids all eight task-queue methods when an existing queue's directory disables the flag", () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("qf-")).path
    const created = yield* Effect.scoped(
      Effect.gen(function* () {
        const api = yield* bootDirs([{ name: "project", flag: true }])(root)
        return yield* Effect.promise(() =>
          api.experimental.taskQueue.create({ directory: path.join(root, "project"), tasks: twoTasks }),
        )
      }),
    )
    const api = yield* bootDirs([{ name: "project", flag: false }], true)(root)
    yield* Effect.promise(async () => {
      const queueID = created.id
      for (const call of [
        () => api.experimental.taskQueue.create({ directory: created.directory, tasks: twoTasks }),
        () => api.experimental.taskQueue.list({ directory: created.directory }),
        () => api.experimental.taskQueue.get({ queueID }),
        () => api.experimental.taskQueue.start({ queueID }),
        () => api.experimental.taskQueue.heartbeat({ queueID }),
        () => api.experimental.taskQueue.stop({ queueID }),
        () => api.experimental.taskQueue.resume({ queueID }),
        () => api.experimental.taskQueue.delete({ queueID }),
      ])
        await expect(call()).rejects.toMatchObject({ _tag: "ForbiddenError" })
      expect(executionState.hanging).toBeUndefined()
    })
  }).pipe(Effect.scoped),
)

// TC-026/029: use an actual Windows junction (directory symlink on other hosts),
// not a manually lowercased string standing in for server-side filesystem identity.
it.live("canonicalizes junction create/list and prevents alias and case variants from running a second batch", () =>
  Effect.gen(function* () {
    executionState.resumes = []
    executionState.interrupts = []
    executionState.hanging = undefined
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
      const first = await api.experimental.taskQueue.create({ directory: alias, tasks: twoTasks })
      expect(first.directory).toBe(real)
      const variants = [directory, alias, process.platform === "win32" ? alias.toUpperCase() : path.join(alias, ".")]
      for (const value of variants) {
        expect(await api.experimental.taskQueue.list({ directory: value })).toMatchObject([
          { id: first.id, directory: real },
        ])
      }
      const second = await api.experimental.taskQueue.create({ directory, tasks: twoTasks })
      await api.experimental.taskQueue.start({ queueID: first.id })
      await waitForTaskSession(api, first.id)
      await expect(api.experimental.taskQueue.start({ queueID: second.id })).rejects.toMatchObject({
        _tag: "InvalidRequestError",
      })
      expect((await api.experimental.taskQueue.get({ queueID: first.id })).directory).toBe(real)
      await api.experimental.taskQueue.stop({ queueID: first.id })
      await api.experimental.taskQueue.delete({ queueID: first.id })
      expect(await api.experimental.taskQueue.list({ directory: alias })).toMatchObject([
        { id: second.id, status: "queued" },
      ])
      await api.experimental.taskQueue.delete({ queueID: second.id })
      expect(await api.experimental.taskQueue.list({ directory })).toEqual([])
    })
  }).pipe(Effect.scoped),
)

// R-CORE-01: discovery follows lexical parents, so the alias and target must live under
// opposite configs. The earlier same-parent junction case only proves directory locking.
for (const enabled of [false, true]) {
  it.live(`uses only the canonical target flag when a cross-parent junction target is ${enabled ? "enabled" : "disabled"}`, () =>
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
        if (!enabled) {
          // Collect both outcomes before asserting: even a create-then-403 implementation must
          // fail the direct DB checks, and a forbidden target must not be readable via its alias.
          const created = await api.experimental.taskQueue.create({ directory: alias, tasks: twoTasks }).then(
            (data) => ({ data }),
            (error: unknown) => error,
          )
          const listed = await api.experimental.taskQueue.list({ directory: alias }).then(
            (data) => ({ data }),
            (error: unknown) => error,
          )
          expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM task_queue").get()?.count).toBe(0)
          expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM task_queue_task").get()?.count).toBe(0)
          expect(created).toMatchObject({ _tag: "ForbiddenError" })
          expect(listed).toMatchObject({ _tag: "ForbiddenError" })
          await expect(api.experimental.taskQueue.list({ directory })).rejects.toMatchObject({ _tag: "ForbiddenError" })
          return
        }

        // DEC-021 is target-only, not a dual alias-and-target gate: the off alias is allowed.
        const created = await api.experimental.taskQueue.create({ directory: alias, tasks: twoTasks })
        expect(created.directory).toBe(await fs.realpath(directory))
        for (const value of [alias, directory])
          expect(await api.experimental.taskQueue.list({ directory: value })).toEqual([created])
        expect(await api.experimental.taskQueue.get({ queueID: created.id })).toEqual(created)
        expect(await api.experimental.taskQueue.stop({ queueID: created.id })).toEqual(created)
        await api.experimental.taskQueue.delete({ queueID: created.id })
        await expect(api.experimental.taskQueue.get({ queueID: created.id })).rejects.toMatchObject({ _tag: "TaskQueueNotFoundError" })
        expect(await api.experimental.taskQueue.list({ directory: alias })).toEqual([])
        expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM task_queue").get()?.count).toBe(0)
        expect(database.query<{ count: number }, []>("SELECT count(*) AS count FROM task_queue_task").get()?.count).toBe(0)
      })
    }).pipe(Effect.scoped),
  )
}

it.live("keeps missing task-queue directories and malformed inputs as declared API errors", () =>
  Effect.gen(function* () {
    const root = (yield* tmpdirScoped("qe-")).path
    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: path.join(root, "opencode.db") },
      config: { directory: root, project: true, claude: false, content: JSON.stringify({ experimental: { task_queue: true } }) },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const api = client(handler)
    yield* Effect.promise(async () => {
      for (const directory of [path.join(root, "missing"), path.join(root, "opencode.db", "child"), path.join(root, "invalid\u0000directory")]) {
        const missing = { _tag: "LocationNotFoundError", location: { directory }, message: `Location not found: ${directory}` }
        await expect(api.experimental.taskQueue.create({ directory, tasks: twoTasks })).rejects.toMatchObject(missing)
        await expect(api.experimental.taskQueue.list({ directory })).rejects.toMatchObject(missing)
      }
      const requests = [
        new Request("http://opencode.local/api/experimental/task-queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: 123, tasks: twoTasks }),
        }),
        new Request("http://opencode.local/api/experimental/task-queue", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: root, tasks: [] }),
        }),
        new Request("http://opencode.local/api/experimental/task-queue"),
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
    yield* Effect.promise(() =>
      Bun.write(path.join(root, "opencode.json"), JSON.stringify({ experimental: { task_queue: true } })),
    )
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
    const api = client(handler)
    yield* Effect.promise(async () => {
      const queue = await api.experimental.taskQueue.create({
        directory: root,
        tasks: [{ title: "Owned", prompt: "work" }],
      })
      await api.experimental.taskQueue.start({ queueID: queue.id })
      const deadline = Date.now() + 5_000
      const done = await (async () => {
        while (true) {
          const info = await api.experimental.taskQueue.get({ queueID: queue.id })
          if (info.status === "done") return info
          if (Date.now() >= deadline) throw new Error(`queue did not finish: ${JSON.stringify(info)}`)
          await Bun.sleep(1)
        }
      })()
      const sessionID = done.tasks[0]?.sessionID
      if (!sessionID) throw new Error("task has no Session")
      expect(drains).toEqual([sessionID])
      await api.experimental.taskQueue.delete({ queueID: queue.id })
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
