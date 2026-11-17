import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createClientConnection, type ClientConnectionOptions } from "../src/solid"
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "../src/promise"

const connected = { id: "evt_connected", created: 1, type: "server.connected", data: {} }

// One fake server whose event streams stay open until the test writes to them or the client aborts.
function server() {
  const encoder = new TextEncoder()
  const streams: {
    headers: Headers
    write: (text: string) => void
    close: () => void
    error: (reason: Error) => void
    aborted: boolean
  }[] = []
  const api = OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const entry = {
        headers: request.headers,
        write: (text: string) => controller.enqueue(encoder.encode(text)),
        close: () => controller.close(),
        error: (reason: Error) => controller.error(reason),
        aborted: false,
      }
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value
        },
        cancel() {
          entry.aborted = true
        },
      })
      request.signal.addEventListener("abort", () => {
        entry.aborted = true
        controller.error(request.signal.reason)
      })
      streams.push(entry)
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { api, streams }
}

function setup(input: ReturnType<typeof server>, idleTimeout: number) {
  const events: OpenCodeEvent[] = []
  return createRoot((dispose) => ({
    events,
    dispose,
    connection: createClientConnection(input.api, {
      idleTimeout,
      flushInterval: 0,
      onEvent: (event) => events.push(event),
    }),
  }))
}

