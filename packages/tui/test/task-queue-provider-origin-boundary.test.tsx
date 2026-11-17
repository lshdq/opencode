import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { createRoot } from "solid-js"
import { ClientProvider, useClient } from "../src/context/client"
import { LogProvider } from "../src/context/log"
import { TaskQueueProvider, useTaskQueueOwner } from "../src/context/task-queue"
import { TuiLifecycleProvider } from "../src/context/runtime"
import { taskQueue } from "./fixture/task-queue"
import { createEventStream, json } from "./fixture/tui-client"

// TC-035: real ClientProvider buffering, not a second implementation of its routing.
test.each(["start", "resume"] as const)("Provider FIFO keeps buffered A termination on A after live SDK replacement during %s", async (action) => {
  const eventsA = createEventStream()
  const eventsB = createEventStream()
  const controlsA: string[] = []
  const controlsB: string[] = []
  const replyA = Promise.withResolvers<Response>()
  const requestedA = Promise.withResolvers<void>()
  const observedA = Promise.withResolvers<void>()
  const observedB = Promise.withResolvers<void>()
  const connected = Promise.withResolvers<void>()
  const finalizers = new Set<() => Promise<void>>()
  await using a = endpoint(controlsA, () => { requestedA.resolve(); return replyA.promise })
  await using b = endpoint(controlsB)
  // Only the SSE transport is local/in-memory so stream close -> SDK replacement
  // stays in microtasks before ClientProvider's existing 10ms FIFO flush.
  const apiA = sdk(a.url, eventsA)
  const apiB = sdk(b.url, eventsB)
  const seen: string[] = []
  const setup = createRoot((dispose) => {
    let owner: ReturnType<typeof useTaskQueueOwner> | undefined
    let client: ReturnType<typeof useClient> | undefined
    function Capture() {
      owner = useTaskQueueOwner()
      client = useClient()
      client.event.on("server.connected", () => { connected.resolve() })
      client.event.on("taskqueue.updated", (event) => {
        seen.push(`${event.data.title}:${client!.url === b.url ? "B" : "A"}`)
        if (event.data.title === "A buffered terminal") observedA.resolve()
        if (event.data.title === "B current running") observedB.resolve()
      })
      return null
    }
    const tree = <LogProvider log={() => {}}><TuiLifecycleProvider value={{ add(run) { finalizers.add(run); return () => { finalizers.delete(run) } } }}><ClientProvider api={apiA} url={a.url} service={{ reconnect: async () => ({ api: apiB, url: b.url }), restart: async () => {} }}><TaskQueueProvider><Capture /></TaskQueueProvider></ClientProvider></TuiLifecycleProvider></LogProvider>
    void tree
    if (!owner || !client) throw new Error("Production providers did not mount")
    return { owner, client, dispose }
  })
  let pending: Promise<unknown> | undefined
  try {
    await within(connected.promise)
    pending = setup.owner.acquire("tq_fixture", action)
    await within(requestedA.promise)
    eventsA.emit({ id: "evt_A_terminal", created: 3, type: "taskqueue.updated", data: taskQueue({ title: "A buffered terminal", status: "done", time: { created: 1, updated: 3 } }) })
    eventsA.disconnect()
    eventsB.emit({ id: "evt_B_running", created: 4, type: "taskqueue.updated", data: taskQueue({ title: "B current running", status: "running", time: { created: 1, updated: 4 } }) })
    await within(Promise.all([observedA.promise, observedB.promise]))
    // Prove the actual hard boundary occurred: live SDK is already B when the
    // queued A event is delivered, followed by server.connected and B events.
    expect(seen).toEqual(["A buffered terminal:B", "B current running:B"])
    replyA.resolve(json({ data: taskQueue({ status: "running", time: { created: 1, updated: 2 } }) }))
    await pending
    expect(setup.owner.owns("tq_fixture")).toBe(false)
    // A's end must survive the new B running event, without any B list/get.
    setup.dispose()
    await Promise.all([...finalizers].map((run) => run()))
    expect(controlsA).toEqual([action])
    expect(controlsB).toEqual([])
  } finally {
    replyA.resolve(json({ data: taskQueue({ status: "done" }) }))
    await pending?.catch(() => undefined)
    setup.dispose()
    await setup.owner.shutdown()
    eventsA.disconnect(); eventsB.disconnect()
  }
})

function endpoint(controls: string[], action?: () => Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch(request) {
    const method = new URL(request.url).pathname.split("/").at(-1)!
    controls.push(method)
    if (action && (method === "start" || method === "resume")) return action()
    return json({ data: taskQueue({ status: method === "stop" ? "stopped" : "running" }) })
  } })
  return { url: server.url.toString(), async [Symbol.asyncDispose]() { await server.stop(true) } }
}

function sdk(url: string, events: ReturnType<typeof createEventStream>) {
  async function request(input: RequestInfo | URL, init?: RequestInit) {
    if (new URL(input instanceof Request ? input.url : input.toString()).pathname === "/api/event") return events.v2()
    return fetch(input, init)
  }
  request.preconnect = () => {}
  return OpenCode.make({ baseUrl: url, fetch: request })
}

function within<T>(promise: Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Expected SDK/Provider signal was not delivered")), 2_000)
    void promise.then(
      (value) => { clearTimeout(deadline); resolve(value) },
      (error: unknown) => { clearTimeout(deadline); reject(error) },
    )
  })
}
