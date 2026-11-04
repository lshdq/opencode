import { describe, expect, test } from "bun:test"
import type { AttentionNotifyOptions, Context, Data } from "@opencode/plugin/tui/context"
import type { OpenCodeEvent } from "@opencode/client"
import { createTuiAttention } from "../src/attention"
import { createPluginContext, type Registry, type usePluginHost } from "../src/plugin/api"
import type { LogTags } from "../src/context/log"

type Audio = NonNullable<Parameters<typeof createTuiAttention>[0]["audio"]>
type Sound = NonNullable<Awaited<ReturnType<Audio["loadSoundFile"]>>>
type Voice = NonNullable<ReturnType<Audio["play"]>>

function setup() {
  const logs: LogTags[] = []
  const handlers = new Map<string, Set<(event: OpenCodeEvent) => void>>()
  const focus = new Map<string, () => void>()
  const sessions: { id: string; parentID?: string }[] = [
    { id: "root" }, { id: "child", parentID: "root" }, { id: "nested", parentID: "child" }, { id: "other" },
  ]
  const running = new Set<string>()
  const shells: { id: string; status: string; metadata: { sessionID: string } }[] = []
  const pending = new Map<string, { id: string }[]>()
  const data = {
    on(type: string, handler: (event: OpenCodeEvent) => void) {
      const list = handlers.get(type) ?? new Set()
      list.add(handler)
      handlers.set(type, list)
      return () => list.delete(handler)
    },
    session: {
      list: () => sessions,
      get: (id: string) => sessions.find((session) => session.id === id),
      family: () => ["root", "child", "nested"],
      status: (id: string) => running.has(id) ? "running" : "idle",
      pending: { list: (id: string) => pending.get(id) ?? [] },
    },
    shell: {
      list: () => shells,
      listBySession: (id: string) => shells.filter((shell) => shell.metadata.sessionID === id),
    },
  } as unknown as Data
  const renderer = {
    isDestroyed: false,
    on: (event: string, listener: () => void) => focus.set(event, listener),
    off: (event: string) => focus.delete(event),
    triggerNotification: (_message: string, _title?: string) => true,
  }
  const audio: Audio = {
    loadSoundFile: async () => ({} as Sound),
    play: () => ({} as Voice),
  }
  const config = { attention: { notifications: true, sound: true, volume: 0.5, sound_pack: "default", sounds: {} } }
  const attention = createTuiAttention({ renderer, audio, config, data, log: (_message, tags) => logs.push(tags) })
  return {
    attention, logs, data, renderer, audio, config, sessions, running, shells, pending,
    focus: (state: "focus" | "blur") => focus.get(state)?.(),
    emit: (event: OpenCodeEvent) => handlers.get(event.type)?.forEach((handler) => handler(event)),
    result: () => logs.findLast((log) => log.phase === "result"),
  }
}

const request: AttentionNotifyOptions = {
  title: "PRIVATE TITLE", message: "PRIVATE MESSAGE",
  diagnostic: { type: "done", reason: "session.execution.succeeded", eventID: "evt-success", sessionID: "root" },
}

