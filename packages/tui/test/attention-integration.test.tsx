/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createComputed, createRoot } from "solid-js"
import type { OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { Attention } from "@opencode/plugin/tui/context"
import { ConfigProvider } from "../src/config"
import { AttentionProvider, useAttention } from "../src/context/attention"
import { ClientProvider, useClient } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import type { LogLevel, LogTags } from "../src/context/log"
import Notifications from "../src/feature-plugins/system/notifications"
import { createPluginContext, type Registry, type usePluginHost } from "../src/plugin/api"
import { createApi, createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

let sequence = 0
type ShownToast = Parameters<ReturnType<typeof usePluginHost>["toast"]["show"]>[0]
function durable(sessionID: string) {
  return { aggregateID: sessionID, seq: ++sequence, version: 1 as const }
}

// TC-001..007: real SSE -> ClientProvider -> createData projection -> plugin adapter
// -> AttentionProvider -> LogProvider. Both native channels stay disabled throughout.
async function setup(active?: () => Promise<Response>, observe?: { reconciledShell(id: string): void; status(): void }) {
  const events = createEventStream()
  const logs: { level: LogLevel; tags: LogTags }[] = []
  const toasts: ShownToast[] = []
  const infos: SessionInfo[] = [
    { id: "root", parentID: undefined },
    { id: "child", parentID: "root" },
    { id: "nested", parentID: "child" },
    { id: "other", parentID: undefined },
  ].map((info) => ({
    ...info, projectID: "proj_test", location: { directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 }, title: "PRIVATE SESSION TITLE",
  }))
  let activeReads = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session/active" && ++activeReads > 1 && active) return active()
    const info = infos.find((info) => url.pathname === `/api/session/${info.id}`)
    if (info) return json({ data: info })
    if (/^\/api\/session\/[^/]+\/children$/.test(url.pathname)) return json({ data: [], cursor: {} })
  }, events)
  let data!: ReturnType<typeof useData>
  let attention!: Attention
  let context!: ReturnType<typeof createPluginContext>
  let client!: ReturnType<typeof useClient>
  const owned: (() => Promise<void>)[] = []
  const registry: Registry = { has: () => false, set() {}, remove() {}, active: () => true }
  let connected!: () => void
  const ready = new Promise<void>((resolve) => { connected = resolve })
  function Probe() {
    client = useClient()
    data = useData()
    attention = useAttention()
    data.on("server.connected", connected)
    const host = {
      app: { version: "test", channel: "test" }, client: { api: {} },
      keymap: {}, shortcuts: {}, keymapState: {}, sessionTabs: {},
      attention,
      data: observe ? { ...data, session: { ...data.session,
        status(sessionID: string) {
          const status = data.session.status(sessionID)
          observe.status()
          return status
        },
      }, shell: { ...data.shell,
        get(id: string) {
          const shell = data.shell.get(id)
          observe.reconciledShell(id)
          return shell
        },
      } } : data,
      location: { current: { directory } },
      route: { data: { type: "home" }, navigate() {} }, toast: { show: (toast: ShownToast) => toasts.push(toast) },
    } as unknown as ReturnType<typeof usePluginHost>
    context = createPluginContext({ host, id: "opencode.notifications", options: undefined, owned, registry })
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts log={(level, _message, tags) => logs.push({ level, tags })}>
      <ClientProvider api={createApi(calls.fetch)}>
        <DataProvider directory={directory}>
          <ConfigProvider config={createTuiResolvedConfig({ attention: { notifications: false, sound: false } })}>
            <AttentionProvider><Probe /></AttentionProvider>
          </ConfigProvider>
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ), { width: 80, height: 24 })
  await ready
  await Promise.all(infos.map((info) => data.session.sync(info.id)))
  let cleanup = await Notifications.setup(context)
  const stopNotifications = async () => {
    const current = cleanup
    cleanup = undefined
    await current?.()
  }
  return {
    data, attention, logs, toasts, stopNotifications,
    async reconnect() {
      const connected = new Promise<void>((resolve) => {
        const off = data.on("server.connected", () => { off(); resolve() })
      })
      // Exercise a replacement SSE stream without waiting out the retry delay.
      client.connection.internal.resync("attention test resync")
      events.disconnect()
      await connected
    },
    plugin(id: string) {
      // Use the same production adapter as a legacy third-party plugin.
      const host = { app: { version: "test", channel: "test" }, client: { api: {} },
        keymap: {}, shortcuts: {}, keymapState: {}, sessionTabs: {}, attention, data,
      } as unknown as ReturnType<typeof usePluginHost>
      return createPluginContext({ host, id, options: undefined, owned, registry })
    },
    lifecycle(type: "started" | "succeeded" | "interrupted" | "failed", sessionID = "root", reason: "user" | "shutdown" | "superseded" | "inactivity" = "user"): OpenCodeEvent {
      const envelope = durable(sessionID)
      return {
        id: `evt_${envelope.seq}`, created: envelope.seq, type: `session.execution.${type}`,
        durable: envelope,
        data: { sessionID, ...(type === "interrupted" ? { reason } : {}),
          ...(type === "failed" ? { error: { type: "unknown", message: "PRIVATE FAILURE" } } : {}),
        },
      } as OpenCodeEvent
    },
    async send(...batch: OpenCodeEvent[]) {
      const last = batch.at(-1)!
      const observed = new Promise<void>((resolve) => {
        const off = data.listen(({ details }) => {
          if (details.id !== last.id) return
          off()
          resolve()
        })
      })
      batch.forEach((event) => events.emit({ ...event, location: event.location ?? { directory } }))
      await observed
      // Input attention intentionally runs after all projections in the SSE batch.
      await Promise.resolve()
      await Promise.resolve()
    },
    requests: () => logs.filter((log) => log.tags.component === "attention" && log.tags.phase === "request").map((log) => log.tags),
    async [Symbol.asyncDispose]() {
      await stopNotifications()
      await Promise.all(owned.reverse().map((dispose) => dispose()))
      app.renderer.destroy()
    },
  }
}