async function until(check: () => boolean, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("a stream that goes silent past the idle timeout is replaced", async () => {
  const fake = server()
  const ctx = setup(fake, 60)
  try {
    await until(() => fake.streams.length === 1)
    fake.streams[0].write(`data: ${JSON.stringify(connected)}\n\n`)
    await until(() => ctx.connection.status() === "connected")

    await until(() => fake.streams.length === 2)
    expect(fake.streams[0].aborted).toBe(true)
    expect(ctx.connection.internal.history().map((item) => item.data)).toContainEqual({
      status: "disconnected",
      attempt: 1,
      error: "Event stream stalled",
    })

    fake.streams[1].write(`data: ${JSON.stringify({ ...connected, id: "evt_connected_2" })}\n\n`)
    await until(() => ctx.connection.status() === "connected" && ctx.events.length === 2)
    expect(ctx.connection.error()).toBeUndefined()
  } finally {
    ctx.dispose()
  }
})

test("keepalive comments hold a quiet stream open", async () => {
  const fake = server()
  const ctx = setup(fake, 60)
  try {
    await until(() => fake.streams.length === 1)
    fake.streams[0].write(`data: ${JSON.stringify(connected)}\n\n`)
    await until(() => ctx.connection.status() === "connected")

    const heartbeat = setInterval(() => fake.streams[0].write(": heartbeat\n\n"), 20)
    await new Promise((resolve) => setTimeout(resolve, 250))
    clearInterval(heartbeat)

    expect(fake.streams).toHaveLength(1)
    expect(fake.streams[0].aborted).toBe(false)
    expect(ctx.connection.status()).toBe("connected")
    expect(ctx.events).toHaveLength(1)
  } finally {
    ctx.dispose()
  }
})

test("a forced resync replaces the stream immediately and only while connected", async () => {
  const fake = server()
  const ctx = setup(fake, 10_000)
  try {
    ctx.connection.internal.resync("too early")
    await until(() => fake.streams.length === 1)
    expect(fake.streams[0].aborted).toBe(false)
    fake.streams[0].write(`data: ${JSON.stringify(connected)}\n\n`)
    await until(() => ctx.connection.status() === "connected")

    const started = Date.now()
    ctx.connection.internal.resync("Network connection restored")
    await until(() => fake.streams.length === 2)
    expect(Date.now() - started).toBeLessThan(500)
    expect(fake.streams[0].aborted).toBe(true)
    expect(ctx.connection.internal.history().map((item) => item.data)).toContainEqual({
      status: "disconnected",
      attempt: 1,
      error: "Network connection restored",
    })
    fake.streams[1].write(`data: ${JSON.stringify(connected)}\n\n`)
    await until(() => ctx.connection.status() === "connected")
  } finally {
    ctx.dispose()
  }
})

test.each([
  ["closes", (stream: ReturnType<typeof server>["streams"][number]) => stream.close(), "Event stream disconnected"],
  [
    "fails",
    (stream: ReturnType<typeof server>["streams"][number]) => stream.error(new Error("contract failure")),
    "Transport: contract failure",
  ],
])("a stream the server %s reconnects and reports the disconnect", async (_name, end, message) => {
  const fake = server()
  const ctx = setup(fake, 10_000)
  try {
    await until(() => fake.streams.length === 1)
    fake.streams[0].write(`data: ${JSON.stringify(connected)}\n\n`)
    await until(() => ctx.connection.status() === "connected")

    end(fake.streams[0])
    await until(() => ctx.connection.status() === "reconnecting")
    expect(ctx.connection.error()).toBe(message)
    await until(() => fake.streams.length === 2)
  } finally {
    ctx.dispose()
  }
})

test("a reconnect does not ask the volatile event stream to replay", async () => {
  const fake = server()
  const ctx = setup(fake, 10_000)
  try {
    await until(() => fake.streams.length === 1)
    fake.streams[0].write(`data: ${JSON.stringify(connected)}\n\n`)
    fake.streams[0].write(`id: timeline-event-7\ndata: ${JSON.stringify({ ...connected, id: "evt_2" })}\n\n`)
    await until(() => ctx.events.length === 2)

    fake.streams[0].error(new Error("retry with event id"))
    await until(() => fake.streams.length === 2)
    expect(fake.streams[1].headers.get("last-event-id")).toBeNull()
  } finally {
    ctx.dispose()
  }
})

test("buffered connected and data events retain their SDK through A-B-A2 same-URL replacements", async () => {
  const a = server()
  const b = server()
  const a2 = server()
  const received: { id: string; source: OpenCodeClient; arity: number }[] = []
  let resolutions = 0
  const ctx = createRoot((dispose) => ({ dispose, connection: createClientConnection(a.api, {
    // Existing coalescing option: several real decoder streams share a batch.
    flushInterval: 80,
    reconnect: async () => ++resolutions === 1 ? b.api : a2.api,
    onEvent(event, source) { received.push({ id: event.id, source, arity: arguments.length }) },
  }) }))
  try {
    await until(() => a.streams.length === 1)
    a.streams[0].write(`data: ${JSON.stringify({ ...connected, id: "evt_A" })}\n\n`)
    a.streams[0].close()
    await until(() => b.streams.length === 1)
    b.streams[0].write(`data: ${JSON.stringify({ ...connected, id: "evt_B" })}\n\ndata: ${JSON.stringify({ id: "evt_B_data", created: 2, type: "plugin.updated", data: {} })}\n\n`)
    await until(() => ctx.connection.internal.history().filter((event) => event.data.status === "connected").length === 2)
    ctx.connection.internal.resync("TC036 switch the second stream")
    await until(() => a2.streams.length === 1)
    a2.streams[0].write(`data: ${JSON.stringify({ ...connected, id: "evt_A2" })}\n\ndata: ${JSON.stringify({ id: "evt_A2_data", created: 3, type: "plugin.updated", data: {} })}\n\n`)
    await until(() => received.length === 5)
    expect(received).toEqual([
      { id: "evt_A", source: a.api, arity: 2 },
      { id: "evt_B", source: b.api, arity: 2 },
      { id: "evt_B_data", source: b.api, arity: 2 },
      { id: "evt_A2", source: a2.api, arity: 2 },
      { id: "evt_A2_data", source: a2.api, arity: 2 },
    ])
    expect(resolutions).toBe(2)
    expect(a.streams[0].aborted).toBe(true)
    expect(b.streams[0].aborted).toBe(true)
  } finally { ctx.dispose() }
})

test("disposal drops buffered source entries while legacy one-argument onEvent remains assignable and usable", async () => {
  const discarded = server()
  const sentinel = server()
  const events: OpenCodeEvent[] = []
  const stale: OpenCodeEvent[] = []
  const legacy: ClientConnectionOptions["onEvent"] = (event) => { events.push(event) }
  const ctx = createRoot((dispose) => ({ dispose, connection: createClientConnection(discarded.api, {
    flushInterval: 50, onEvent(event) { stale.push(event) },
  }) }))
  let cleanup: (() => void) | undefined
  try {
    await until(() => discarded.streams.length === 1)
    discarded.streams[0].write(`data: ${JSON.stringify(connected)}\n\n`)
    await until(() => ctx.connection.status() === "connected")
    ctx.dispose()
    const next = createRoot((dispose) => ({ dispose, connection: createClientConnection(sentinel.api, {
      flushInterval: 50, onEvent: legacy,
    }) }))
    cleanup = next.dispose
    await until(() => sentinel.streams.length === 1)
    // This real later flush is the barrier; no fixed sleep or fake global clock.
    sentinel.streams[0].write(`data: ${JSON.stringify(connected)}\n\n`)
    await until(() => events.length === 1)
    expect(stale).toEqual([])
    expect(events).toEqual([connected])
    expect(legacy.length).toBe(1)
    expect(discarded.streams[0].aborted).toBe(true)
  } finally { ctx.dispose(); cleanup?.() }
})