describe("TUI attention diagnostics", () => {
  test("records accepted API calls without promising OS visibility or exposing content", async () => {
    const harness = setup()
    harness.focus("blur")
    const result = await harness.attention.notify(request)
    expect(result).toEqual({ ok: true, notification: true, sound: true })
    expect(harness.logs[0]).toMatchObject({
      component: "attention", phase: "request", type: "done", reason: "session.execution.succeeded",
      eventID: "evt-success", sessionID: "root", rootSessionID: "root", pluginID: "tui", focus: "blurred",
      deliveryGuarantee: "api_result_only", statisticsComplete: false,
    })
    expect(harness.result()).toMatchObject({ phase: "result", notificationOutcome: "api_accepted", soundOutcome: "playback_started", ...result })
    expect(JSON.stringify(harness.logs)).not.toContain("PRIVATE")
    harness.attention.dispose()
  })

  test.each([
    ["disabled", "attention_disabled"], ["destroyed", "renderer_destroyed"], ["empty", "empty_message"],
    ["unknown", "focus_unknown"], ["focused", "focused"], ["blurred", "blurred"],
  ] as const)("records %s requests and their skip result", async (scenario, reason) => {
    const harness = setup()
    if (scenario === "disabled") Object.assign(harness.config.attention, { notifications: false, sound: false })
    if (scenario === "destroyed") harness.renderer.isDestroyed = true
    if (scenario === "focused") harness.focus("focus")
    if (scenario === "blurred") harness.focus("blur")
    const result = await harness.attention.notify({
      ...request,
      message: scenario === "empty" ? "\u001b[31m\r\n" : request.message,
      sound: false,
      notification: { when: scenario === "blurred" ? "focused" : "blurred" },
    })
    expect(result).toEqual({ ok: false, notification: false, sound: false, skipped: reason })
    expect(harness.logs[0]?.phase).toBe("request")
    expect(harness.result()).toMatchObject({ phase: "result", skipped: reason, ok: false })
    harness.attention.dispose()
  })

  test.each(["api_rejected", "exception"] as const)("records notification %s separately from successful sound", async (outcome) => {
    const harness = setup()
    harness.focus("blur")
    harness.renderer.triggerNotification = () => {
      if (outcome === "exception") throw new Error("PRIVATE EXCEPTION")
      return false
    }
    expect(await harness.attention.notify(request)).toEqual({ ok: true, notification: false, sound: true })
    expect(harness.result()).toMatchObject({ notificationOutcome: outcome, soundOutcome: "playback_started" })
    expect(JSON.stringify(harness.logs)).not.toContain("PRIVATE")
    harness.attention.dispose()
  })

  test.each(["load_exception", "load_null", "play_exception", "play_null"] as const)("records sound failure %s without exception text or file paths", async (scenario) => {
    const harness = setup()
    harness.focus("blur")
    if (scenario === "load_exception") harness.audio.loadSoundFile = async () => { throw new Error("PRIVATE FILE") }
    if (scenario === "load_null") harness.audio.loadSoundFile = async () => null
    if (scenario === "play_exception") harness.audio.play = () => { throw new Error("PRIVATE DEVICE") }
    if (scenario === "play_null") harness.audio.play = () => null
    expect(await harness.attention.notify(request)).toEqual({ ok: true, notification: true, sound: false })
    expect(harness.result()).toMatchObject({ notificationOutcome: "api_accepted", soundOutcome: scenario === "play_exception" ? "exception" : "unavailable" })
    if (scenario === "load_exception") expect(harness.logs).toContainEqual(expect.objectContaining({ phase: "sound_load", outcome: "exception" }))
    if (scenario === "play_null") expect(harness.logs).toContainEqual(expect.objectContaining({ phase: "sound_play", outcome: "api_rejected" }))
    expect(JSON.stringify(harness.logs)).not.toContain("PRIVATE")
    harness.attention.dispose()
  })

  test("retains config and per-request channel disable outcomes and sound-only focus skips", async () => {
    const harness = setup()
    harness.config.attention.notifications = false
    await harness.attention.notify({ ...request, sound: { when: "blurred" } })
    expect(harness.result()).toMatchObject({ notificationOutcome: "disabled", soundOutcome: "focus_unknown", skipped: "focus_unknown" })
    await harness.attention.notify({ ...request, notification: false, sound: false })
    expect(harness.result()).toMatchObject({ notificationOutcome: "disabled", soundOutcome: "not_requested", ok: false })
    harness.config.attention.notifications = true
    harness.config.attention.sound = false
    await harness.attention.notify({ ...request, notification: false })
    expect(harness.result()).toMatchObject({ notificationOutcome: "not_requested", soundOutcome: "disabled" })
    harness.attention.dispose()
  })

  test("TC-005: root-family snapshot deduplicates observations/caches and stays fixed across async audio", async () => {
    const harness = setup()
    harness.focus("blur")
    harness.running.add("child")
    harness.running.add("nested")
    harness.running.add("other")
    harness.shells.push(
      { id: "shell-1", status: "running", metadata: { sessionID: "nested" } },
      { id: "shell-1", status: "running", metadata: { sessionID: "nested" } },
      { id: "shell-other", status: "running", metadata: { sessionID: "other" } },
    )
    harness.pending.set("root", [{ id: "input-1" }])
    harness.pending.set("child", [{ id: "input-1" }, { id: "input-2" }])
    harness.emit({ type: "shell.created", id: "evt-shell", created: 0, location: { directory: "/PRIVATE LOCATION" }, data: {
      info: { id: "shell-1", status: "running", metadata: { sessionID: "nested" }, command: "PRIVATE COMMAND",
        cwd: "/private", shell: "sh", file: "/private/log", time: { started: 0 } },
    } })
    let release: (sound: Sound) => void = () => { throw new Error("not registered") }
    harness.audio.loadSoundFile = () => new Promise((resolve) => { release = resolve })
    const task = harness.attention.notify({ ...request, diagnostic: { ...request.diagnostic, sessionID: "nested" } })
    expect(harness.logs[0]).toMatchObject({ rootSessionID: "root", runningSubagents: 2, runningShells: 1, pendingCount: 2, focus: "blurred" })
    harness.running.clear()
    harness.shells.length = 0
    harness.pending.clear()
    harness.focus("focus")
    release({} as Sound)
    await task
    expect(harness.result()).toMatchObject({ runningSubagents: 2, runningShells: 1, pendingCount: 2, focus: "blurred" })
    expect(JSON.stringify(harness.logs)).not.toContain("PRIVATE")
    harness.attention.dispose()
  })

  test("marks unassociated, unloaded and empty-cache counts unknown rather than zero", async () => {
    const harness = setup()
    await harness.attention.notify({ message: "hi", sound: false })
    expect(harness.result()).toMatchObject({ type: "unknown", reason: "unknown", sessionID: null, rootSessionID: null, runningSubagents: null, runningShells: null, pendingCount: null, statisticsScope: "unassociated" })
    await harness.attention.notify({ ...request, diagnostic: { sessionID: "missing" } })
    expect(harness.result()).toMatchObject({ rootSessionID: null, statisticsScope: "root_unresolved" })
    await harness.attention.notify(request)
    expect(harness.result()).toMatchObject({ rootSessionID: "root", runningSubagents: null, runningShells: null, pendingCount: null, statisticsEmptyIsUnknown: true })
    harness.attention.dispose()
  })

  test("missing data and the legacy shell lookup explicitly identify their statistical scope", async () => {
    const harness = setup()
    const attention = createTuiAttention({ renderer: harness.renderer, config: harness.config, audio: harness.audio,
      log: (_message, tags) => harness.logs.push(tags) })
    await attention.notify(request)
    expect(harness.result()).toMatchObject({ statisticsScope: "data_unavailable", rootSessionID: null, runningShells: null })
    attention.dispose()
    delete harness.data.shell.listBySession
    harness.shells.push({ id: "fallback", status: "running", metadata: { sessionID: "nested" } })
    await harness.attention.notify(request)
    expect(harness.result()).toMatchObject({ statisticsScope: "known_root_family_default_location_and_observed_events", runningShells: 1 })
    harness.attention.dispose()
  })

  test("observed nested work survives delayed ancestry hydration and deleted shell owners", async () => {
    const harness = setup()
    harness.emit({ type: "shell.created", id: "shell-start", created: 0, location: { directory: "/other" }, data: {
      info: { id: "observed", status: "running", metadata: { sessionID: "late" }, command: "private",
        cwd: "/private", shell: "sh", file: "/private/log", time: { started: 0 } },
    } })
    harness.emit({ type: "session.created", id: "late-created", created: 0, durable: { aggregateID: "late", seq: 1, version: 1 },
      data: { sessionID: "late", parentID: "child", projectID: "project", location: { directory: "/other" }, slug: "late", version: "1" } })
    await harness.attention.notify(request)
    expect(harness.result()).toMatchObject({ runningShells: 1, rootSessionID: "root" })
    harness.emit({ type: "session.deleted", id: "child-deleted", created: 0, durable: { aggregateID: "child", seq: 2, version: 2 }, data: { sessionID: "child" } })
    harness.sessions.splice(harness.sessions.findIndex((session) => session.id === "child"), 1)
    await harness.attention.notify(request)
    expect(harness.result()?.runningShells).toBe(1)
    harness.emit({ type: "shell.exited", id: "shell-ended", created: 0, data: { id: "observed", status: "exited", exit: 0 } })
    await harness.attention.notify(request)
    expect(harness.result()?.runningShells).toBeNull()
    harness.attention.dispose()
  })

  test("TC-005/006: stale observation cannot override a newer idle child snapshot", async () => {
    const harness = setup()
    try {
      const old: OpenCodeEvent = { id: "evt_old-start", created: 1, type: "session.execution.started",
        durable: { aggregateID: "child", seq: 1, version: 1 }, data: { sessionID: "child" } }
      harness.emit(old)
      harness.emit({ id: "evt_newer-success", created: 2, type: "session.execution.succeeded",
        durable: { aggregateID: "child", seq: 2, version: 1 }, data: { sessionID: "child" } })
      harness.emit(old)
      // The cache remains idle and the newer terminal was already observed.
      await harness.attention.notify(request)
      expect(harness.result()).toMatchObject({ runningSubagents: null, statisticsComplete: false })
    } finally {
      harness.attention.dispose()
    }
  })

  test("old terminal observations cannot hide a newer running child or block its fresh end", async () => {
    const harness = setup()
    try {
      const old: OpenCodeEvent = { id: "evt_old-success", created: 1, type: "session.execution.succeeded",
        durable: { aggregateID: "child", seq: 1, version: 1 }, data: { sessionID: "child" } }
      harness.emit(old)
      harness.emit({ id: "evt_new-start", created: 2, type: "session.execution.started",
        durable: { aggregateID: "child", seq: 2, version: 1 }, data: { sessionID: "child" } })
      harness.emit(old)
      await harness.attention.notify(request)
      expect(harness.result()?.runningSubagents).toBe(1)
      harness.emit({ id: "evt_fresh-success", created: 3, type: "session.execution.succeeded",
        durable: { aggregateID: "child", seq: 3, version: 1 }, data: { sessionID: "child" } })
      await harness.attention.notify(request)
      expect(harness.result()?.runningSubagents).toBeNull()
    } finally {
      harness.attention.dispose()
    }
  })

  test("deleted children cannot return through lifecycle observations or stale cached running state", async () => {
    const harness = setup()
    try {
      harness.emit({ id: "evt_child-start", created: 1, type: "session.execution.started",
        durable: { aggregateID: "child", seq: 1, version: 1 }, data: { sessionID: "child" } })
      harness.emit({ id: "evt_child-delete", created: 2, type: "session.deleted",
        durable: { aggregateID: "child", seq: 2, version: 2 }, data: { sessionID: "child" } })
      harness.running.add("child")
      harness.emit({ id: "evt_late-start", created: 3, type: "session.execution.started",
        durable: { aggregateID: "child", seq: 3, version: 1 }, data: { sessionID: "child" } })
      await harness.attention.notify(request)
      expect(harness.result()?.runningSubagents).toBeNull()
      harness.emit({ id: "evt_child-create", created: 4, type: "session.created",
        durable: { aggregateID: "child", seq: 4, version: 1 }, data: { sessionID: "child", parentID: "root",
          projectID: "project", location: { directory: "/project" }, slug: "child", version: "1" } })
      harness.emit({ id: "evt_child-fresh-start", created: 5, type: "session.execution.started",
        durable: { aggregateID: "child", seq: 5, version: 1 }, data: { sessionID: "child" } })
      await harness.attention.notify(request)
      expect(harness.result()?.runningSubagents).toBe(1)
    } finally {
      harness.attention.dispose()
    }
  })

  test.each([
    ["started", false, null],
    ["succeeded", true, 1],
  ] as const)("reconnect recovers the cache after observed %s without accepting old replay", async (type, recoveredRunning, count) => {
    const harness = setup()
    try {
      harness.emit({ id: "evt_before-connect", created: 2, type: `session.execution.${type}`,
        durable: { aggregateID: "child", seq: 2, version: 1 }, data: { sessionID: "child" } })
      harness.emit({ id: "connected", type: "server.connected", data: {} })
      if (recoveredRunning) harness.running.add("child")
      harness.emit({ id: "evt_replayed", created: 1, type: `session.execution.${type}`,
        durable: { aggregateID: "child", seq: 1, version: 1 }, data: { sessionID: "child" } })
      await harness.attention.notify(request)
      expect(harness.result()?.runningSubagents).toBe(count)
    } finally {
      harness.attention.dispose()
    }
  })

  test.each([
    ["dotted ID", "third.party", "third.party"],
    ["scoped npm ID", "@acme/notify", "@acme/notify"],
    ["printable Unicode and logfmt punctuation", '通知 插件+notify=primary"\\', '通知 插件+notify=primary"\\'],
    ["control characters", "notify\u0000\u001b\r\n\u0085\u2028\u202e", "notify\\u{0}\\u{1b}\\u{d}\\u{a}\\u{85}\\u{2028}\\u{202e}"],
    ["bounded long ID", "p".repeat(181), `${"p".repeat(180)}…`],
    ["bounded control expansion", "\u001b".repeat(181), `${"\\u{1b}".repeat(180)}…`],
  ])("plugin adapter preserves %s host source and filters unsafe metadata", async (_label, id, source) => {
    const harness = setup()
    const host = {
      app: { version: "test", channel: "test" }, client: { api: {} }, keymap: {}, shortcuts: {}, keymapState: {},
      sessionTabs: {}, attention: harness.attention, data: harness.data,
    } as unknown as ReturnType<typeof usePluginHost>
    const registry: Registry = { has: () => false, set() {}, remove() {}, active: () => true }
    const context: Context = createPluginContext({ host, id, options: undefined, owned: [], registry })
    await context.attention.notify({ message: "PRIVATE BODY", title: "PRIVATE TITLE", sound: false })
    expect(harness.logs.filter((log) => log.phase === "request" || log.phase === "result").map((log) => ({
      phase: log.phase, pluginID: log.pluginID, type: log.type, reason: log.reason,
    }))).toEqual([
      { phase: "request", pluginID: source, type: "unknown", reason: "unknown" },
      { phase: "result", pluginID: source, type: "unknown", reason: "unknown" },
    ])
    await context.attention.notify({ ...request, diagnostic: {
      type: "PRIVATE TYPE", reason: "PRIVATE REASON", eventID: "PRIVATE ID WITH SPACES", sessionID: "../PRIVATE PATH", pluginID: "spoofed", text: "PRIVATE EXTRA",
    } } as unknown as AttentionNotifyOptions)
    expect(harness.logs.filter((log) => log.requestID === 2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "request", pluginID: source, type: "unknown", reason: "unknown", eventID: null, sessionID: null }),
      expect.objectContaining({ phase: "result", pluginID: source, type: "unknown", reason: "unknown", eventID: null, sessionID: null }),
    ]))
    await context.attention.notify({ ...request, diagnostic: { eventID: "@acme/event", sessionID: "@acme/session" } })
    expect(harness.result()).toMatchObject({ pluginID: source, eventID: null, sessionID: null })
    expect(harness.logs.every((log) => log.pluginID === source)).toBe(true)
    expect(JSON.stringify(harness.logs)).not.toContain("PRIVATE")
    expect(JSON.stringify(harness.logs)).not.toContain("spoofed")
    harness.attention.dispose()
  })

  test.each(["disposed", "destroyed"] as const)("%s during audio loading cancels playback but preserves the original snapshot", async (scenario) => {
    const harness = setup()
    harness.focus("blur")
    let release: (sound: Sound) => void = () => { throw new Error("not registered") }
    harness.audio.loadSoundFile = () => new Promise((resolve) => { release = resolve })
    let played = false
    harness.audio.play = () => { played = true; return {} as Voice }
    const task = harness.attention.notify({ ...request, notification: false })
    if (scenario === "disposed") harness.attention.dispose()
    if (scenario === "destroyed") harness.renderer.isDestroyed = true
    release({} as Sound)
    expect(await task).toEqual({ ok: false, notification: false, sound: false })
    expect(played).toBe(false)
    expect(harness.result()).toMatchObject({ soundOutcome: "renderer_destroyed", focus: "blurred" })
    await harness.attention.notify(request)
    expect(harness.result()?.skipped).toBe("renderer_destroyed")
    harness.attention.dispose()
  })

  test("custom sound failure falls back to built-in audio without logging the selected path", async () => {
    const harness = setup()
    Object.assign(harness.config.attention.sounds, { done: "PRIVATE SOUND PATH" })
    let loads = 0
    harness.audio.loadSoundFile = async () => ++loads === 1 ? null : {} as Sound
    expect((await harness.attention.notify({ ...request, sound: { name: "done" } })).sound).toBe(true)
    expect(loads).toBe(2)
    expect(harness.logs).toContainEqual(expect.objectContaining({ phase: "sound_load", outcome: "unavailable", attempt: 0 }))
    expect(harness.result()?.soundOutcome).toBe("playback_started")
    expect(JSON.stringify(harness.logs)).not.toContain("PRIVATE")
    harness.attention.dispose()
  })

  test("logging and snapshot failures never break notification delivery", async () => {
    const harness = setup()
    harness.data.session.list = () => { throw new Error("PRIVATE SNAPSHOT") }
    await harness.attention.notify({ ...request, notification: { when: "always" } })
    expect(harness.result()).toMatchObject({ statisticsScope: "snapshot_unavailable", notification: true, sound: true })
    const attention = createTuiAttention({ renderer: harness.renderer, config: harness.config, audio: harness.audio, log() { throw new Error("PRIVATE LOG") } })
    expect(await attention.notify({ message: "hi", notification: { when: "always" } })).toEqual({ ok: true, notification: true, sound: true })
    attention.dispose()
    harness.attention.dispose()
  })

  test.each([{ ...request, message: 123 }, null])("unexpected handling exceptions still yield sanitized request and result records (%j)", async (input) => {
    const harness = setup()
    expect(await harness.attention.notify(input as unknown as AttentionNotifyOptions))
      .toEqual({ ok: false, notification: false, sound: false })
    expect(harness.logs.map((log) => log.phase)).toEqual(["request", "exception", "result"])
    expect(harness.result()).toMatchObject({ ok: false, notificationOutcome: "not_attempted", soundOutcome: "not_attempted" })
    harness.attention.dispose()
  })
})
