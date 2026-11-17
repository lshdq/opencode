import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { createRoot, onCleanup } from "solid-js"
import { ClientProvider, useClient } from "../../src/context/client"
import { LogProvider } from "../../src/context/log"
import { TaskQueueProvider, useTaskQueueOwner } from "../../src/context/task-queue"
import { TuiLifecycleProvider } from "../../src/context/runtime"
import { createTaskQueueEvents } from "../../src/feature-plugins/system/tasks-events"
import { createTaskQueueFeed } from "../../src/feature-plugins/system/tasks-data"
import { directory } from "../fixture/tui-client"
import { sourceSignal, taskQueueSource } from "../fixture/task-queue-source"

test.each(["foreign", "same"] as const)("real authenticated %s stream stays outside the panel's current SDK epoch without filtering the owner", async (mode) => {
  const wire = taskQueueSource(mode)
  const a = Bun.serve({ port: 0, fetch: (request) => wire.a(request) })
  const b = Bun.serve({ port: 0, fetch: (request) => wire.b(request) })
  const initial = Promise.withResolvers<void>()
  const stale = Promise.withResolvers<void>()
  const terminal = Promise.withResolvers<void>()
  const finalizers = new Set<() => Promise<void>>()
  const seen: { title: string; source: string; live: string; currentSDK: boolean }[] = []
  let loads = 0
  const api = OpenCode.make({ baseUrl: a.url.toString(), headers: { authorization: wire.authorization("A1") } })
  const setup = createRoot((dispose) => {
    let panel: { client: ReturnType<typeof useClient>; owner: ReturnType<typeof useTaskQueueOwner>; feed: ReturnType<typeof createTaskQueueFeed> } | undefined
    function Capture() {
      const client = useClient()
      const owner = useTaskQueueOwner()
      const feed = createTaskQueueFeed(() => client.api.experimental.taskQueue)
      const relay = createTaskQueueEvents({ on: client.event.on })
      const detach = relay.attach({ update: feed.update, load() { loads++; return feed.load() } }, client)
      client.event.on("server.connected", () => { initial.resolve() })
      client.event.on("taskqueue.updated", (event) => {
        const source = client.event.source(event)!
        seen.push({ title: event.data.title!, source: source.url === b.url.toString() ? "B" : "A", live: client.url === b.url.toString() ? "B" : "A", currentSDK: source.api === client.api })
        if (event.id === "evt_current_A") terminal.resolve()
        if (event.id === "evt_foreign" || event.id === "evt_old_A") stale.resolve()
      })
      feed.directory(directory)
      onCleanup(() => { detach(); relay.dispose(); feed.dispose() })
      panel = { client, owner, feed }
      return null
    }
    const tree = <LogProvider log={() => {}}><TuiLifecycleProvider value={{ add(run) { finalizers.add(run); return () => { finalizers.delete(run) } } }}><ClientProvider api={api} url={a.url.toString()} service={{
      async reconnect() {
        const next = wire.reconnect(a.url.toString(), b.url.toString())
        return { api: OpenCode.make({ baseUrl: next.url, headers: { authorization: "Basic " + Buffer.from(`${next.auth.username}:${next.auth.password}`).toString("base64") } }), url: next.url }
      }, restart: async () => {},
    }}><TaskQueueProvider><Capture /></TaskQueueProvider></ClientProvider></TuiLifecycleProvider></LogProvider>
    void tree
    if (!panel) throw new Error("Actual panel providers did not mount")
    return { ...panel, dispose }
  })
  try {
    await sourceSignal(initial.promise)
    await setup.owner.acquire("tq_fixture", "start")
    await setup.feed.load()
    const before = setup.feed.items()
    const previousLoads = loads
    wire.migrate()
    await sourceSignal(stale.promise)
    const foreignLoads = loads - previousLoads
    await setup.feed.load()
    const after = setup.feed.items()
    const owned = setup.owner.owns("tq_fixture")
    const loading = setup.feed.loading()
    const error = setup.feed.error() ?? null
    if (mode === "same") {
      await sourceSignal(wire.opened)
      wire.terminal()
      await sourceSignal(terminal.promise)
      expect(setup.feed.items().map((info) => [info.title, info.status, info.tasks[0].sessionID])).toEqual([["A refreshed terminal", "done", "ses_A"]])
    }
    setup.dispose()
    await setup.owner.shutdown()
    await Promise.all([...finalizers].map((run) => run()))
    const evidence = { mode, before: before.map((info) => [info.title, info.status, info.tasks[0].sessionID]), after: after.map((info) => [info.title, info.status, info.tasks[0].sessionID]),
      owned, loading, error, foreignLoads, seen, controls: wire.controls, versions: wire.versions, rejected: wire.rejected, finalizers: finalizers.size }
    console.info("R2A16 actual panel sources", JSON.stringify(evidence))
    expect(evidence.before).toEqual([["A actual running", "running", "ses_A"]])
    expect(evidence.after).toEqual([["A actual running", "running", "ses_A"]])
    expect({ owned, loading, error }).toEqual({ owned: mode === "foreign", loading: false, error: null })
    expect(seen[0]).toEqual({ title: mode === "foreign" ? "B foreign terminal" : "A old terminal", source: mode === "foreign" ? "B" : "A", live: "A", currentSDK: false })
    if (mode === "foreign") expect(foreignLoads).toBe(0)
    if (mode === "same") expect(seen[1]).toEqual({ title: "A refreshed terminal", source: "A", live: "A", currentSDK: true })
    expect({ controls: wire.controls, versions: wire.versions, rejected: wire.rejected, finalizers: finalizers.size }).toEqual({ controls: { A: mode === "foreign" ? ["start", "stop"] : ["start"], B: [] }, versions: mode === "foreign" ? [1, 2] : [1], rejected: [], finalizers: 0 })
  } finally {
    setup.dispose()
    await setup.owner.shutdown()
    await Promise.all([...finalizers].map((run) => run()))
    wire.dispose()
    await Promise.all([a.stop(true), b.stop(true)])
  }
})