function enqueued(id: string, sessionID = "root"): OpenCodeEvent {
  return { id: `evt_enqueue-${id}`, created: 0, type: "session.inbox.enqueued",
    durable: durable(sessionID),
    data: { sessionID, inboxID: id, item: { type: "synthetic", delivery: "steer", payload: {
      text: "PRIVATE BACKGROUND RESULT", metadata: { source: "subagent", childID: "child", state: "completed" },
    } } } }
}

test("TC-001/007: actual synthetic admission and delivery only allow a fresh main success", async () => {
  await using harness = await setup()
  await harness.send(harness.lifecycle("started"), harness.lifecycle("started", "child"), harness.lifecycle("succeeded"))
  expect(harness.requests()).toEqual([])
  await harness.send(harness.lifecycle("succeeded", "child"), enqueued("background-result"))
  expect(harness.data.session.pending.list("root").map((item) => ({ id: item.id, type: item.type })))
    .toEqual([{ id: "background-result", type: "synthetic" }])
  expect(harness.requests().map((log) => log.type)).toEqual(["subagent_done"])
  await harness.send(harness.lifecycle("succeeded"))
  expect(harness.requests().map((log) => log.type)).toEqual(["subagent_done"])
  await harness.send(harness.lifecycle("started"), {
    id: "evt_delivered", created: 0, type: "session.inbox.delivered",
    durable: durable("root"), data: { sessionID: "root", inboxID: "background-result" },
  }, harness.lifecycle("succeeded"))
  expect(harness.data.session.pending.list("root")).toEqual([])
  expect(harness.requests().map((log) => log.type)).toEqual(["subagent_done", "done"])
  await harness.send(harness.lifecycle("succeeded"))
  expect(harness.requests()).toHaveLength(2)
  expect(harness.logs.filter((log) => log.tags.component === "attention").every((log) => log.level === "info")).toBe(true)
  expect(JSON.stringify(harness.logs.filter((log) => log.tags.component === "attention"))).not.toContain("PRIVATE")
})

test("TC-007: real pending projection suppresses a first idle success, not just a duplicate", async () => {
  await using harness = await setup()
  await harness.send(enqueued("pending-input"), harness.lifecycle("succeeded"))
  expect(harness.logs).toContainEqual(expect.objectContaining({ tags: expect.objectContaining({
    phase: "suppressed", suppressionReason: "pending_input", pendingCount: 1,
  }) }))
  expect(harness.requests()).toEqual([])
})

