import { describe, expect, test } from "bun:test"
import Notifications from "../../../../src/feature-plugins/system/notifications"
import type { OpenCodeEvent, PermissionAsked } from "@opencode/client"
import type { AttentionNotifyOptions, Context, Route, ToastOptions } from "@opencode/plugin/tui/context"

type Session = { id: string; title?: string; parentID?: string }

async function setup(
  route: Route = { type: "session", sessionID: "session" },
  initialStatuses: Partial<Record<string, "idle" | "running">> = {},
  temporarilyHiddenSessions: string[] = [],
  withListBySession = true,
  childrenToHydrate: Record<string, string[]> = {},
  blockReconnect = false,
) {
  const notifications: AttentionNotifyOptions[] = []
  const toasts: ToastOptions[] = []
  const handlers = new Map<OpenCodeEvent["type"], ((event: OpenCodeEvent) => void)[]>()
  const hiddenFamilies = new Set<string>()
  const hiddenSessions = new Set(temporarilyHiddenSessions)
  const session = (id: string, title?: string, parentID?: string): Session => ({
    id,
    ...(title && { title }),
    ...(parentID && { parentID }),
  })
  const sessions: Record<string, Session> = {
    session: session("session", "Demo session"),
    subagent: session("subagent", "Subagent session", "session"),
    subagent2: session("subagent2", "Second subagent session", "session"),
    nested: session("nested", "Nested subagent session", "subagent"),
    abort: session("abort", "Abort session"),
    timeout: session("timeout", "Timeout session"),
  }
  const shells: Record<
    string,
    { id: string; status: "running" | "exited"; metadata: { sessionID: string }; location: { directory: string }
  }
  > = {}
  const staleShells = new Set<string>()
  const syncLocations: { directory: string }[] = []
  const invalidatedLocations: { directory: string }[] = []
  const sessionSyncs: { sessionID: string; children?: boolean }[] = []
  const invalidatedSessions: string[] = []
  const operations: string[] = []
  const reconnectWaiters: (() => void)[] = []
  const statuses: Record<string, "idle" | "running"> = Object.fromEntries(Object.keys(sessions).map((id) => [id, "idle"]))
  Object.assign(statuses, initialStatuses)

  const listBySession = (sessionID: string) =>
    Object.values(shells).filter((shell) => shell.metadata.sessionID === sessionID)
  const shellData = {
    list: (location?: { directory: string }) =>
      Object.values(shells).filter((shell) => !location || shell.location.directory === location.directory),
    get: (id: string) => shells[id],
    sync: async (location: { directory: string }) => {
      operations.push(`shell.sync:${location.directory}`)
      syncLocations.push(location)
      for (const shellID of staleShells) {
        if (shells[shellID]?.location.directory !== location.directory) continue
        delete shells[shellID]
        staleShells.delete(shellID)
      }
    },
    invalidate: (location?: { directory: string }) => {
      if (location) {
        operations.push(`shell.invalidate:${location.directory}`)
        invalidatedLocations.push(location)
      }
    },
  }
  const shell = withListBySession ? { ...shellData, listBySession } : shellData

  const cleanup = await Notifications.setup({
    ui: {
      router: { current: () => route },
      toast: { show: (toast: ToastOptions) => toasts.push(toast) },
    },
    location: { directory: "/current" },
    attention: {
      async notify(input: AttentionNotifyOptions) {
        notifications.push(input)
        return { ok: true, notification: true, sound: true }
      },
    },
    data: {
      on: <Type extends OpenCodeEvent["type"]>(
        type: Type,
        handler: (event: Extract<OpenCodeEvent, { type: Type }>) => void,
      ) => {
        const list = handlers.get(type) ?? []
        const wrapped = handler as (event: OpenCodeEvent) => void
        list.push(wrapped)
        handlers.set(type, list)
        return () => {
          handlers.set(
            type,
            (handlers.get(type) ?? []).filter((item) => item !== wrapped),
          )
        }
      },
      session: {
        get: (sessionID: string) => hiddenSessions.has(sessionID) ? undefined : sessions[sessionID],
        family: (sessionID: string) => {
          if (hiddenFamilies.has(sessionID)) return [sessionID]
          return Object.values(sessions)
            .filter((candidate) => !hiddenSessions.has(candidate.id))
            .filter((candidate) => candidate.id === sessionID || candidate.parentID === sessionID)
            .map((candidate) => candidate.id)
        },
        list: () => Object.values(sessions).filter((candidate) => !hiddenSessions.has(candidate.id)),
        status: (sessionID: string) => statuses[sessionID],
        sync: async (sessionID: string, options?: { children?: boolean }) => {
          operations.push(`session.sync:${sessionID}`)
          sessionSyncs.push({ sessionID, children: options?.children })
          if (blockReconnect) await new Promise<void>((resolve) => reconnectWaiters.push(resolve))
          if (!options?.children) return
          for (const childID of childrenToHydrate[sessionID] ?? []) hiddenSessions.delete(childID)
        },
        invalidate: (sessionID: string) => {
          operations.push(`session.invalidate:${sessionID}`)
          invalidatedSessions.push(sessionID)
        },
      },
      shell,
    },
  } as unknown as Context)

  return {
    notifications,
    toasts,
    emit(event: OpenCodeEvent) {
      if (event.type === "session.created") {
        sessions[event.data.sessionID] = session(
          event.data.sessionID,
          sessions[event.data.sessionID]?.title,
          event.data.parentID,
        )
      }
      if (event.type === "session.deleted") delete sessions[event.data.sessionID]
      if (event.type === "shell.created") {
        shells[event.data.info.id] = {
          id: event.data.info.id,
          status: event.data.info.status === "running" ? "running" : "exited",
          metadata: { sessionID: String(event.data.info.metadata.sessionID) },
          location: { directory: event.location?.directory ?? "/current" },
        }
      }
      if (event.type === "shell.exited" || event.type === "shell.deleted") delete shells[event.data.id]
      if (event.type === "session.execution.started") statuses[event.data.sessionID] = "running"
      if (
        event.type === "session.execution.succeeded" ||
        event.type === "session.execution.interrupted" ||
        event.type === "session.execution.failed"
      ) {
        statuses[event.data.sessionID] = "idle"
      }
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
    setStatus(sessionID: string, status: "idle" | "running") {
      statuses[sessionID] = status
    },
    hideFamily(sessionID: string) {
      hiddenFamilies.add(sessionID)
    },
    hideSession(sessionID: string) {
      hiddenSessions.add(sessionID)
    },
    revealSession(sessionID: string) {
      hiddenSessions.delete(sessionID)
    },
    dropShell(shellID: string) {
      staleShells.add(shellID)
    },
    addShell(shellID: string, sessionID: string, directory = "/other") {
      shells[shellID] = {
        id: shellID,
        status: "running",
        metadata: { sessionID },
        location: { directory },
      }
    },
    syncLocations,
    invalidatedLocations,
    sessionSyncs,
    invalidatedSessions,
    operations,
    dispose: async () => cleanup?.(),
    releaseReconnect() {
      reconnectWaiters.splice(0).forEach((resolve) => resolve())
    },
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function form(id: string, sessionID = "session"): Extract<OpenCodeEvent, { type: "form.created" }>["data"]["form"] {
  return {
    id,
    sessionID,
    title: "Input requested",
    fields: [{ key: "authorization", type: "external", url: "https://example.com" }],
  }
}

function permission(id: string, sessionID = "session"): PermissionAsked["data"] {
  return {
    id,
    sessionID,
    action: "edit",
    resources: [],
    metadata: {},
    save: [],
  }
}

function durable(sessionID: string): { aggregateID: string; seq: number; version: 1 } {
  return { aggregateID: sessionID, seq: 0, version: 1 }
}

function executionStarted(id: string, sessionID = "session"): OpenCodeEvent {
  return {
    id,
    created: 0,
    type: "session.execution.started",
    durable: durable(sessionID),
    data: { sessionID },
  }
}

function executionSucceeded(id: string, sessionID = "session"): OpenCodeEvent {
  return {
    id,
    created: 0,
    type: "session.execution.succeeded",
    durable: durable(sessionID),
    data: { sessionID },
  }
}

function executionInterrupted(id: string, sessionID = "session"): OpenCodeEvent {
  return {
    id,
    created: 0,
    type: "session.execution.interrupted",
    durable: durable(sessionID),
    data: { sessionID, reason: "user" },
  }
}

function executionFailed(id: string, sessionID = "session"): OpenCodeEvent {
  return {
    id,
    created: 0,
    type: "session.execution.failed",
    durable: durable(sessionID),
    data: {
      sessionID,
      error: { type: "unknown", message: "boom" },
    },
  }
}

function sessionCreated(id: string, parentID: string): OpenCodeEvent {
  return {
    id,
    created: 0,
    type: "session.created",
    durable: durable(id),
    data: {
      sessionID: id,
      projectID: "project",
      location: { directory: "/tmp/project" },
      parentID,
      slug: id,
      version: "1",
    },
  }
}

function sessionDeleted(id: string, sessionID: string): OpenCodeEvent {
  return {
    id,
    created: 0,
    type: "session.deleted",
    durable: { aggregateID: sessionID, seq: 0, version: 2 },
    data: { sessionID },
  }
}

function shellCreated(id: string, sessionID: string): OpenCodeEvent {
  return shellCreatedAt(id, sessionID, "/current")
}

function shellCreatedAt(id: string, sessionID: string, directory: string): OpenCodeEvent {
  return {
    id,
    created: 0,
    type: "shell.created",
    location: { directory },
    data: {
      info: {
        id,
        status: "running",
        command: "sleep 1",
        cwd: "/tmp/project",
        shell: "sh",
        file: "/tmp/shell.log",
        metadata: { sessionID },
        time: { started: 0 },
      },
    },
  }
}

function shellExited(id: string): OpenCodeEvent {
  return {
    id,
    created: 0,
    type: "shell.exited",
    data: { id, status: "exited", exit: 0 },
  }
}

const formNotification: AttentionNotifyOptions = {
  title: "Input requested",
  message: "Input needs response",
  notification: { when: "blurred" },
  sound: { name: "question", when: "always" },
}

const titledFormNotification: AttentionNotifyOptions = {
  ...formNotification,
  title: "Confirm deployment",
}

const globalFormNotification: AttentionNotifyOptions = {
  ...formNotification,
  title: "demo-mcp is requesting input",
}

const permissionNotification: AttentionNotifyOptions = {
  title: "Demo session",
  message: "Permission needs input",
  notification: { when: "blurred" },
  sound: { name: "permission", when: "always" },
}

describe("internal notifications TUI plugin", () => {
  test("shows execution failures as session-scoped toasts without needing an assistant message", async () => {
    const harness = await setup()
    harness.emit(executionStarted("started"))
    harness.emit(executionFailed("failed"))
    harness.emit(executionFailed("duplicate"))
    expect(harness.toasts).toEqual([
      { sessionID: "session", title: "Session failed", message: "boom", variant: "error" },
    ])
    harness.emit(executionStarted("retry"))
    harness.emit(executionFailed("failed-again"))
    expect(harness.toasts).toHaveLength(2)
  })

  test.each<Route>([{ type: "home" }, { type: "session", sessionID: "other" }])(
    "leaves routing of other sessions' failures to the session-scoped toast (%j)",
    async (route) => {
      const harness = await setup(route)
      harness.emit(executionFailed("failed"))
      expect(harness.toasts).toEqual([
        { sessionID: "session", title: "Session failed", message: "boom", variant: "error" },
      ])
      expect(harness.notifications).toHaveLength(1)
    },
  )

  test("notifies for form and permission requests with blurred notifications and always-on sounds", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      data: { form: { ...form("form-1"), title: "Confirm deployment" } },
    })
    harness.emit({ id: "event-3", created: 0, type: "permission.asked", data: permission("permission-1") })

    expect(harness.notifications).toEqual([titledFormNotification, permissionNotification])
  })

  test("notifies for global forms once the TUI can render them", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      data: { form: { ...form("form-1", "global"), title: "demo-mcp is requesting input" } },
    })

    expect(harness.notifications).toEqual([globalFormNotification])
  })

  test("dedupes pending forms and permissions until they are resolved", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", created: 0, type: "form.created", data: { form: form("form-1") } })
    harness.emit({ id: "event-2", created: 0, type: "form.created", data: { form: form("form-1") } })
    harness.emit({
      id: "event-3",
      created: 0,
      type: "form.cancelled",
      data: { sessionID: "session", id: "form-1" },
    })
    harness.emit({ id: "event-4", created: 0, type: "form.created", data: { form: form("form-1") } })

    harness.emit({ id: "event-9", created: 0, type: "permission.asked", data: permission("permission-1") })
    harness.emit({ id: "event-10", created: 0, type: "permission.asked", data: permission("permission-1") })
    harness.emit({
      id: "event-11",
      created: 0,
      type: "permission.replied",
      data: { sessionID: "session", requestID: "permission-1", reply: "once" },
    })
    harness.emit({ id: "event-12", created: 0, type: "permission.asked", data: permission("permission-1") })

    expect(harness.notifications).toEqual([
      formNotification,
      formNotification,
      permissionNotification,
      permissionNotification,
    ])
  })

  test("notifies for terminal lifecycle events even when attached after execution started", async () => {
    const harness = await setup()

    harness.emit(executionSucceeded("event-1"))
    harness.emit(executionStarted("event-2"))
    harness.emit(executionSucceeded("event-3"))

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("uses sound-only notifications and subagent_done sound for subagent sessions", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      data: { form: { ...form("form-1", "subagent"), title: "Questions" } },
    })
    harness.emit(executionStarted("event-2", "subagent"))
    harness.emit(executionSucceeded("event-3", "subagent"))

    expect(harness.notifications).toEqual([
      {
        title: "Questions",
        message: "Input needs response",
        notification: false,
        sound: { name: "question", when: "always" },
      },
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
    ])
  })

  test("waits for a running subagent before notifying the main session", async () => {
    const harness = await setup()
    harness.emit(executionStarted("event-1", "subagent"))
    harness.emit(executionSucceeded("event-2"))

    expect(harness.notifications).toEqual([])

    harness.emit(executionSucceeded("event-3", "subagent"))
    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("waits for a running background shell before notifying the main session", async () => {
    const harness = await setup()
    harness.emit(shellCreated("shell-created", "session"))
    harness.emit(executionSucceeded("event-1"))

    expect(harness.notifications).toEqual([])

    harness.emit(shellExited("shell-created"))
    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])

    harness.emit(shellExited("shell-created"))
    expect(harness.notifications).toHaveLength(1)
  })

  test("retains observed shell ownership after its child session is deleted", async () => {
    const harness = await setup()
    harness.emit(executionStarted("child-started", "subagent"))
    harness.emit(shellCreated("shell-created", "subagent"))
    harness.emit(executionSucceeded("main-done"))

    expect(harness.notifications).toEqual([])

    harness.emit(sessionDeleted("child-deleted", "subagent"))
    expect(harness.notifications).toEqual([])

    harness.emit(shellExited("shell-created"))
    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("waits for an observed shell in another location", async () => {
    const harness = await setup()
    harness.emit(shellCreatedAt("shell-created", "session", "/other"))
    harness.emit(executionSucceeded("main-done"))

    expect(harness.notifications).toEqual([])

    harness.emit(shellExited("shell-created"))
    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("waits for an unobserved shell found by cross-location session lookup", async () => {
    const harness = await setup()
    harness.addShell("shell-unobserved", "session")
    harness.emit(executionSucceeded("main-done"))

    expect(harness.notifications).toEqual([])

    harness.emit(shellExited("shell-unobserved"))
    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("falls back to the current-location shell snapshot when listBySession is unavailable", async () => {
    const harness = await setup({ type: "session", sessionID: "session" }, {}, [], false)
    harness.addShell("shell-current", "session", "/current")
    harness.emit(executionSucceeded("main-done"))

    expect(harness.notifications).toEqual([])

    harness.emit(shellExited("shell-current"))
    expect(harness.notifications).toHaveLength(1)
  })

  test("rechecks observed shells after reconnect when the exit event was missed", async () => {
    const harness = await setup()
    harness.emit(shellCreatedAt("shell-created", "session", "/other"))
    harness.emit(executionSucceeded("main-done"))

    expect(harness.notifications).toEqual([])

    harness.dropShell("shell-created")
    harness.emit({ id: "connected", type: "server.connected", data: {} })
    await settle()
    expect(harness.syncLocations).toEqual([{ directory: "/other" }])
    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("does not notify after disposal while the reconnect barrier is pending", async () => {
    const harness = await setup({ type: "session", sessionID: "session" }, {}, [], true, {}, true)

    harness.emit({ id: "connected", type: "server.connected", data: {} })
    harness.emit(executionSucceeded("done"))
    expect(harness.notifications).toEqual([])

    await harness.dispose()
    harness.releaseReconnect()
    await settle()
    expect(harness.notifications).toEqual([])
  })

  test("queues every execution lifecycle event across reconnect and defers the parent behind its child", async () => {
    const harness = await setup({ type: "session", sessionID: "session" }, {}, [], true, {}, true)
    harness.emit(shellCreated("shell-created", "session"))
    harness.dropShell("shell-created")
    harness.emit({ id: "connected", type: "server.connected", data: {} })
    harness.emit(executionStarted("child-started", "subagent"))
    harness.emit(executionSucceeded("parent-done", "session"))
    harness.emit(executionSucceeded("child-done", "subagent"))
    await settle()

    expect(harness.notifications).toEqual([])
    const firstSync = harness.operations.findIndex((operation) => operation.includes(".sync:"))
    expect(firstSync).toBeGreaterThanOrEqual(0)
    expect(harness.operations.slice(0, firstSync).every((operation) => operation.includes(".invalidate:"))).toBe(true)

    harness.releaseReconnect()
    await settle()
    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])

    harness.emit(executionSucceeded("parent-duplicate", "session"))
    harness.emit(executionSucceeded("child-duplicate", "subagent"))
    expect(harness.notifications).toHaveLength(2)
  })

  test("hydrates known children before reconnect releases deferred background work", async () => {
    const harness = await setup(
      { type: "session", sessionID: "session" },
      { subagent: "running" },
      ["subagent"],
      true,
      { session: ["subagent"] },
    )
    harness.emit(sessionCreated("subagent", "session"))
    harness.emit(shellCreated("shell-created", "subagent"))
    harness.emit(executionSucceeded("main-done"))
    expect(harness.notifications).toEqual([])

    harness.dropShell("shell-created")
    harness.emit({ id: "connected", type: "server.connected", data: {} })
    await settle()
    expect(harness.sessionSyncs).toContainEqual({ sessionID: "session", children: true })
    expect(harness.notifications).toEqual([])

    harness.setStatus("subagent", "idle")
    harness.emit(executionSucceeded("subagent-done", "subagent"))
    expect(harness.notifications).toHaveLength(2)
  })

  test("refreshes observed shell ancestors after delayed session hydration", async () => {
    const harness = await setup()
    harness.emit(shellCreatedAt("shell-created", "late-nested", "/other"))
    harness.emit(sessionCreated("late-nested", "late-parent"))
    harness.emit(sessionCreated("late-parent", "session"))
    harness.emit(executionSucceeded("main-done"))

    expect(harness.notifications).toEqual([])

    harness.dropShell("shell-created")
    harness.emit({ id: "connected", type: "server.connected", data: {} })
    await settle()
    expect(harness.notifications).toHaveLength(1)
  })

  test("TC-006: restores a subagent after reconnect when its next execution has no started event", async () => {
    const harness = await setup()
    harness.emit(executionSucceeded("event-1", "subagent"))
    harness.setStatus("subagent", "running")
    harness.emit(executionSucceeded("event-2"))

    expect(harness.notifications).toHaveLength(1)
    expect(harness.notifications[0]).toEqual({
      title: "Subagent session",
      message: "Session done",
      notification: false,
      sound: { name: "subagent_done", when: "always" },
    })

    harness.emit(executionSucceeded("event-3", "subagent"))
    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("clears a deferred completion when reconnect restores the session as running", async () => {
    const harness = await setup({ type: "session", sessionID: "session" }, { subagent: "running" })
    harness.emit(executionSucceeded("old-main-done"))
    expect(harness.notifications).toEqual([])

    harness.setStatus("subagent", "idle")
    harness.setStatus("session", "running")
    harness.emit({ id: "connected", type: "server.connected", data: {} })
    await settle()
    expect(harness.notifications).toEqual([])

    harness.emit(executionSucceeded("new-main-done"))
    expect(harness.notifications).toHaveLength(1)
  })

  test("notifies the main session once after multiple subagents finish", async () => {
    const harness = await setup()
    harness.emit(executionStarted("event-1", "subagent"))
    harness.emit(executionStarted("event-2", "subagent2"))
    harness.emit(executionSucceeded("event-3"))

    harness.emit(executionSucceeded("event-4", "subagent"))
    expect(harness.notifications).toHaveLength(1)
    harness.emit(executionSucceeded("event-5", "subagent2"))
    harness.emit(executionSucceeded("event-6", "subagent2"))

    expect(
      harness.notifications.filter(
        (item) => item.sound && typeof item.sound === "object" && item.sound.name === "done",
      ),
    ).toHaveLength(1)
  })

  test("notifies the main session after the last subagent fails", async () => {
    const harness = await setup()
    harness.emit(executionStarted("event-1", "subagent"))
    harness.emit(executionSucceeded("event-2"))

    harness.emit(executionFailed("event-3", "subagent"))

    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "boom",
        notification: false,
        sound: { name: "error", when: "always" },
      },
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("waits for a running subagent before its family information is loaded", async () => {
    const harness = await setup({ type: "session", sessionID: "session" }, {}, ["late-subagent"])
    harness.emit(sessionCreated("late-subagent", "session"))
    harness.emit(executionStarted("event-1", "late-subagent"))
    harness.emit(executionSucceeded("event-2"))

    expect(harness.notifications).toEqual([])

    harness.emit(executionSucceeded("event-3", "late-subagent"))
    expect(harness.notifications).toEqual([
      {
        title: undefined,
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
    harness.revealSession("late-subagent")
  })

  test("restores running descendants after setup and releases deleted deferred parents", async () => {
    const harness = await setup({ type: "session", sessionID: "session" }, { subagent: "running" })

    harness.emit(executionSucceeded("event-1"))
    expect(harness.notifications).toEqual([])

    harness.emit(sessionDeleted("event-2", "subagent"))
    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])

    harness.emit(sessionDeleted("event-3", "subagent"))
    expect(harness.notifications).toHaveLength(1)
  })

  test("TC-008: suppresses late terminal events after a deleted subagent releases its parent", async () => {
    const harness = await setup({ type: "session", sessionID: "session" }, { subagent: "running" })

    harness.emit(executionSucceeded("event-1"))
    harness.emit(sessionDeleted("event-2", "subagent"))
    expect(harness.notifications).toHaveLength(1)

    harness.emit(sessionDeleted("event-3", "subagent"))
    harness.emit(executionSucceeded("event-4", "subagent"))
    harness.emit(executionFailed("event-5", "subagent"))
    harness.emit(executionInterrupted("event-6", "subagent"))

    expect(harness.notifications).toHaveLength(1)
    expect(harness.toasts).toHaveLength(0)
  })

  test("waits for nested descendants before notifying the main session", async () => {
    const harness = await setup()
    harness.emit(sessionCreated("subagent", "session"))
    harness.emit(executionStarted("event-1", "subagent"))
    harness.emit(sessionCreated("nested", "subagent"))
    harness.emit(executionStarted("event-2", "nested"))
    harness.emit(executionSucceeded("event-3"))

    expect(harness.notifications).toEqual([])

    harness.emit(executionSucceeded("event-4", "subagent"))
    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
    ])

    harness.emit(executionSucceeded("event-5", "nested"))
    expect(harness.notifications).toHaveLength(3)
    expect(harness.notifications[2]).toEqual({
      title: "Demo session",
      message: "Session done",
      notification: { when: "blurred" },
      sound: { name: "done", when: "always" },
    })
  })

  test("TC-007: keeps the subagent interruption sound and waits for its last descendant", async () => {
    const harness = await setup()
    harness.emit(sessionCreated("subagent", "session"))
    harness.emit(executionStarted("event-1", "subagent"))
    harness.emit(sessionCreated("nested", "subagent"))
    harness.emit(executionStarted("event-2", "nested"))
    harness.emit(executionSucceeded("event-3"))

    harness.emit(executionInterrupted("event-4", "subagent"))
    harness.emit(executionInterrupted("event-4-duplicate", "subagent"))
    expect(harness.notifications).toEqual([
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
    ])

    harness.emit(executionSucceeded("event-5", "nested"))
    expect(harness.notifications).toHaveLength(3)
    expect(harness.notifications[2]).toEqual({
      title: "Demo session",
      message: "Session done",
      notification: { when: "blurred" },
      sound: { name: "done", when: "always" },
    })
  })

  test("notifies session errors once and suppresses the following idle done notification", async () => {
    const harness = await setup()

    harness.emit(executionStarted("event-1"))
    harness.emit(executionFailed("event-2"))
    harness.emit(executionSucceeded("event-3"))

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "boom",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })
})
