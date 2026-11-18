import { expect, test } from "bun:test"
import { OpenCode, type TaskQueueInfo } from "@opencode/client"
import { canResumeTaskQueue, createTaskQueueFeed, sameTaskDirectory, taskQueueCounts, taskQueueError } from "../../src/feature-plugins/system/tasks-data"
import { taskQueue } from "../fixture/task-queue"
import { createFetch, json } from "../fixture/tui-client"

type Api = ReturnType<Parameters<typeof createTaskQueueFeed>[0]>

test("directory matching respects Windows paths but not POSIX case folding", () => {
  expect(sameTaskDirectory("D:\\Project\\", "d:/project")).toBe(true)
  expect(sameTaskDirectory("\\\\host\\share\\project", "//HOST/share/PROJECT/")).toBe(true)
  expect(sameTaskDirectory("/Project", "/project")).toBe(false)
})

test("Windows drive roots compare case-insensitively after slash normalization", () => {
  expect(sameTaskDirectory("D:\\", "d:/")).toBe(true)
  expect(sameTaskDirectory("d:/", "D:\\")).toBe(true)
})

test("stale list/get replies cannot overwrite events, deletion or another directory", async () => {
  const old = Promise.withResolvers<TaskQueueInfo[]>()
  const current = Promise.withResolvers<TaskQueueInfo[]>()
  const detail = Promise.withResolvers<TaskQueueInfo>()
  const api: Api = {
    list: ({ directory }) => directory === "D:\\old" ? old.promise : current.promise,
    get: () => detail.promise,
  }
  const feed = createTaskQueueFeed(() => api)
  feed.directory("D:\\old")
  feed.directory("D:\\project")
  const latest = taskQueue({ status: "running", time: { created: 1, updated: 10 } })
  feed.update(latest)
  feed.update(taskQueue({ id: "tq_secret", directory: "D:\\other" }))
  old.resolve([taskQueue({ directory: "D:\\old", title: "Wrong location" })])
  current.resolve([taskQueue()])
  await current.promise; await Promise.resolve()
  expect(feed.items()).toEqual([latest])
  const getting = feed.get(latest.id)
  feed.update({ ...latest, status: "done", time: { created: 1, updated: 11 } })
  detail.resolve(latest)
  await getting
  expect(feed.items()[0].status).toBe("done")
  const loading = feed.load()
  feed.remove(latest.id)
  await loading
  expect(feed.items()).toEqual([])
  feed.dispose()
})

test("done is not all-success, and failed/blocked work can be resumed explicitly", () => {
  const info = taskQueue()
  const tasks = (["completed", "failed", "blocked", "pending", "interrupted", "cancelled"] as const).map((status, index) => ({
    ...info.tasks[0], id: String(index), status,
  }))
  expect(taskQueueCounts(tasks)).toBe("完成 1 · 失败 1 · 阻塞 1 · 待执行 1 · 中断 1 · 跳过 1")
  expect(canResumeTaskQueue(taskQueue({ status: "done", tasks }))).toBe(true)
  expect(canResumeTaskQueue(taskQueue({ status: "done", tasks: [{ ...info.tasks[0], status: "completed" }] }))).toBe(false)
  expect(canResumeTaskQueue(taskQueue({ status: "running" }))).toBe(false)
})

test("a real generated client's Forbidden response has an actionable disabled message", async () => {
  const calls = createFetch(() => json({ _tag: "ForbiddenError", message: "disabled" }, { status: 403 }))
  const client = OpenCode.make({ baseUrl: "http://fixture", fetch: calls.fetch })
  const feed = createTaskQueueFeed(() => client.taskQueue)
  feed.directory("D:\\project")
  await feed.load()
  expect(feed.error()).toContain("检查访问权限")
  expect(taskQueueError(new Error("offline"))).toContain("offline")
  feed.dispose()
})

test("a delayed pre-deletion event cannot resurrect a removed queue", async () => {
  const info = taskQueue({ status: "stopped", time: { created: 1, updated: 10 } })
  const api = { list: async () => [info], get: async () => info }
  const feed = createTaskQueueFeed(() => api)
  try {
    feed.directory(info.directory)
    await feed.load()
    expect(feed.items()).toEqual([info])
    feed.remove(info.id)
    feed.update({ ...info, status: "running", time: { created: 1, updated: 9 } })
    expect(feed.items()).toEqual([])
  } finally {
    feed.dispose()
  }
})

test("refresh responses never replace a newer known event with an older snapshot", async () => {
  const latest = taskQueue({ status: "done", time: { created: 1, updated: 10 } })
  const stale = { ...latest, status: "running" as const, time: { created: 1, updated: 9 } }
  const api = { list: async () => [stale], get: async () => stale }
  const feed = createTaskQueueFeed(() => api)
  try {
    feed.directory(latest.directory)
    await feed.load()
    feed.update(latest)
    await feed.load()
    expect(feed.items()).toEqual([latest])
  } finally {
    feed.dispose()
  }
})

test("late detail results and errors from the previous directory do not leak", async () => {
  const info = taskQueue()
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const failure = Promise.withResolvers<TaskQueueInfo>()
  const api: Api = {
    list: async () => [],
    get: ({ queueID }) => queueID === info.id ? reply.promise : failure.promise,
  }
  const feed = createTaskQueueFeed(() => api)
  try {
    feed.directory(info.directory)
    const detail = feed.get(info.id)
    const rejected = feed.get("tq_old_failure")
    feed.directory("/remote/another-directory")
    reply.resolve(info)
    failure.reject(new Error("old directory offline"))
    await Promise.all([detail, rejected])
    expect(feed.items()).toEqual([])
    expect(feed.error()).toBeUndefined()
  } finally {
    feed.dispose()
  }
})

