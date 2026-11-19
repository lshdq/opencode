import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { createRoot } from "solid-js"
import { ClientProvider, useClient } from "../src/context/client"
import { LogProvider } from "../src/context/log"
import { TaskQueueProvider, useTaskQueueOwner } from "../src/context/task-queue"
import { TuiLifecycleProvider } from "../src/context/runtime"
import { taskQueue } from "./fixture/task-queue"
import { createEventStream, json } from "./fixture/tui-client"

test.each((["plan", "start", "resume"] as const).flatMap((action) => ([false, true] as const).map((pending) => [`${action}/${pending ? "pending" : "owned"}`, action, pending] as const)))("authenticated A-B-A before B flush preserves A's %s and complete exit responsibility", async (_, action, pending) => {
  const result = await scenario(action, pending, "B")
  console.info("R1A16 actual HTTP/SSE", JSON.stringify({ action, pending, terminal: "B", ...result }))
  expect(result).toEqual({
    before: !pending, after: true, reconnects: 2,
    streams: { A: 1, B: 1 }, seen: [{ title: "B terminal", live: "A" }],
    controls: { A: [action, "stop"], B: [] }, versions: [1, 2], rejected: [], finalizers: 0,
  })
})

test.each(["plan", "start", "resume"] as const)("authenticated A-B-A-B cannot lose A's received terminal before a late %s ACK", async (action) => {
  const result = await scenario(action, true, "A")
  console.info("R1A16 actual HTTP/SSE", JSON.stringify({ action, pending: true, terminal: "A", ...result }))
  expect(result).toEqual({
    before: false, after: false, reconnects: 3,
    streams: { A: 2, B: 1 }, seen: [{ title: "A terminal", live: "B" }],
    controls: { A: [action], B: [] }, versions: [1], rejected: [], finalizers: 0,
  })
})

test("an intermediate same-URL credential refresh remains usable after the live connection returns to B", async () => {
  const result = await scenario("start", true, "A", "running")
  console.info("R1A16 intermediate credential snapshot", JSON.stringify(result))
  expect(result).toEqual({
    before: false, after: false, reconnects: 3,
    streams: { A: 2, B: 1 }, seen: [{ title: "A refreshed running", live: "B" }],
    controls: { A: ["start", "stop"], B: [] }, versions: [1, 2], rejected: [], finalizers: 0,
  })
})

