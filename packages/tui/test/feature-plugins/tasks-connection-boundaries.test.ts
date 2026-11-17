import { expect, test } from "bun:test"
import { OpenCode, type TaskQueueInfo } from "@opencode/client"
import { createTaskQueueFeed } from "../../src/feature-plugins/system/tasks-data"
import { taskQueue } from "../fixture/task-queue"
import { createFetch, json } from "../fixture/tui-client"

test.each((["list", "get", "create"] as const).flatMap((operation) => [
  [`${operation}/success`, operation, true] as const, [`${operation}/failure`, operation, false] as const,
]))("a completing obsolete %s checks the live SDK before any replacement request, without swallowing current failures", async (_, operation, success) => {
  // TC-033 / DEC-022: no B load/capture/event is allowed to invalidate A for us.
  // The completion path itself must read the live getter, even at the same URL.
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const old = taskQueue({ title: "Old response before B reload" })
  const replacement = taskQueue({ id: "tq_current_boundary", title: "Current credential scope" })
  let hold = false
  let fail = false
  let newRequests = 0
  const previous = OpenCode.make({ baseUrl: "http://fixture", headers: { "x-test-connection": "A" }, fetch: createFetch(() => {
    if (hold) { requested.resolve(); return response.promise }
    return json({ data: [old] })
  }).fetch })
  const next = OpenCode.make({ baseUrl: "http://fixture", headers: { "x-test-connection": "B" }, fetch: createFetch((_url, request) => {
    expect(request.headers.get("x-test-connection")).toBe("B")
    newRequests++
    return fail ? new Response(null, { status: 503 }) : json({ data: [replacement] })
  }).fetch })
  let client = previous
  const feed = createTaskQueueFeed(() => client.experimental.taskQueue)
  const submit = () => feed.created(client.experimental.taskQueue.create({ directory: old.directory, tasks: [{ title: "Submitted to A", prompt: "Full text" }] }))
  let pending: Promise<void | TaskQueueInfo> | undefined
  try {
    expect(previous.experimental.taskQueue).toBe(previous.experimental.taskQueue)
    expect(next.experimental.taskQueue).not.toBe(previous.experimental.taskQueue)
    feed.directory(old.directory)
    await feed.load()
    hold = true
    pending = operation === "list" ? feed.load() : operation === "get" ? feed.get(old.id) : submit()
    await requested.promise
    client = next
    response.resolve(success ? json({ data: operation === "list" ? [old] : old }) : new Response(null, { status: 503 }))
    expect(await pending).toBeUndefined()
    // These reads do not call sync(). Without response-time checking they fail.
    expect(feed.connection()).toBe(1)
    expect(feed.items()).toEqual([])
    expect(feed.error()).toBeUndefined()
    expect(feed.loading()).toBe(true)
    expect(newRequests).toBe(0)
    await feed.load()
    expect(feed.items()).toEqual([replacement])
    expect(feed.loading()).toBe(false)
    fail = true
    if (operation === "create") await expect(submit()).rejects.toThrow("UnexpectedStatus: 503")
    if (operation !== "create") {
      await (operation === "list" ? feed.load() : feed.get(replacement.id))
      expect(feed.error()).toContain("UnexpectedStatus: 503")
    }
    expect(newRequests).toBe(2)
  } finally {
    response.resolve(json({ data: operation === "list" ? [old] : old }))
    await pending
    feed.dispose()
  }
})
