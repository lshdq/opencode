import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { ServerSDK } from "@/runtime/server/client"
import type { Data } from "@opencode/client/solid"
import type { ServerConnection } from "@/runtime/server/registry"
import { ServerScope } from "@/runtime/server/scope"
import type { Tab } from "@/shell/tabs/tabs"

const server = "local\nhttp://localhost:4096" as ServerConnection.Key

const session = { id: "session-1", title: "Test session", location: { directory: "/project" } }

const alerts: string[] = []

const tabs: { store: Tab[] } = { store: [] }

let createServerNotificationState: typeof import("./notification").createServerNotificationState

let storage: typeof import("@/runtime/persistence/storage")

beforeAll(async () => {
  storage = await import("@/runtime/persistence/storage")
  const { sessionIDHasOpenTab } = await import("@/shell/tabs/tabs")
  mock.module("@/runtime/platform/platform", () => ({
    usePlatform: () => ({
      platform: "web",
      notify: async (title: string) => {
        alerts.push(title)
      },
    }),
  }))
  mock.module("@/settings/model", () => ({
    useSettings: () => ({
      sounds: { agentEnabled: () => false, errorsEnabled: () => false },
      notifications: { agent: () => true, errors: () => true },
    }),
  }))
  mock.module("@/runtime/i18n/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("@/shell/tabs/tabs", () => ({
    useTabs: () => tabs,
    sessionIDHasOpenTab,
  }))
  mock.module("@/runtime/persistence/storage", () => ({
    ...storage,
    persisted: () => {
      const [store, setStore] = createStore({ list: [] })

      return [store, setStore, undefined, () => false]
    },
  }))
  createServerNotificationState = (await import("./notification")).createServerNotificationState
})

afterAll(() => mock.module("@/runtime/persistence/storage", () => storage))

const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

test.each([
  ["session.execution.succeeded", "notification.session.responseReady.title"],
  ["session.execution.failed", "notification.session.error.title"],
] as const)("system alert for %s requires an open session tab", async (type, title) => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: "another-session" }]
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn

            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: () => session,
          list: () => [session],
          family: () => [session.id],
          status: () => "idle",
        },
        shell: { listBySession: () => [], sync: async () => {} },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({
    type,
    id: "event-1",
    data: { sessionID: session.id, error: { type: "api", message: "failed", status: 500 } },
  })
  await settle()
  expect(dispose.state.session.all(session.id)).toHaveLength(1)
  expect(alerts).toEqual([])

  tabs.store = [{ type: "session", server, sessionId: session.id }]
  listener?.({ type: "session.execution.started", id: "event-1-restarted", data: { sessionID: session.id } })
  listener?.({
    type,
    id: "event-2",
    data: { sessionID: session.id, error: { type: "api", message: "failed", status: 500 } },
  })
  await settle()
  expect(alerts).toEqual([title])
  dispose.dispose()
})

test("does not suppress a new completion after reconnect without a started event", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  let status: "idle" | "running" = "idle"
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: () => session,
          list: () => [session],
          family: () => [session.id],
          status: () => status,
        },
        shell: { listBySession: () => [], sync: async () => {} },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({ type: "session.execution.succeeded", id: "event-1", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])

  status = "running"
  listener?.({ type: "server.connected", id: "connected-1", data: {} })
  await settle()
  status = "idle"
  listener?.({ type: "session.execution.succeeded", id: "event-2", data: { sessionID: session.id } })
  listener?.({ type: "session.execution.succeeded", id: "event-2", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([
    "notification.session.responseReady.title",
    "notification.session.responseReady.title",
  ])
  dispose.dispose()
})