async function scenario(action: "plan" | "start" | "resume", pending: boolean, terminal: "A" | "B", state: "running" | "done" = "done") {
  const initial = Promise.withResolvers<void>()
  const onB = Promise.withResolvers<void>()
  const again = Promise.withResolvers<void>()
  const delivered = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const reply = Promise.withResolvers<Response>()
  const wireA = createEventStream()
  const wireB = createEventStream()
  const controls = { A: [] as string[], B: [] as string[] }
  const streams = { A: 0, B: 0 }
  const rejected: string[] = []
  const versions: number[] = []
  const seen: { title: string; live: string }[] = []
  const finalizers = new Set<() => Promise<void>>()
  let reconnects = 0
  let version = 1
  const authorization = (name: string) => "Basic " + Buffer.from(`fixture:${name}`).toString("base64")
  const closedStream = (source: "A" | "B") => new Response([
    { id: `evt_${source}_connected`, type: "server.connected", data: {} },
    { id: `evt_${source}_done`, created: 3, type: "taskqueue.updated", data: taskQueue({ title: source === "A" && state === "running" ? "A refreshed running" : `${source} terminal`, status: source === "A" ? state : "done", time: { created: 1, updated: 3 } }) },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  const a = Bun.serve({ port: 0, fetch(request) {
    if (request.headers.get("authorization") !== authorization(`A-${version}`)) { rejected.push("A"); return new Response(null, { status: 401 }) }
    if (new URL(request.url).pathname === "/api/event") {
      streams.A++
      return terminal === "A" && streams.A === 2 ? closedStream("A") : wireA.v2()
    }
    const method = new URL(request.url).pathname.split("/").at(-1)!
    controls.A.push(method); versions.push(version)
    if (method === action) { requested.resolve(); if (pending) return reply.promise }
    return json({ data: taskQueue({ status: method === "stop" ? "stopped" : "running", time: { created: 1, updated: 2 } }) })
  } })
  const b = Bun.serve({ port: 0, fetch(request) {
    if (request.headers.get("authorization") !== authorization("B")) { rejected.push("B"); return new Response(null, { status: 401 }) }
    if (new URL(request.url).pathname === "/api/event") {
      streams.B++
      return terminal === "B" ? closedStream("B") : wireB.v2()
    }
    controls.B.push(new URL(request.url).pathname.split("/").at(-1)!)
    return json({ data: taskQueue({ status: "stopped" }) })
  } })
  const apiA = OpenCode.make({ baseUrl: a.url.toString(), headers: { authorization: authorization("A-1") } })
  const apiB = OpenCode.make({ baseUrl: b.url.toString(), headers: { authorization: authorization("B") } })
  const refreshedA = OpenCode.make({ baseUrl: a.url.toString(), headers: { authorization: authorization("A-2") } })
  const setup = createRoot((dispose) => {
    let owner: ReturnType<typeof useTaskQueueOwner> | undefined
    let client: ReturnType<typeof useClient> | undefined
    function Capture() {
      owner = useTaskQueueOwner()
      client = useClient()
      client.event.on("server.connected", () => {
        if (reconnects === 0) initial.resolve()
        if (reconnects === 1) onB.resolve()
      })
      client.event.on("taskqueue.updated", (event) => {
        seen.push({ title: event.data.title!, live: client!.url === a.url.toString() ? "A" : "B" })
        delivered.resolve()
      })
      return null
    }
    const tree = <LogProvider log={() => {}}><TuiLifecycleProvider value={{ add(run) { finalizers.add(run); return () => { finalizers.delete(run) } } }}><ClientProvider api={apiA} url={a.url.toString()} service={{
      async reconnect() {
        reconnects++
        if (reconnects === 1) return { api: apiB, url: b.url.toString() }
        version = 2
        if (terminal === "B" || reconnects === 3) again.resolve()
        return reconnects === 3 ? { api: apiB, url: b.url.toString() } : { api: refreshedA, url: a.url.toString() }
      }, restart: async () => {},
    }}><TaskQueueProvider><Capture /></TaskQueueProvider></ClientProvider></TuiLifecycleProvider></LogProvider>
    void tree
    if (!owner || !client) throw new Error("Production providers did not mount")
    return { dispose, owner, client }
  })
  let operation: Promise<unknown> | undefined
  try {
    await within(initial.promise)
    operation = setup.owner.acquire("tq_fixture", action)
    await within(requested.promise)
    if (!pending) await operation
    const before = setup.owner.owns("tq_fixture")
    wireA.disconnect()
    if (terminal === "A") {
      await within(onB.promise)
      // A normal forced resync returns from the stable B stream without sleeping
      // through the retry backoff. A's first received packet then closes itself.
      setup.client.connection.internal.resync("TC036 return to A")
    }
    await within(again.promise)
    await within(delivered.promise)
    reply.resolve(json({ data: taskQueue({ status: "running", time: { created: 1, updated: 2 } }) }))
    await operation
    const after = setup.owner.owns("tq_fixture")
    setup.dispose()
    await setup.owner.shutdown()
    await Promise.all([...finalizers].map((run) => run()))
    // Every control and qualification assertion is after complete root disposal
    // and the real lifecycle finalizers, not before the late exit requests.
    return { before, after, reconnects, streams, seen, controls, versions, rejected, finalizers: finalizers.size }
  } finally {
    reply.resolve(json({ data: taskQueue({ status: "running", time: { created: 1, updated: 2 } }) }))
    await operation?.catch(() => undefined)
    setup.dispose()
    await setup.owner.shutdown()
    await Promise.all([...finalizers].map((run) => run()))
    wireA.disconnect(); wireB.disconnect()
    await Promise.all([a.stop(true), b.stop(true)])
  }
}

function within<T>(promise: Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Expected actual HTTP/SSE handshake within two seconds")), 2_000)
    void promise.then((value) => { clearTimeout(deadline); resolve(value) }, (cause: unknown) => { clearTimeout(deadline); reject(cause) })
  })
}
