import { expect, test } from "bun:test"
import { OpenCode, type TaskQueueInfo } from "@opencode/client"
import { createTaskQueueOwner } from "../src/util/task-queue-owner"
import { taskQueue } from "./fixture/task-queue"
import { json } from "./fixture/tui-client"

test.each(["plan", "start", "resume"] as const)("current B cannot intercept A's pending %s heartbeat or exit cleanup", async (action) => {
  await using a = await endpoint("A", true)
  await using b = await endpoint("B", false, "running")
  let current = a
  const ticks = new Set<() => void>()
  const owner = createTaskQueueOwner(() => current.api.taskQueue, (tick) => { ticks.add(tick); return () => { ticks.delete(tick) } }, () => current.url)
  const pending = owner.acquire("tq_fixture", action)
  try {
    await a.requested.promise
    current = b
    owner.observe(b.info())
    a.complete(true)
    await pending
    ticks.forEach((tick) => tick())
    await Promise.race([a.beat.promise, b.beat.promise])
    await owner.shutdown()
    expect({ a: a.controls, b: b.controls, statusB: b.info().status }).toEqual({ a: [action, "heartbeat", "stop"], b: [], statusB: "running" })
    expect(ticks.size).toBe(0)
    expect(a.rejected).toEqual([])
    expect(b.rejected).toEqual([])
  } finally {
    a.complete(true)
    await pending.catch(() => undefined)
    await owner.shutdown()
  }
})

test.each((["plan", "start", "resume"] as const).flatMap((action) => (["A-first", "B-first", "A-fails", "B-fails"] as const).map((order) => [`${action}/${order}`, action, order] as const)))("origin-scoped %s promises, results, observations and finally remain independent", async (_, action, order) => {
  await using a = await endpoint("A", true)
  await using b = await endpoint("B", true)
  let current = a
  const ticks = new Set<() => void>()
  const owner = createTaskQueueOwner(() => current.api.taskQueue, (tick) => { ticks.add(tick); return () => { ticks.delete(tick) } }, () => current.url)
  const pa = owner.acquire("tq_fixture", action)
  const settledA = pa.then((info) => info, () => undefined)
  let pb: Promise<TaskQueueInfo> | undefined
  try {
    await a.requested.promise
    current = b
    pb = owner.acquire("tq_fixture", action)
    const settledB = pb.then((info) => info, () => undefined)
    expect(pb).not.toBe(pa)
    await b.requested.promise
    // B's observed end is not an end of A's operation, even at a newer time.
    if (order === "B-fails") owner.observe(taskQueue({ status: "stopped", time: { created: 1, updated: 150 } }))
    if (order === "B-first" || order === "B-fails") {
      b.complete(order !== "B-fails")
      await settledB
      current = a
      expect(owner.acquire("tq_fixture", action)).toBe(pa)
      a.complete(true)
    }
    if (order !== "B-first" && order !== "B-fails") {
      a.complete(order !== "A-fails")
      await settledA
      expect(owner.acquire("tq_fixture", action)).toBe(pb)
      b.complete(true)
    }
    const resultA = await settledA
    const resultB = await settledB
    expect(resultA?.title).toBe(order === "A-fails" ? undefined : "A source result")
    expect(resultB?.title).toBe(order === "B-fails" ? undefined : "B source result")
    current = a
    expect(owner.owns("tq_fixture")).toBe(order !== "A-fails")
    current = b
    expect(owner.owns("tq_fixture")).toBe(order !== "B-fails")
    ticks.forEach((tick) => tick())
    await Promise.all([...(order === "A-fails" ? [] : [a.beat.promise]), ...(order === "B-fails" ? [] : [b.beat.promise])])
    await owner.shutdown()
    expect(a.controls.filter((control) => control === "heartbeat")).toHaveLength(order === "A-fails" ? 0 : 1)
    expect(b.controls.filter((control) => control === "heartbeat")).toHaveLength(order === "B-fails" ? 0 : 1)
    expect(a.controls.filter((control) => control === "stop")).toHaveLength(order === "A-fails" ? 0 : 1)
    expect(b.controls.filter((control) => control === "stop")).toHaveLength(order === "B-fails" ? 0 : 1)
    expect(ticks.size).toBe(0)
  } finally {
    a.complete(true)
    b.complete(true)
    await Promise.allSettled([pa, ...(pb ? [pb] : [])])
    await owner.shutdown()
  }
})

