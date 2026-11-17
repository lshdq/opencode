import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { createTaskQueueOwner } from "../src/util/task-queue-owner"
import { taskQueue } from "./fixture/task-queue"
import { json } from "./fixture/tui-client"

// TC-035: URL identity is a local policy, independent of SDK resource identity.
test.each([
  ["path", "http://fixture.invalid/a/", "http://fixture.invalid/b/"],
  ["query", "http://fixture.invalid/?tenant=a", "http://fixture.invalid/?tenant=b"],
])("different %s endpoints do not share pending ownership", async (_, addressA, addressB) => {
  const a = source(addressA)
  const b = source(addressB)
  let current = a
  const owner = createTaskQueueOwner(() => current.api.experimental.taskQueue, () => () => {}, () => current.address)
  const pa = owner.acquire("tq_fixture", "start")
  current = b
  const pb = owner.acquire("tq_fixture", "resume")
  try {
    expect(pb).not.toBe(pa)
    expect(a.controls).toEqual(["start"])
    expect(b.controls).toEqual(["resume"])
    a.complete()
    b.complete()
    await Promise.all([pa, pb])
    await owner.shutdown()
    expect(a.controls).toEqual(["start", "stop"])
    expect(b.controls).toEqual(["resume", "stop"])
  } finally {
    a.complete(); b.complete()
    await Promise.allSettled([pa, pb])
    await owner.shutdown()
  }
})

test("canonical host, default port and fragment changes retain pending work with the refreshed SDK", async () => {
  const a = source("http://LOCALHOST:80/#old")
  const b = source("http://localhost/#new")
  let current = a
  const owner = createTaskQueueOwner(() => current.api.experimental.taskQueue, () => () => {}, () => current.address)
  const pending = owner.acquire("tq_fixture", "start")
  try {
    current = b
    expect(owner.acquire("tq_fixture", "resume")).toBe(pending)
    a.complete()
    await pending
    expect(owner.owns("tq_fixture")).toBe(true)
    await owner.shutdown()
    expect(a.controls).toEqual(["start"])
    expect(b.controls).toEqual(["stop"])
  } finally {
    a.complete(); b.complete()
    await pending
    await owner.shutdown()
  }
})

test.each(["start", "resume"] as const)("without a URL, exact resource identity deduplicates %s but replacement SDKs stay independent", async (action) => {
  const a = source("http://fixture.invalid/")
  const b = source(a.address)
  let current = a
  const timers = new Set<() => void>()
  const owner = createTaskQueueOwner(() => current.api.experimental.taskQueue, (tick) => {
    timers.add(tick)
    return () => { timers.delete(tick) }
  })
  const pa = owner.acquire("tq_fixture", action)
  expect(owner.acquire("tq_fixture", action)).toBe(pa)
  current = b
  const pb = owner.acquire("tq_fixture", action)
  try {
    expect(pb).not.toBe(pa)
    a.complete(); b.complete()
    await Promise.all([pa, pb])
    expect(timers.size).toBe(1)
    await owner.shutdown()
    expect(a.controls).toEqual([action, "stop"])
    expect(b.controls).toEqual([action, "stop"])
    expect(timers.size).toBe(0)
  } finally {
    a.complete(); b.complete()
    await Promise.allSettled([pa, pb])
    await owner.shutdown()
  }
})

test("failed and terminal source groups leave no old end facts or renewal timer for later explicit work", async () => {
  const timers = new Set<() => void>()
  let current = source("http://fixture.invalid/0")
  const owner = createTaskQueueOwner(() => current.api.experimental.taskQueue, (tick) => {
    timers.add(tick)
    return () => { timers.delete(tick) }
  }, () => current.address)
  try {
    for (let index = 0; index < 32; index++) {
      current = source(`http://fixture.invalid/${index}`)
      const pending = owner.acquire("tq_fixture", "start")
      owner.observe(taskQueue({ status: "done", time: { created: 1, updated: 999 } }))
      current.complete(false)
      await expect(pending).rejects.toBeDefined()
      expect(timers.size).toBe(0)
      // A new action at the same address is not disqualified by the failed one.
      current = source(current.address)
      const retry = owner.acquire("tq_fixture", "resume")
      current.complete()
      await retry
      expect(owner.owns("tq_fixture")).toBe(true)
      expect(timers.size).toBe(1)
      owner.observe(taskQueue({ status: "done", time: { created: 1, updated: 3 } }))
      expect(timers.size).toBe(0)
      expect(owner.owns("tq_fixture")).toBe(false)
      expect(current.controls).toEqual(["resume"])
    }
    await owner.shutdown()
    expect(timers.size).toBe(0)
  } finally { await owner.shutdown() }
})

function source(address: string) {
  const controls: string[] = []
  const reply = Promise.withResolvers<Response>()
  async function request(input: RequestInfo | URL) {
    const method = new URL(input instanceof Request ? input.url : input.toString()).pathname.split("/").at(-1)!
    controls.push(method)
    if (method === "start" || method === "resume") return reply.promise
    return json({ data: taskQueue({ status: method === "stop" ? "stopped" : "running" }) })
  }
  request.preconnect = () => {}
  const api = OpenCode.make({ baseUrl: address, fetch: request })
  return {
    address, api, controls,
    complete(success = true) { reply.resolve(success ? json({ data: taskQueue({ status: "running", time: { created: 1, updated: 2 } }) }) : new Response(null, { status: 503 })) },
  }
}