test("confirmed deletion also rejects subsequent list/get responses without hiding other queues", async () => {
  const removed = taskQueue({ status: "stopped", time: { created: 1, updated: 10 } })
  const retained = taskQueue({ id: "tq_retained", title: "Still visible" })
  const api = { list: async () => [removed, retained], get: async () => removed }
  const feed = createTaskQueueFeed(() => api)
  try {
    feed.directory(removed.directory)
    await feed.load()
    expect(feed.items()).toEqual([removed, retained])
    feed.remove(removed.id)
    feed.update({ ...removed, status: "running", time: { created: 1, updated: 9 } })
    await feed.load()
    expect(feed.items()).toEqual([retained])
    await feed.get(removed.id)
    expect(feed.items()).toEqual([retained])
    expect(feed.error()).toBeUndefined()
  } finally {
    feed.dispose()
  }
})

test("directory changes clear deletion facts but reject detail replies from the previous lifetime", async () => {
  const info = taskQueue({ status: "stopped" })
  const other = taskQueue({ id: "tq_other", directory: "/remote/other" })
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const api: Api = {
    list: async ({ directory }) => directory === info.directory ? [info] : [other],
    get: () => reply.promise,
  }
  const feed = createTaskQueueFeed(() => api)
  try {
    feed.directory(info.directory)
    await feed.load()
    feed.remove(info.id)
    const previous = feed.get(info.id)
    feed.directory(other.directory)
    await feed.load()
    expect(feed.items()).toEqual([other])
    feed.directory(info.directory)
    await feed.load()
    // A new directory lifetime reads its source afresh; this is not server-side undelete.
    expect(feed.items()).toEqual([info])
    reply.resolve({ ...info, status: "running", time: { created: 1, updated: 99 } })
    await previous
    expect(feed.items()).toEqual([info])
    expect(feed.error()).toBeUndefined()
  } finally {
    reply.resolve(info)
    feed.dispose()
  }
})

test("only the current scoped list confirms a remote alias, not SSE or unrelated get", async () => {
  const info = taskQueue({ directory: "/server/real", title: "Canonical batch" })
  const superseded = Promise.withResolvers<TaskQueueInfo[]>()
  const response = Promise.withResolvers<TaskQueueInfo[]>()
  let requests = 0
  const api = { list: () => ++requests === 1 ? superseded.promise : response.promise, get: async () => info }
  const feed = createTaskQueueFeed(() => api)
  try {
    feed.directory("/server/alias")
    feed.update(info)
    await feed.get(info.id)
    expect(feed.items()).toEqual([])
    const loaded = feed.load()
    response.resolve([info])
    await loaded
    expect(feed.items()).toEqual([info])
    const running = { ...info, status: "running" as const, time: { created: 1, updated: 2 } }
    feed.update(running)
    feed.update(taskQueue({ id: "tq_unrelated", directory: "/server/unrelated" }))
    expect(feed.items()).toEqual([running])
    const stale = taskQueue({ id: "tq_superseded", directory: "/server/superseded" })
    superseded.resolve([stale])
    await superseded.promise
    feed.update(stale)
    expect(feed.items()).toEqual([running])
  } finally {
    superseded.resolve([])
    response.resolve([])
    feed.dispose()
  }
})

test("an empty alias list can be confirmed by create, but late scoped responses cannot grant a new directory identity", async () => {
  const info = taskQueue({ directory: "/server/real" })
  const list = Promise.withResolvers<TaskQueueInfo[]>()
  const create = Promise.withResolvers<TaskQueueInfo>()
  const api: Api = {
    list: ({ directory }) => directory === "/server/alias" ? list.promise : Promise.resolve([]),
    get: async () => info,
  }
  const feed = createTaskQueueFeed(() => api)
  try {
    feed.directory("/server/alias")
    const loading = feed.load()
    const created = feed.created(create.promise)
    feed.directory("/server/other-alias")
    await feed.load()
    list.resolve([info])
    create.resolve(info)
    await loading
    expect(await created).toBeUndefined()
    feed.update(info)
    expect(feed.items()).toEqual([])
    // The current directory's empty list did not resolve this alias. Its own successful create does.
    const fresh = await feed.created(Promise.resolve(info))
    expect(fresh).toEqual(info)
    expect(feed.items()).toEqual([info])
    await feed.get(info.id)
    expect(feed.items()).toEqual([info])
    feed.directory("/server/unconfirmed")
    await feed.load()
    feed.update(info)
    expect(feed.items()).toEqual([])
    const late = Promise.withResolvers<TaskQueueInfo>()
    const disposed = feed.created(late.promise)
    feed.dispose()
    late.resolve(info)
    expect(await disposed).toBeUndefined()
    feed.update(info)
    expect(feed.items()).toEqual([])
  } finally {
    list.resolve([])
    create.resolve(info)
    feed.dispose()
  }
})

test("mixed directory list responses do not learn an unrelated canonical identity", async () => {
  const local = taskQueue({ directory: "/server/alias" })
  const other = taskQueue({ id: "tq_other_scope", directory: "/server/other" })
  const api = { list: async () => [local, other], get: async () => other }
  const feed = createTaskQueueFeed(() => api)
  try {
    feed.directory(local.directory)
    await feed.load()
    feed.update(other)
    expect(feed.items()).toEqual([local])
  } finally {
    feed.dispose()
  }
})