test.each(["plan", "start", "resume"] as const)("same endpoint SDK and credential refresh keeps an effective %s owner", async (action) => {
  await using source = await endpoint("same", false)
  const ticks = new Set<() => void>()
  const owner = createTaskQueueOwner(() => source.api.taskQueue, (tick) => { ticks.add(tick); return () => { ticks.delete(tick) } }, () => source.url)
  try {
    await owner.acquire("tq_fixture", action)
    source.rotate()
    expect(owner.owns("tq_fixture")).toBe(true)
    ticks.forEach((tick) => tick())
    await source.beat.promise
    await owner.shutdown()
    expect(source.controls).toEqual([action, "heartbeat", "stop"])
    expect(source.credentials).toEqual([1, 2, 2])
    expect(source.rejected).toEqual([])
  } finally { await owner.shutdown() }
})

test("B terminal facts cannot cancel A eligibility, and source-bound renewal replies cannot end B", async () => {
  await using a = await endpoint("A", true)
  await using b = await endpoint("B", true)
  let current = a
  const ticks = new Set<() => void>()
  const owner = createTaskQueueOwner(() => current.api.taskQueue, (tick) => { ticks.add(tick); return () => { ticks.delete(tick) } }, () => current.url)
  const pa = owner.acquire("tq_fixture", "start")
  let pb: Promise<TaskQueueInfo> | undefined
  try {
    await a.requested.promise
    current = b
    pb = owner.acquire("tq_fixture", "start")
    await b.requested.promise
    owner.observe(taskQueue({ status: "done", time: { created: 1, updated: 150 } }))
    b.complete(true)
    await pb
    a.complete(true)
    await pa
    expect(owner.owns("tq_fixture")).toBe(false)
    current = a
    expect(owner.owns("tq_fixture")).toBe(true)
    current = b
    ticks.forEach((tick) => tick())
    await Promise.race([a.beat.promise, b.beat.promise])
    await owner.shutdown()
    expect(a.controls).toEqual(["start", "heartbeat", "stop"])
    expect(b.controls).toEqual(["start"])
  } finally {
    a.complete(true); b.complete(true)
    await Promise.allSettled([pa, ...(pb ? [pb] : [])])
    await owner.shutdown()
  }
})

test.each((["plan", "start", "resume"] as const).flatMap((action) => ([true, false] as const).map((before) => [`${action}/${before ? "pending" : "owned"}`, action, before] as const)))("bound A observations end only A's %s while B has the same queue ID", async (_, action, before) => {
  await using a = await endpoint("A", true)
  await using b = await endpoint("B", true)
  let current = a
  const owner = createTaskQueueOwner(() => current.api.taskQueue, () => () => {}, () => current.url)
  const observeA = owner.observer()
  const pa = owner.acquire("tq_fixture", action)
  let pb: Promise<TaskQueueInfo> | undefined
  try {
    await a.requested.promise
    current = b
    pb = owner.acquire("tq_fixture", action)
    await b.requested.promise
    b.complete(true)
    await pb
    if (!before) { a.complete(true); await pa }
    // The old stream can flush after the live getter has already switched to B.
    observeA(taskQueue({ status: "done", time: { created: 1, updated: 150 } }))
    a.complete(true)
    expect((await pa).status).toBe(before ? "done" : "running")
    expect(owner.owns("tq_fixture")).toBe(true)
    current = a
    expect(owner.owns("tq_fixture")).toBe(false)
    // No idle history is retained once A's pending/owned work has ended.
    expect((await owner.acquire("tq_fixture", "resume")).status).toBe("running")
    expect(owner.owns("tq_fixture")).toBe(true)
    await owner.shutdown()
    expect(a.controls).toEqual([action, "resume", "stop"])
    expect(b.controls).toEqual([action, "stop"])
  } finally {
    a.complete(true); b.complete(true)
    await Promise.allSettled([pa, ...(pb ? [pb] : [])])
    await owner.shutdown()
  }
})