test.each(["user", "shutdown", "superseded", "inactivity"] as const)("TC-003: real root/child %s interruption does not become done", async (reason) => {
  await using harness = await setup()
  await harness.send(harness.lifecycle("started"), harness.lifecycle("started", "child"),
    harness.lifecycle("interrupted", "child", reason), harness.lifecycle("interrupted", "root", reason))
  expect(harness.requests()).toEqual([])
  expect(harness.logs.filter((log) => log.tags.suppressionReason === "execution_interrupted")).toHaveLength(2)
})

test.each(["root", "child"])("TC-003/006: the activity observer preserves real %s failures and retry deduplication", async (sessionID) => {
  await using harness = await setup()
  const start = harness.lifecycle("started", sessionID)
  const failed = harness.lifecycle("failed", sessionID)
  await harness.send(start)
  expect(harness.data.session.status(sessionID)).toBe("running")
  await harness.send(failed)
  expect(harness.requests().map((request) => [request.type, request.sessionID])).toEqual([["error", sessionID]])
  expect(harness.toasts).toHaveLength(1)
  await harness.send(failed, harness.lifecycle("failed", sessionID), start)
  expect(harness.data.session.status(sessionID)).toBe("idle")
  expect(harness.requests()).toHaveLength(1)
  expect(harness.toasts).toHaveLength(1)
  await harness.send(harness.lifecycle("started", sessionID), failed)
  expect(harness.data.session.status(sessionID)).toBe("running")
  expect(harness.requests()).toHaveLength(1)
  await harness.send(harness.lifecycle("failed", sessionID))
  expect(harness.requests().map((request) => [request.type, request.sessionID])).toEqual([["error", sessionID], ["error", sessionID]])
  expect(harness.toasts).toHaveLength(2)
  expect(JSON.stringify(harness.logs.filter((log) => log.tags.component === "attention"))).not.toContain("PRIVATE")
})

test("TC-003/004: real form and permission projections keep genuine inputs and cancel automatically settled ones", async () => {
  await using harness = await setup()
  const form = (id: string): OpenCodeEvent => ({ id: `create-${id}`, created: 0, type: "form.created", data: {
    form: { id, sessionID: "root", title: "PRIVATE FORM", fields: [{ key: "private", type: "external", url: "https://private.invalid" }] },
  } })
  const permission = (id: string): OpenCodeEvent => ({ id: `ask-${id}`, created: 0, type: "permission.asked", data: {
    id, sessionID: "root", action: "shell", resources: ["PRIVATE COMMAND"], metadata: {}, save: [],
  } })
  await harness.send(form("auto-form"), { id: "cancel", created: 0, type: "form.cancelled", data: { sessionID: "root", id: "auto-form" } },
    permission("auto-permission"), { id: "reply", created: 0, type: "permission.replied", data: { sessionID: "root", requestID: "auto-permission", reply: "once" } },
    form("genuine-form"), permission("genuine-permission"))
  expect(harness.data.session.form.list("root")?.map((item) => item.id)).toEqual(["genuine-form"])
  expect(harness.data.session.permission.list("root")?.map((item) => item.id)).toEqual(["genuine-permission"])
  expect(harness.requests().map((log) => [log.type, log.reason, log.pluginID])).toEqual([
    ["question", "form.created", "opencode.notifications"], ["permission", "permission.asked", "opencode.notifications"],
  ])
  expect(JSON.stringify(harness.logs.filter((log) => log.tags.component === "attention"))).not.toContain("PRIVATE")
})

