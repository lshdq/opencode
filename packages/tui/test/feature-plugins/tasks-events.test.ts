import { expect, test } from "bun:test"
import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createTaskQueueEvents } from "../../src/feature-plugins/system/tasks-events"
import { taskQueue } from "../fixture/task-queue"

function subscriptions() {
  const emitter = createGlobalEmitter<{ [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }>()
  const archived: Array<() => void> = []
  const active = new Set<() => void>()
  const api = OpenCode.make({ baseUrl: "http://events.fixture" })
  const sources = new WeakMap<OpenCodeEvent, { api: OpenCodeClient }>()
  const emit = (type: OpenCodeEvent["type"], event: OpenCodeEvent) => {
    sources.set(event, { api })
    emitter.emit(type, event)
  }
  const client = { api, event: { on: emitter.on, listen: emitter.listen, source: (event: OpenCodeEvent) => sources.get(event) } }
  // Match the host's archive ownership, using the real emitter's bound off functions.
  const on: Plugin.Context["data"]["on"] = (type, handler) => {
    const off = emitter.on(type, handler)
    const stop = () => { active.delete(stop); off() }
    active.add(stop)
    archived.push(stop)
    return stop
  }
  return { emitter: { ...emitter, emit }, client, archived, active, events: createTaskQueueEvents({ on }) }
}

test("reopening panels never grows activation archives or live subscriptions", () => {
  const setup = subscriptions()
  let updates = 0
  let loads = 0
  try {
    for (const _ of Array.from({ length: 100 })) {
      const detach = setup.events.attach({ update: () => { updates++ }, load: async () => { loads++ } }, setup.client)
      setup.emitter.emit("taskqueue.updated", { id: "evt_panel", created: 1, type: "taskqueue.updated", data: taskQueue() })
      setup.emitter.emit("server.connected", { id: "evt_connected", type: "server.connected", data: {} })
      detach()
      expect(setup.archived).toHaveLength(2)
      expect(setup.active.size).toBe(2)
    }
    expect(updates).toBe(100)
    expect(loads).toBe(100)
    setup.emitter.emit("taskqueue.updated", { id: "evt_closed", created: 2, type: "taskqueue.updated", data: taskQueue() })
    expect(updates).toBe(100)
  } finally {
    setup.events.dispose()
  }
  expect(setup.active.size).toBe(0)
  expect(setup.archived).toHaveLength(2)
})

test("old panel detach cannot remove a replacement, and plugin disposal severs the current panel", () => {
  const setup = subscriptions()
  const delivered: string[] = []
  const old = setup.events.attach({ update: () => { delivered.push("old") }, load: async () => {} }, setup.client)
  setup.events.attach({ update: () => { delivered.push("new") }, load: async () => {} }, setup.client)
  old()
  setup.emitter.emit("taskqueue.updated", { id: "evt_new", created: 1, type: "taskqueue.updated", data: taskQueue() })
  expect(delivered).toEqual(["new"])
  setup.events.dispose()
  setup.events.dispose()
  setup.events.attach({ update: () => { delivered.push("disposed") }, load: async () => {} }, setup.client)
  setup.emitter.emit("taskqueue.updated", { id: "evt_disposed", created: 2, type: "taskqueue.updated", data: taskQueue() })
  expect(delivered).toEqual(["new"])
  expect(setup.active.size).toBe(0)
  expect(setup.archived).toHaveLength(2)
})

test("panel source filtering follows the live resource epoch and rejects unknown, old credentials, path and query sources", () => {
  const emitter = createGlobalEmitter<{ [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }>()
  const sources = new WeakMap<OpenCodeEvent, { api: OpenCodeClient }>()
  const old = OpenCode.make({ baseUrl: "http://panel.fixture/a?tenant=1" })
  const refreshed = OpenCode.make({ baseUrl: "http://panel.fixture/a?tenant=1" })
  const path = OpenCode.make({ baseUrl: "http://panel.fixture/b?tenant=1" })
  const query = OpenCode.make({ baseUrl: "http://panel.fixture/a?tenant=2" })
  let api = old
  const client = { get api() { return api }, event: { ...emitter, source: (event: OpenCodeEvent) => sources.get(event) } }
  const relay = createTaskQueueEvents({ on: emitter.on })
  const updates: string[] = []
  let loads = 0
  const detach = relay.attach({ update: (info) => { updates.push(info.title!) }, load: async () => { loads++ } }, client)
  const emit = (title: string, source?: OpenCodeClient) => {
    const update = { id: "evt_source", created: 1, type: "taskqueue.updated", data: taskQueue({ title }) } as const
    const connected = { id: "evt_source_connected", type: "server.connected", data: {} } as const
    if (source) { sources.set(update, { api: source }); sources.set(connected, { api: source }) }
    emitter.emit(update.type, update)
    emitter.emit(connected.type, connected)
  }
  try {
    emit("old current", old)
    api = refreshed
    emit("unknown")
    emit("old credentials", old)
    emit("other path", path)
    emit("other query", query)
    // Source URL is deliberately absent: exact known SDK identity is sufficient.
    emit("refreshed current", refreshed)
    expect(updates).toEqual(["old current", "refreshed current"])
    expect(loads).toBe(2)
  } finally { detach(); relay.dispose() }
})