test.each(["plan", "start", "resume"] as const)("same canonical endpoint deduplicates a pending %s across credential refresh", async (action) => {
  await using source = await endpoint("same", true)
  let url = `${source.url}#old-stream`
  const owner = createTaskQueueOwner(() => source.api.taskQueue, () => () => {}, () => url)
  const request = owner.acquire("tq_fixture", action)
  try {
    await source.requested.promise
    source.rotate()
    url = source.url
    expect(owner.acquire("tq_fixture", action)).toBe(request)
    source.complete(true)
    await request
    expect(owner.owns("tq_fixture")).toBe(true)
    await owner.shutdown()
    expect(source.controls).toEqual([action, "stop"])
    expect(source.credentials).toEqual([1, 2])
    expect(source.rejected).toEqual([])
  } finally {
    source.complete(true)
    await request
    await owner.shutdown()
  }
})

test("a delayed terminal A heartbeat cannot revoke B and each source has only one in-flight renewal", async () => {
  await using a = await endpoint("A", false, "queued", true)
  await using b = await endpoint("B", false, "queued", true)
  let current = a
  const ticks = new Set<() => void>()
  const owner = createTaskQueueOwner(() => current.api.taskQueue, (tick) => { ticks.add(tick); return () => { ticks.delete(tick) } }, () => current.url)
  try {
    await owner.acquire("tq_fixture", "start")
    current = b
    await owner.acquire("tq_fixture", "resume")
    ticks.forEach((tick) => { tick(); tick() })
    await Promise.all([a.beat.promise, b.beat.promise])
    expect(ticks.size).toBe(1)
    a.completeBeat("done")
    b.completeBeat("running")
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 2_000
      const check = () => {
        current = a
        const ended = !owner.owns("tq_fixture")
        current = b
        if (ended) return resolve()
        if (Date.now() >= deadline) return reject(new Error("A heartbeat reply was not reconciled"))
        setTimeout(check, 10)
      }
      check()
    })
    expect(owner.owns("tq_fixture")).toBe(true)
    await owner.shutdown()
    expect(a.controls).toEqual(["start", "heartbeat"])
    expect(b.controls).toEqual(["resume", "heartbeat", "stop"])
    expect(ticks.size).toBe(0)
  } finally {
    a.completeBeat("done"); b.completeBeat("running")
    await owner.shutdown()
  }
})

async function endpoint(name: string, pending: boolean, status: TaskQueueInfo["status"] = "queued", holdHeartbeat = false) {
  let info = taskQueue({ title: `${name} source result`, status, time: { created: 1, updated: 2 } })
  let credential = 1
  const controls: string[] = []
  const credentials: number[] = []
  const rejected: string[] = []
  const requested = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<Response>()
  const beat = Promise.withResolvers<void>()
  const beatReply = Promise.withResolvers<Response>()
  const authorization = () => "Basic " + Buffer.from(`fixture:${name}-${credential}`).toString("base64")
  const server = Bun.serve({ port: 0, fetch(request) {
    const action = new URL(request.url).pathname.split("/").at(-1)!
    if (request.headers.get("authorization") !== authorization()) { rejected.push(action); return new Response(null, { status: 401 }) }
    controls.push(action)
    credentials.push(credential)
    if (action === "heartbeat") { beat.resolve(); return holdHeartbeat ? beatReply.promise : json({ data: info }) }
    if (action === "stop") { info = { ...info, status: "stopped" }; return json({ data: info }) }
    if (action === "plan") info = { ...info, workflowVersion: 2, phase: "planning" }
    requested.resolve()
    if (pending && controls.length === 1) return reply.promise
    info = { ...info, status: "running" }
    return json({ data: info })
  } })
  let api = OpenCode.make({ baseUrl: server.url.toString(), headers: { authorization: authorization() } })
  return {
    url: server.url.toString(), get api() { return api }, info: () => info, controls, credentials, rejected, requested, beat,
    complete(success: boolean) {
      info = { ...info, status: "running", time: { created: 1, updated: name === "A" ? 99 : 2 } }
      reply.resolve(success ? json({ data: info }) : new Response(null, { status: 503 }))
    },
    completeBeat(status: TaskQueueInfo["status"]) { beatReply.resolve(json({ data: { ...info, status, time: { created: 1, updated: 200 } } })) },
    rotate() {
      credential++
      api = OpenCode.make({ baseUrl: server.url.toString(), headers: { authorization: authorization() } })
    },
    async [Symbol.asyncDispose]() {
      reply.resolve(json({ data: info }))
      beatReply.resolve(json({ data: info }))
      await server.stop(true)
    },
  }
}
