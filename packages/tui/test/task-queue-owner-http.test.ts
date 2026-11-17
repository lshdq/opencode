import { expect, test } from "bun:test"
import { OpenCode, type TaskQueueInfo } from "@opencode/client"
import { createTaskQueueOwner } from "../src/util/task-queue-owner"
import { taskQueue } from "./fixture/task-queue"
import { createEventStream, json } from "./fixture/tui-client"

test.each([
  ["start/active", "start", false], ["resume/active", "resume", false],
  ["start/shutdown", "start", true], ["resume/shutdown", "resume", true],
] as const)("two HTTP owners never transfer B's resumed run to A's delayed %s response", async (_, action, closing) => {
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const renewed = Promise.withResolvers<void>()
  const events = createEventStream()
  let info = taskQueue({ status: action === "start" ? "queued" : "stopped" })
  const stops: { actor: string; updated: number }[] = []
  const beats: string[] = []
  const publish = (status: TaskQueueInfo["status"]) => {
    info = { ...info, status, time: { created: 1, updated: info.time.updated + 1 } }
    events.emit({ id: `evt_${info.time.updated}`, type: "taskqueue.updated", created: info.time.updated, data: info })
    return info
  }
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const actor = request.headers.get("x-test-owner") ?? "unknown"
    if (path === "/api/event") return events.v2()
    if (path.endsWith("/start") || path.endsWith("/resume")) {
      const started = publish("running")
      if (actor === "A") { requested.resolve(); return response.promise }
      return json({ data: started })
    }
    if (path.endsWith("/stop")) {
      stops.push({ actor, updated: info.time.updated })
      return json({ data: publish("stopped") })
    }
    if (path.endsWith("/heartbeat")) {
      beats.push(actor)
      renewed.resolve()
      return json({ data: info })
    }
    return new Response(null, { status: 404 })
  } })
  const a = OpenCode.make({ baseUrl: server.url.toString(), headers: { "x-test-owner": "A" } })
  const b = OpenCode.make({ baseUrl: server.url.toString(), headers: { "x-test-owner": "B" } })
  const timersA = new Set<() => void>()
  const timersB = new Set<() => void>()
  const ownerA = createTaskQueueOwner(() => a.experimental.taskQueue, (tick) => { timersA.add(tick); return () => { timersA.delete(tick) } })
  const ownerB = createTaskQueueOwner(() => b.experimental.taskQueue, (tick) => { timersB.add(tick); return () => { timersB.delete(tick) } })
  const signal = new AbortController()
  const stream = a.event.subscribe({ signal: signal.signal })[Symbol.asyncIterator]()
  let starting: Promise<TaskQueueInfo> | undefined
  let shutdown: Promise<void> | undefined
  try {
    expect((await stream.next()).value?.type).toBe("server.connected")
    starting = ownerA.acquire(info.id, action)
    await requested.promise
    const first = info
    const observe = async (status: TaskQueueInfo["status"], updated: number) => {
      const event = (await stream.next()).value
      if (event?.type !== "taskqueue.updated") throw new Error("Expected real taskqueue SSE")
      expect(event.data.status).toBe(status)
      expect(event.data.time.updated).toBe(updated)
      ownerA.observe(event.data)
      ownerB.observe(event.data)
    }
    await observe("running", 2)
    await b.experimental.taskQueue.stop({ queueID: info.id, reason: "B stops A before resuming" })
    await observe("stopped", 3)
    await ownerB.acquire(info.id, "resume")
    await observe("running", 4)
    expect(ownerB.owns(info.id)).toBe(true)
    if (closing) shutdown = ownerA.shutdown()
    response.resolve(json({ data: first }))
    const visible = await starting
    expect(visible.time.updated).toBe(4)
    expect(ownerA.owns(info.id)).toBe(false)
    expect(timersA.size).toBe(0)
    expect(timersB.size).toBe(1)
    timersA.forEach((tick) => tick())
    timersB.forEach((tick) => tick())
    await renewed.promise
    expect(beats).toEqual(["B"])
    await (shutdown ?? ownerA.shutdown())
    expect(stops).toEqual([{ actor: "B", updated: 2 }])
    expect(info.status).toBe("running")
    expect(ownerB.owns(info.id)).toBe(true)
    await ownerB.shutdown()
    expect(stops).toEqual([{ actor: "B", updated: 2 }, { actor: "B", updated: 4 }])
  } finally {
    response.resolve(json({ data: info }))
    await starting?.catch(() => undefined)
    await Promise.all([ownerA.shutdown(), ownerB.shutdown()])
    signal.abort()
    await stream.return?.()
    events.disconnect()
    await server.stop(true)
  }
})