test("TC-002/004/005/006: real nested cross-location cache deduplicates shells and isolates other roots", async () => {
  await using harness = await setup()
  const shell = (id: string, sessionID: string): OpenCodeEvent => ({ id: `create-${id}`, created: 0,
    type: "shell.created", location: { directory: "/PRIVATE OTHER DIRECTORY" }, data: { info: {
      id, status: "running", metadata: { sessionID }, command: "PRIVATE COMMAND", shell: "sh",
      file: "/PRIVATE FILE", cwd: "/PRIVATE CWD", time: { started: 0 },
    } } })
  await harness.send(harness.lifecycle("started", "nested"), harness.lifecycle("started", "other"), shell("nested-shell", "nested"), shell("other-shell", "other"))
  expect(harness.data.shell.listBySession("nested")).toHaveLength(1)
  const plugin = harness.plugin("third.party")
  expect(await plugin.attention.notify({ message: "PRIVATE BODY", diagnostic: { sessionID: "child" } }))
    .toEqual({ ok: false, notification: false, sound: false, skipped: "attention_disabled" })
  expect(harness.requests().at(-1)).toMatchObject({ rootSessionID: "root", runningSubagents: 1, runningShells: 1,
    pendingCount: null, statisticsComplete: false, pluginID: "third.party", type: "unknown", reason: "unknown" })
  await harness.send(harness.lifecycle("succeeded"))
  expect(harness.requests().filter((log) => log.type === "done")).toEqual([])
  await harness.send({ id: "delete-shell", created: 0, type: "shell.deleted", location: { directory: "/PRIVATE OTHER DIRECTORY" },
    data: { id: "nested-shell" } }, harness.lifecycle("succeeded", "nested"))
  expect(harness.requests().filter((log) => log.type === "done")).toEqual([])
  await plugin.attention.notify({ message: "PRIVATE BODY", diagnostic: { sessionID: "root" } })
  expect(harness.requests().at(-1)).toMatchObject({ runningSubagents: null, runningShells: null })
  expect(JSON.stringify(harness.logs.filter((log) => log.tags.component === "attention"))).not.toContain("PRIVATE")
})

test("TC-005/006: a replayed stale child start cannot resurrect finished background work", async () => {
  await using harness = await setup()
  const oldStart = harness.lifecycle("started", "child")
  await harness.send(oldStart, harness.lifecycle("succeeded", "child"))
  await harness.send(oldStart)
  await harness.send(harness.lifecycle("succeeded"))
  // The plugin has already observed a newer terminal seq for this child.
  expect(harness.requests().filter((log) => log.type === "done")).toHaveLength(1)
  expect(harness.requests().at(-1)).toMatchObject({ runningSubagents: null })
  expect(harness.data.session.status("child")).toBe("idle")
})

test("TC-001/005/006: a replayed old child terminal cannot hide its newer running execution", async () => {
  await using harness = await setup()
  const oldSuccess = harness.lifecycle("succeeded", "child")
  await harness.send(oldSuccess)
  await harness.send(harness.lifecycle("started", "child"))
  await harness.send(oldSuccess)
  await harness.send(harness.lifecycle("succeeded"))
  expect(harness.logs).toContainEqual(expect.objectContaining({ tags: expect.objectContaining({
    phase: "suppressed", suppressionReason: "stale_lifecycle", eventID: oldSuccess.id,
  }) }))
  // An old terminal replay is not evidence that the newer child execution ended.
  expect(harness.requests().filter((log) => log.type === "done")).toEqual([])
  expect(harness.data.session.status("child")).toBe("running")
  expect(harness.logs).toContainEqual(expect.objectContaining({ tags: expect.objectContaining({
    phase: "suppressed", suppressionReason: "background_work", runningSubagents: 1,
  }) }))
})

test.each(["running", "idle"] as const)("TC-005/006: real SSE reconnect recovers missed %s transition despite in-flight old replay", async (before) => {
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  await using harness = await setup(() => {
    requested.resolve()
    return response.promise
  })
  try {
    const stale = harness.lifecycle(before === "running" ? "started" : "succeeded", "child")
    await harness.send(stale)
    expect(harness.data.session.status("child")).toBe(before)
    await harness.reconnect()
    await requested.promise
    const raw: string[] = []
    const off = harness.data.on(stale.type, (event) => raw.push(event.id))
    await harness.send(stale)
    off()
    expect(raw).toEqual([stale.id])
    const after = before === "running" ? "idle" : "running"
    using recovered = createRoot((dispose) => {
      const ready = Promise.withResolvers<void>()
      createComputed(() => {
        // A separate root marks snapshot application even if child recovery regresses.
        if (harness.data.session.status("other") === "running") ready.resolve()
      })
      return { ready: ready.promise, [Symbol.dispose]: dispose }
    })
    response.resolve(json({ data: { other: { type: "running" }, ...(after === "running" ? { child: { type: "running" } } : {}) } }))
    await recovered.ready
    expect(harness.data.session.status("child")).toBe(after)
    // A third-party request checks the actual diagnostic cache, not a copied state machine.
    await harness.plugin("third.party").attention.notify({ message: "PRIVATE BODY", diagnostic: { sessionID: "root" } })
    expect(harness.requests().at(-1)).toMatchObject({ runningSubagents: after === "running" ? 1 : null })
    await harness.send(stale)
    expect(harness.data.session.status("child")).toBe(after)
    await harness.send(harness.lifecycle("started"), harness.lifecycle("succeeded"))
    expect(harness.requests().filter((log) => log.type === "done")).toHaveLength(after === "running" ? 0 : 1)
    if (after === "running") {
      await harness.send(harness.lifecycle("succeeded", "child"))
      expect(harness.requests().filter((log) => log.type === "done")).toHaveLength(0)
      await harness.send(harness.lifecycle("started"), harness.lifecycle("succeeded"))
      expect(harness.requests().filter((log) => log.type === "done")).toHaveLength(1)
    }
    expect(JSON.stringify(harness.logs.filter((log) => log.tags.component === "attention"))).not.toContain("PRIVATE")
  } finally {
    response.resolve(json({ data: {} }))
  }
})