test("ignores a late failure after deletion and notifies after the same ID is recreated", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const sessions = [session]
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: (id: string) => sessions.find((item) => item.id === id),
          list: () => sessions,
          family: () => sessions.map((item) => item.id),
          status: () => "idle",
        },
        shell: { listBySession: () => [], sync: async () => {} },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  sessions.splice(0, 1)
  listener?.({ type: "session.deleted", id: "deleted", data: { sessionID: session.id } })
  listener?.({
    type: "session.execution.failed",
    id: "late-failed",
    data: { sessionID: session.id, error: { type: "api", message: "late failure", status: 500 } },
  })
  await settle()
  expect(dispose.state.session.all(session.id)).toHaveLength(0)
  expect(alerts).toEqual([])

  sessions.push(session)
  listener?.({ type: "session.created", id: "recreated", data: { sessionID: session.id, parentID: undefined } })
  listener?.({ type: "session.execution.succeeded", id: "recreated-done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("rechecks observed shells after reconnect when the exit event was missed", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const shell = {
    id: "shell-reconnect",
    status: "running" as const,
    metadata: { sessionID: session.id },
  }
  let currentShell: typeof shell | undefined = shell
  const syncLocations: { directory: string }[] = []
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        location: { default: () => ({ directory: "/project" }) },
        session: {
          get: () => session,
          list: () => [session],
          family: () => [session.id],
          status: () => "idle",
        },
        shell: {
          get: () => currentShell,
          listBySession: () => [],
          sync: async (location: { directory: string }) => {
            syncLocations.push(location)
            currentShell = undefined
          },
        },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({
    type: "shell.created",
    id: "shell-created",
    data: { info: { ...shell, command: "sleep 1", cwd: "/project", shell: "sh", file: "/tmp/shell.log" } },
  })
  listener?.({ type: "session.execution.succeeded", id: "main-done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([])

  listener?.({ type: "server.connected", id: "connected", data: {} })
  await settle()
  expect(syncLocations).toEqual([{ directory: "/project" }])
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("waits for the reconnect barrier before processing a terminal event", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  let releaseSync: (() => void) | undefined
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: () => session,
          list: () => [session],
          family: () => [session.id],
          status: () => "idle",
          sync: async () => new Promise<void>((resolve) => (releaseSync = resolve)),
        },
        shell: { listBySession: () => [], sync: async () => {} },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({ type: "server.connected", id: "connected", data: {} })
  listener?.({ type: "session.execution.succeeded", id: "done", data: { sessionID: session.id } })
  listener?.({ type: "session.execution.succeeded", id: "done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([])

  releaseSync?.()
  await settle()
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("queues all execution lifecycle events and keeps a parent deferred until its child terminal event", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "reconnect-child", parentID: session.id }
  const grandchild = { ...session, id: "reconnect-grandchild", parentID: child.id }
  const sessions = [session, child, grandchild]
  const operations: string[] = []
  let currentShell: { id: string; status: "running"; metadata: { sessionID: string } } | undefined = {
    id: "reconnect-shell",
    status: "running",
    metadata: { sessionID: session.id },
  }
  let releaseSync: (() => void) | undefined
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: (id: string) => sessions.find((item) => item.id === id),
          list: () => sessions,
          family: () => sessions.map((item) => item.id),
          status: () => "idle",
          invalidate: (id: string) => operations.push(`session.invalidate:${id}`),
          sync: async (id: string) => {
            operations.push(`session.sync:${id}`)
            await new Promise<void>((resolve) => (releaseSync = resolve))
          },
        },
        shell: {
          get: () => currentShell,
          listBySession: () => [],
          invalidate: (location: { directory: string }) => operations.push(`shell.invalidate:${location.directory}`),
          sync: async (location: { directory: string }) => {
            operations.push(`shell.sync:${location.directory}`)
            currentShell = undefined
          },
        },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({
    type: "shell.created",
    id: "shell-created",
    location: { directory: "/project" },
    data: { info: { ...currentShell, command: "sleep 1", cwd: "/project", shell: "sh", file: "/tmp/shell.log" } },
  })
  listener?.({ type: "server.connected", id: "connected", data: {} })
  listener?.({ type: "session.execution.started", id: "child-started", data: { sessionID: child.id } })
  listener?.({ type: "session.execution.started", id: "grandchild-started", data: { sessionID: grandchild.id } })
  listener?.({ type: "session.execution.succeeded", id: "parent-done", data: { sessionID: session.id } })
  listener?.({ type: "session.execution.succeeded", id: "child-done", data: { sessionID: child.id } })
  listener?.({ type: "session.execution.succeeded", id: "grandchild-done", data: { sessionID: grandchild.id } })
  await settle()
  expect(alerts).toEqual([])
  expect(operations.slice(0, 2)).toEqual(["shell.invalidate:/project", "session.invalidate:session-1"])
  expect(operations.slice(2)).toEqual(["shell.sync:/project", "session.sync:session-1"])

  releaseSync?.()
  await settle()
  await settle()
  listener?.({ type: "session.execution.succeeded", id: "parent-duplicate", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("refreshes observed shell ancestors after delayed session hydration", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const sessions = [session]
  const shell = {
    id: "shell-late-owner",
    status: "running" as const,
    metadata: { sessionID: "late-nested" },
  }
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        location: { default: () => ({ directory: "/project" }) },
        session: {
          get: (id: string) => sessions.find((item) => item.id === id),
          list: () => sessions,
          family: () => [session.id],
          status: () => "idle",
        },
        shell: {
          get: () => shell,
          listBySession: () => [],
        },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({
    type: "shell.created",
    id: "shell-created",
    data: { info: { ...shell, command: "sleep 1", cwd: "/project", shell: "sh", file: "/tmp/shell.log" } },
  })
  listener?.({
    type: "session.created",
    id: "nested-created",
    data: { sessionID: "late-nested", parentID: "late-parent" },
  })
  listener?.({
    type: "session.created",
    id: "parent-created",
    data: { sessionID: "late-parent", parentID: session.id },
  })
  listener?.({ type: "session.execution.succeeded", id: "main-done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([])

  listener?.({ type: "shell.exited", id: "shell-exited", data: { id: shell.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("hydrates known children before reconnecting deferred background work", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "reconnect-child", parentID: session.id }
  const sessions = [session]
  let childRunning = true
  let currentShell: {
    id: string
    status: "running"
    metadata: { sessionID: string }
  } | undefined = {
    id: "reconnect-child-shell",
    status: "running",
    metadata: { sessionID: child.id },
  }
  const sessionSyncs: { sessionID: string; children?: boolean }[] = []
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        location: { default: () => ({ directory: "/project" }) },
        session: {
          get: (id: string) => sessions.find((item) => item.id === id),
          list: () => sessions,
          family: () => sessions.map((item) => item.id),
          status: (id: string) => (id === child.id && childRunning ? "running" : "idle"),
          sync: async (sessionID: string, options?: { children?: boolean }) => {
            sessionSyncs.push({ sessionID, children: options?.children })
            if (sessionID === session.id && options?.children && !sessions.includes(child)) sessions.push(child)
          },
        },
        shell: {
          get: () => currentShell,
          listBySession: (sessionID: string) =>
            currentShell && currentShell.metadata.sessionID === sessionID ? [currentShell] : [],
          sync: async () => {
            currentShell = undefined
          },
        },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({ type: "session.created", id: "child-created", data: { sessionID: child.id, parentID: session.id } })
  listener?.({
    type: "shell.created",
    id: "shell-created",
    data: {
      info: {
        ...currentShell,
        command: "sleep 1",
        cwd: "/project",
        shell: "sh",
        file: "/tmp/shell.log",
      },
    },
  })
  listener?.({ type: "session.execution.succeeded", id: "main-done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([])

  listener?.({ type: "server.connected", id: "connected", data: {} })
  await settle()
  expect(sessionSyncs).toContainEqual({ sessionID: session.id, children: true })
  expect(alerts).toEqual([])

  childRunning = false
  listener?.({ type: "session.execution.succeeded", id: "child-done", data: { sessionID: child.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("retains terminal markers for sessions still present in the data set", async () => {
  alerts.length = 0
  const sessions = Array.from({ length: 257 }, (_, index) => ({
    ...session,
    id: `loaded-session-${index}`,
  }))
  tabs.store = [{ type: "session", server, sessionId: sessions[0].id }]
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: (id: string) => sessions.find((item) => item.id === id),
          list: () => sessions,
          family: (sessionID: string) => [sessionID],
          status: () => "idle",
        },
        shell: { listBySession: () => [] },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  sessions.forEach((item, index) => {
    listener?.({
      type: "session.execution.succeeded",
      id: `done-${index}`,
      data: { sessionID: item.id },
    })
  })
  await settle()
  listener?.({ type: "session.execution.succeeded", id: "duplicate", data: { sessionID: sessions[0].id } })
  await settle()
  expect(alerts).toHaveLength(1)
  dispose.dispose()
})

test("defers the main session alert while a child session is running", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "child-session", parentID: session.id }
  const sessions = [session, child]
  const running = new Set([child.id])
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: (id: string) => sessions.find((item) => item.id === id),
          list: () => sessions,
          family: () => sessions.map((item) => item.id),
          status: (id: string) => (running.has(id) ? "running" : "idle"),
        },
        shell: { listBySession: () => [] },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({ type: "session.execution.succeeded", id: "main-done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([])

  listener?.({ type: "session.execution.succeeded", id: "child-done", data: { sessionID: child.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("defers the main session alert while a background shell is running", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const shell: { id: string; status: "running" | "exited"; metadata: { sessionID: string } } = {
    id: "shell-1",
    status: "running",
    metadata: { sessionID: session.id },
  }
  const shells = [shell, { id: "shell-unrelated", status: "running" as const, metadata: { sessionID: "other-session" } }]
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: () => session,
          list: () => [session],
          family: () => [session.id],
          status: () => "idle",
        },
        shell: {
          listBySession: (sessionID: string) => shells.filter((item) => item.metadata.sessionID === sessionID),
        },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({ type: "session.execution.succeeded", id: "main-done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([])

  shells[0] = { ...shell, status: "exited" }
  listener?.({ type: "shell.exited", id: "shell-done", data: { id: shell.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("sends one main session alert after all background tasks finish", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "child-session", parentID: session.id }
  const sessions = [session, child]
  const running = new Set([child.id])
  const shell: { id: string; status: "running" | "exited"; metadata: { sessionID: string } } = {
    id: "shell-1",
    status: "running",
    metadata: { sessionID: session.id },
  }
  const shells = [shell]
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        session: {
          get: (id: string) => sessions.find((item) => item.id === id),
          list: () => sessions,
          family: () => sessions.map((item) => item.id),
          status: (id: string) => (running.has(id) ? "running" : "idle"),
        },
        shell: { listBySession: () => shells },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({ type: "session.execution.succeeded", id: "main-done", data: { sessionID: session.id } })
  await settle()
  running.delete(child.id)
  listener?.({ type: "session.execution.succeeded", id: "child-done", data: { sessionID: child.id } })
  listener?.({ type: "session.execution.succeeded", id: "child-done-duplicate", data: { sessionID: child.id } })
  await settle()
  expect(alerts).toEqual([])

  shells[0] = { ...shell, status: "exited" }
  listener?.({ type: "shell.exited", id: "shell-done", data: { id: shell.id } })
  listener?.({ type: "shell.exited", id: "shell-done-duplicate", data: { id: shell.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("keeps a deleted child shell attached to the main session", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "child-session", parentID: session.id }
  const sessions = [session, child]
  const running = new Set([child.id])
  const shell: { id: string; status: "running" | "exited"; metadata: { sessionID: string } } = {
    id: "shell-child",
    status: "running",
    metadata: { sessionID: child.id },
  }
  const shells = [shell]
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        location: { default: () => ({ directory: "/project" }) },
        session: {
          get: (id: string) => sessions.find((item) => item.id === id),
          list: () => sessions,
          family: () => sessions.map((item) => item.id),
          status: (id: string) => (running.has(id) ? "running" : "idle"),
        },
        shell: {
          listBySession: (sessionID: string) => shells.filter((item) => item.metadata.sessionID === sessionID),
        },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({
    type: "shell.created",
    id: "shell-created",
    data: { info: { ...shell, command: "sleep 1", cwd: "/project", shell: "sh", file: "/tmp/shell.log" } },
  })
  listener?.({ type: "session.execution.succeeded", id: "main-done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([])

  sessions.splice(1, 1)
  listener?.({ type: "session.deleted", id: "child-deleted", data: { sessionID: child.id } })
  await settle()
  expect(alerts).toEqual([])

  shells[0] = { ...shell, status: "exited" }
  listener?.({ type: "shell.exited", id: "shell-exited", data: { id: shell.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})

test("rechecks deferred background tasks after asynchronous session hydration", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "child-session", parentID: session.id }
  const sessions = [session, child]
  const running = new Set([child.id])
  const shell: { id: string; status: "running" | "exited"; metadata: { sessionID: string } } = {
    id: "shell-main",
    status: "running",
    metadata: { sessionID: session.id },
  }
  const shells = [shell]
  let hydrating = false
  const syncWaiters: (() => void)[] = []
  let listener: ((event: unknown) => void) | undefined

  const dispose = createRoot((dispose) => {
    const state = createServerNotificationState({
      key: server,
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (fn: typeof listener) => {
            listener = fn
            return () => {}
          },
        },
      } as unknown as ServerSDK,
      data: {
        location: { default: () => ({ directory: "/project" }) },
        session: {
          get: (id: string) => (hydrating ? undefined : sessions.find((item) => item.id === id)),
          list: () => sessions,
          family: () => sessions.map((item) => item.id),
          status: (id: string) => (running.has(id) ? "running" : "idle"),
          sync: () => new Promise<void>((resolve) => syncWaiters.push(resolve)),
        },
        shell: {
          listBySession: (sessionID: string) => shells.filter((item) => item.metadata.sessionID === sessionID),
        },
      } as unknown as Data,
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    } as Parameters<typeof createServerNotificationState>[0])

    return { dispose, state }
  })

  listener?.({ type: "session.execution.succeeded", id: "main-done", data: { sessionID: session.id } })
  await settle()
  expect(alerts).toEqual([])

  running.delete(child.id)
  hydrating = true
  listener?.({ type: "session.execution.succeeded", id: "child-done", data: { sessionID: child.id } })
  listener?.({
    type: "shell.created",
    id: "shell-created",
    data: { info: { ...shell, command: "sleep 1", cwd: "/project", shell: "sh", file: "/tmp/shell.log" } },
  })
  hydrating = false
  syncWaiters.splice(0).forEach((resolve) => resolve())
  await settle()
  expect(alerts).toEqual([])

  shells[0] = { ...shell, status: "exited" }
  listener?.({ type: "shell.exited", id: "shell-exited", data: { id: shell.id } })
  await settle()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose.dispose()
})
