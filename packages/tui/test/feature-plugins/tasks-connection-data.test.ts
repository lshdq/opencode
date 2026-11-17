import { expect, test } from "bun:test"
import { OpenCode, type TaskQueueInfo } from "@opencode/client"
import { createTaskQueueFeed } from "../../src/feature-plugins/system/tasks-data"
import { taskQueue } from "../fixture/task-queue"
import { createFetch, json } from "../fixture/tui-client"

test.each([
  ["list/success", "list", true], ["list/failure", "list", false],
  ["create/success", "create", true], ["create/failure", "create", false],
] as const)("connection identity invalidates an obsolete %s without migrating its request", async (_, operation, success) => {
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const initialized = Promise.withResolvers<void>()
  const old = taskQueue({ title: "Obsolete response" })
  const replacement = taskQueue({ id: "tq_current", title: "Current connection" })
  let hold = false
  let reads = 0
  const a = Bun.serve({ port: 0, fetch(request) {
    if (!hold && ++reads === 2) initialized.resolve()
    if (hold && ((operation === "list" && request.method === "GET") || request.method === "POST")) {
      requested.resolve()
      return response.promise
    }
    return json({ data: [old] })
  } })
  const b = Bun.serve({ port: 0, fetch: () => json({ data: [replacement] }) })
  let client = OpenCode.make({ baseUrl: a.url.toString() })
  const feed = createTaskQueueFeed(() => client.experimental.taskQueue)
  let pending: Promise<void | TaskQueueInfo> | undefined
  try {
    feed.directory(old.directory)
    await feed.load()
    // directory() also starts a read: both initial HTTP handlers must arrive
    // before the one deliberately delayed list request is armed.
    await initialized.promise
    hold = true
    pending = operation === "list" ? feed.load() : feed.created(client.experimental.taskQueue.create({ directory: old.directory, tasks: [{ title: "Old submitted task", prompt: "Text" }] }))
    await requested.promise
    client = OpenCode.make({ baseUrl: b.url.toString() })
    await feed.load()
    expect(feed.items()).toEqual([replacement])
    response.resolve(success ? json({ data: operation === "list" ? [old] : old }) : new Response(null, { status: 503 }))
    expect(await pending).toBeUndefined()
    expect(feed.items()).toEqual([replacement])
    expect(feed.error()).toBeUndefined()
    expect(feed.loading()).toBe(false)
  } finally {
    response.resolve(json({ data: operation === "list" ? [old] : old }))
    await pending
    feed.dispose()
    await Promise.all([a.stop(true), b.stop(true)])
  }
})

test("canonical and deletion facts belong to one connection, including empty replacement lists", async () => {
  const old = taskQueue({ directory: "/remote/old-real" })
  const replacement = taskQueue({ directory: "/remote/new-real", title: "Same ID, independent server" })
  const a = Bun.serve({ port: 0, fetch: () => json({ data: [old] }) })
  const b = Bun.serve({ port: 0, fetch: (request) => json({ data: request.method === "POST" ? replacement : [] }) })
  let client = OpenCode.make({ baseUrl: a.url.toString() })
  const feed = createTaskQueueFeed(() => client.experimental.taskQueue)
  try {
    feed.directory("/remote/alias")
    await feed.load()
    expect(feed.items()).toEqual([old])
    feed.remove(old.id)
    client = OpenCode.make({ baseUrl: b.url.toString() })
    await feed.load()
    feed.update(old)
    expect(feed.items()).toEqual([])
    await feed.created(client.experimental.taskQueue.create({ directory: "/remote/alias", tasks: [{ title: "New server", prompt: "Text" }] }))
    expect(feed.items()).toEqual([replacement])
    expect(feed.error()).toBeUndefined()
  } finally {
    feed.dispose()
    await Promise.all([a.stop(true), b.stop(true)])
  }
})

test("a connection checkpoint is invalid before reload and stays invalid after A to B to A", () => {
  const a = OpenCode.make({ baseUrl: "http://unused-a" })
  const b = OpenCode.make({ baseUrl: "http://unused-b" })
  let client = a
  const feed = createTaskQueueFeed(() => client.experimental.taskQueue)
  try {
    const first = feed.capture()
    expect(first()).toBe(true)
    client = b
    expect(first()).toBe(false)
    const second = feed.capture()
    client = a
    expect(second()).toBe(false)
    expect(first()).toBe(false)
    expect(feed.connection()).toBe(2)
    const last = feed.capture()
    feed.dispose()
    expect(last()).toBe(false)
  } finally {
    feed.dispose()
  }
})

test("refresh on the same SDK preserves a submitted create checkpoint", async () => {
  const response = Promise.withResolvers<TaskQueueInfo>()
  const client = OpenCode.make({ baseUrl: "http://fixture", fetch: createFetch(() => json({ data: [] })).fetch })
  const feed = createTaskQueueFeed(() => client.experimental.taskQueue)
  try {
    feed.directory("/remote/alias")
    const current = feed.capture()
    const pending = feed.created(response.promise)
    await feed.load()
    response.resolve(taskQueue({ directory: "/remote/real" }))
    expect(await pending).toEqual(taskQueue({ directory: "/remote/real" }))
    expect(current()).toBe(true)
    expect(feed.connection()).toBe(0)
    expect(feed.items()).toHaveLength(1)
  } finally {
    response.resolve(taskQueue())
    feed.dispose()
  }
})