test.each(["succeeded", "failed"] as const)("R-01: late active recovery admits direct new %s after the notification reconnect barrier", async (outcome) => {
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const barrier = Promise.withResolvers<void>()
  const reads = { armed: false, statuses: 0 }
  await using harness = await setup(() => {
    requested.resolve()
    return response.promise
  }, {
    reconciledShell(id) {
      // Only synchronize(true) reconciles this observed shell. Session-list read
      // counts are not a barrier: the activity observer reads that same list.
      if (reads.armed && id === "reconnect-barrier-shell") barrier.resolve()
    },
    status: () => reads.statuses++,
  })
  try {
    await harness.send(harness.lifecycle("succeeded"))
    expect(harness.requests().map((request) => request.type)).toEqual(["done"])
    await harness.send({ id: "evt_barrier-shell", created: 0, type: "shell.created", data: { info: {
      id: "reconnect-barrier-shell", status: "running", metadata: { sessionID: "root" }, command: "PRIVATE COMMAND",
      shell: "sh", file: "/PRIVATE FILE", cwd: "/PRIVATE CWD", time: { started: 0 },
    } } })
    // Allocate, but deliberately never deliver, the disconnected execution's start.
    harness.lifecycle("started")
    reads.armed = true
    await harness.reconnect()
    await requested.promise
    await barrier.promise
    expect(harness.data.shell.get("reconnect-barrier-shell")).toBeUndefined()
    expect(harness.data.session.status("root")).toBe("idle")
    const beforeRecovery = reads.statuses
    using recovered = createRoot((dispose) => {
      const ready = Promise.withResolvers<void>()
      createComputed(() => {
        // Observe an unrelated marker so root recovery remains a hard assertion.
        if (harness.data.session.status("other") === "running") ready.resolve()
      })
      return { ready: ready.promise, [Symbol.dispose]: dispose }
    })
    response.resolve(json({ data: { root: { type: "running" }, other: { type: "running" } } }))
    await recovered.ready
    expect(harness.data.session.status("root")).toBe("running")
    expect(reads.statuses).toBeGreaterThan(beforeRecovery)
    expect(harness.requests().map((request) => request.type)).toEqual(["done"])
    // No intervening lifecycle calls may synchronize the recovered root.
    const terminal = harness.lifecycle(outcome)
    await harness.send(terminal)
    expect(harness.requests().map((request) => request.type)).toEqual(["done", outcome === "succeeded" ? "done" : "error"])
    expect(harness.toasts).toHaveLength(outcome === "failed" ? 1 : 0)
    if (outcome === "failed") expect(harness.toasts[0]).toMatchObject({ title: "Session failed", message: "PRIVATE FAILURE", variant: "error" })
    await harness.send(terminal, harness.lifecycle(outcome))
    expect(harness.requests()).toHaveLength(2)
    expect(harness.toasts).toHaveLength(outcome === "failed" ? 1 : 0)
    await harness.stopNotifications()
    const afterDispose = reads.statuses
    harness.data.session.setStatus("root", "running")
    harness.data.session.setStatus("root", "idle")
    expect(reads.statuses).toBe(afterDispose)
    await harness.send(harness.lifecycle("started"), harness.lifecycle("failed"))
    expect(harness.requests()).toHaveLength(2)
    expect(harness.toasts).toHaveLength(outcome === "failed" ? 1 : 0)
    expect(JSON.stringify(harness.logs.filter((log) => log.tags.component === "attention"))).not.toContain("PRIVATE")
  } finally {
    response.resolve(json({ data: {} }))
  }
})
