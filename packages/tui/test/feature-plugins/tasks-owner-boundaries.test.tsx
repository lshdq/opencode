import { expect, test } from "bun:test"
import { OpenCode, type OpenCodeEvent, type TaskQueueInfo } from "@opencode/client"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createRoot } from "solid-js"
import { ClientContext, ClientProvider, useClient } from "../../src/context/client"
import { LogProvider } from "../../src/context/log"
import { TaskQueueProvider, useTaskQueueOwner } from "../../src/context/task-queue"
import { TuiLifecycleProvider } from "../../src/context/runtime"
import { createTaskQueueOwner } from "../../src/util/task-queue-owner"
import { taskQueue } from "../fixture/task-queue"
import { createEventStream, createFetch, json } from "../fixture/tui-client"

// TC-035: a live SDK change must not relabel a queued event before the ordered
// server.connected boundary. Exercise the production Provider, not just observer().
test.each(
  (["start", "resume"] as const).flatMap((action) =>
    ([true, false] as const).map((pending) => [`${action}/${pending ? "pending" : "owned"}`, action, pending] as const),
  ),
)(
  "Provider FIFO boundary routes buffered A and current B %s observations to their source",
  async (_, action, pending) => {
    const controls = { A: [] as string[], B: [] as string[] }
    const requested = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<Response>()
    const wire = createEventStream()
    const relay = createGlobalEmitter<{ [T in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: T }> }>()
    const finalizers = new Set<() => Promise<void>>()
    const api = (source: "A" | "B") =>
      OpenCode.make({
        baseUrl: `http://${source.toLowerCase()}.fixture`,
        fetch: createFetch(async (url) => {
          const method = url.pathname.split("/").at(-1)!
          controls[source].push(method)
          if (source === "A" && method === action) {
            requested.resolve()
            if (pending) return reply.promise
          }
          return json({
            data: taskQueue({
              title: `${source} response`,
              status: method === "stop" ? "stopped" : "running",
              time: { created: 1, updated: source === "A" ? 99 : 2 },
            }),
          })
        }).fetch,
      })
    let current = { api: api("A"), url: "http://a.fixture" }
    const initial = current
    const eventSources = new WeakMap<OpenCodeEvent, typeof current>()
    const emit = (event: OpenCodeEvent, source: typeof current) => {
      eventSources.set(event, source)
      relay.emit(event.type, event)
    }
    let owner: ReturnType<typeof useTaskQueueOwner> | undefined
    function Capture() {
      owner = useTaskQueueOwner()
      return null
    }
    function Bind() {
      const base = useClient()
      return (
        <ClientContext.Provider
          value={{
            ...base,
            get api() {
              return current.api
            },
            get url() {
              return current.url
            },
            event: { ...relay, source: (event) => eventSources.get(event) },
          }}
        >
          <TuiLifecycleProvider
            value={{
              add(finalizer) {
                finalizers.add(finalizer)
                return () => {
                  finalizers.delete(finalizer)
                }
              },
            }}
          >
            <TaskQueueProvider>
              <Capture />
            </TaskQueueProvider>
          </TuiLifecycleProvider>
        </ClientContext.Provider>
      )
    }
    const root = createRoot((dispose) => {
      const tree = (
        <LogProvider log={() => {}}>
          <ClientProvider
            url="http://stream.fixture"
            api={OpenCode.make({ baseUrl: "http://stream.fixture", fetch: createFetch(undefined, wire).fetch })}
          >
            <Bind />
          </ClientProvider>
        </LogProvider>
      )
      return { dispose, tree }
    })
    expect(owner).toBeDefined()
    const source = owner!
    const pa = source.acquire("tq_fixture", action)
    try {
      await requested.promise
      if (!pending) await pa
      current = { api: api("B"), url: "http://b.fixture" }
      await source.acquire("tq_fixture", action)
      // Model the already-decoded FIFO delivery after the SDK getter moved to B.
      emit({
        id: "evt_buffered_A",
        created: 150,
        type: "taskqueue.updated",
        data: taskQueue({ status: "done", time: { created: 1, updated: 150 } }),
      }, initial)
      emit({ id: "evt_B_connected", type: "server.connected", data: {} }, current)
      emit({
        id: "evt_current_B",
        created: 151,
        type: "taskqueue.updated",
        data: taskQueue({ title: "B current", status: "running", time: { created: 1, updated: 151 } }),
      }, current)
      reply.resolve(json({ data: taskQueue({ status: "running", time: { created: 1, updated: 99 } }) }))
      await pa
      expect(source.owns("tq_fixture")).toBe(true)
      current = { ...current, url: "http://a.fixture" }
      expect(source.owns("tq_fixture")).toBe(false)
      // A fresh B terminal observation after connected must now end B, not A.
      current = { ...current, url: "http://b.fixture" }
      emit({
        id: "evt_B_done",
        created: 152,
        type: "taskqueue.updated",
        data: taskQueue({ status: "done", time: { created: 1, updated: 152 } }),
      }, current)
      expect(source.owns("tq_fixture")).toBe(false)
    } finally {
      reply.resolve(json({ data: taskQueue({ status: "running" }) }))
      await pa
      root.dispose()
      await source.shutdown()
      await Promise.all([...finalizers].map((finalizer) => finalizer()))
      wire.disconnect()
    }
    expect(controls).toEqual({ A: [action], B: [action] })
    expect(finalizers.size).toBe(0)
  },
)

test.each(["path", "query"] as const)(
  "owner identity preserves the endpoint %s instead of merging same-authority pending actions",
  async (dimension) => {
    const controls = { A: [] as string[], B: [] as string[] }
    const replies = { A: Promise.withResolvers<Response>(), B: Promise.withResolvers<Response>() }
    const requested = { A: Promise.withResolvers<void>(), B: Promise.withResolvers<void>() }
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const source = request.headers.get("x-fixture-origin") === "A" ? "A" : "B"
        const method = new URL(request.url).pathname.split("/").at(-1)!
        controls[source].push(method)
        if (method === "start") {
          requested[source].resolve()
          return replies[source].promise
        }
        return json({ data: taskQueue({ status: "stopped" }) })
      },
    })
    const endpoints = (["A", "B"] as const).map((source) => {
      const url = server.url.toString() + (dimension === "path" ? `gateway-${source}/` : `?tenant=${source}`)
      return { url, api: OpenCode.make({ baseUrl: url, headers: { "x-fixture-origin": source } }) }
    })
    let current = endpoints[0]
    const owner = createTaskQueueOwner(
      () => current.api.taskQueue,
      () => () => {},
      () => current.url,
    )
    const pa = owner.acquire("tq_fixture", "start")
    let pb: Promise<TaskQueueInfo> | undefined
    try {
      await requested.A.promise
      current = endpoints[1]
      pb = owner.acquire("tq_fixture", "start")
      expect(pb).not.toBe(pa)
      await requested.B.promise
      replies.A.resolve(json({ data: taskQueue({ title: "A result", status: "running" }) }))
      await pa
      expect(owner.acquire("tq_fixture", "start")).toBe(pb)
      replies.B.resolve(json({ data: taskQueue({ title: "B result", status: "running" }) }))
      expect((await pb).title).toBe("B result")
    } finally {
      replies.A.resolve(json({ data: taskQueue({ status: "running" }) }))
      replies.B.resolve(json({ data: taskQueue({ status: "running" }) }))
      await Promise.allSettled([pa, ...(pb ? [pb] : [])])
      await owner.shutdown()
      await server.stop(true)
    }
    expect(controls).toEqual({ A: ["start", "stop"], B: ["start", "stop"] })
  },
)

test("canonical host case, default port and fragment keep pending ownership and refresh the SDK used for exit", async () => {
  const reply = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const controls: string[] = []
  const versions: string[] = []
  const make = (url: string, version: string) => ({
    url,
    api: OpenCode.make({
      baseUrl: url,
      headers: { "x-fixture-version": version },
      fetch: createFetch(async (requestURL, request) => {
        const method = requestURL.pathname.split("/").at(-1)!
        controls.push(method)
        versions.push(request.headers.get("x-fixture-version")!)
        if (method === "start") {
          requested.resolve()
          return reply.promise
        }
        return json({ data: taskQueue({ status: "stopped" }) })
      }).fetch,
    }),
  })
  let current = make("HTTP://Fixture.Example:80/gateway?tenant=A#before", "1")
  const owner = createTaskQueueOwner(
    () => current.api.taskQueue,
    () => () => {},
    () => current.url,
  )
  const pa = owner.acquire("tq_fixture", "start")
  try {
    await requested.promise
    current = make("http://fixture.example/gateway?tenant=A#after", "2")
    expect(owner.acquire("tq_fixture", "start")).toBe(pa)
    reply.resolve(json({ data: taskQueue({ status: "running" }) }))
    await pa
    expect(owner.owns("tq_fixture")).toBe(true)
  } finally {
    reply.resolve(json({ data: taskQueue({ status: "running" }) }))
    await pa
    await owner.shutdown()
  }
  expect(controls).toEqual(["start", "stop"])
  expect(versions).toEqual(["1", "2"])
})

test("without a URL the exact SDK resource is the fallback identity, not a guessed shared endpoint", async () => {
  const reply = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const controls: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const method = new URL(request.url).pathname.split("/").at(-1)!
      controls.push(method)
      if (controls.length === 1) {
        requested.resolve()
        return reply.promise
      }
      return json({ data: taskQueue({ status: method === "stop" ? "stopped" : "running" }) })
    },
  })
  let api = OpenCode.make({ baseUrl: server.url.toString() })
  const owner = createTaskQueueOwner(
    () => api.taskQueue,
    () => () => {},
  )
  const pa = owner.acquire("tq_fixture", "start")
  try {
    await requested.promise
    expect(owner.acquire("tq_fixture", "start")).toBe(pa)
    api = OpenCode.make({ baseUrl: server.url.toString() })
    const pb = owner.acquire("tq_fixture", "start")
    expect(pb).not.toBe(pa)
    await pb
    reply.resolve(json({ data: taskQueue({ status: "running" }) }))
    await pa
  } finally {
    reply.resolve(json({ data: taskQueue({ status: "running" }) }))
    await pa
    await owner.shutdown()
    await server.stop(true)
  }
  expect(controls).toEqual(["start", "start", "stop", "stop"])
})
