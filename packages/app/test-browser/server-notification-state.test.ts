import { beforeAll, beforeEach, expect, mock, setSystemTime, test, vi } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { OpenCodeEvent } from "@opencode/client/promise"
import type { ServerConnection } from "@/runtime/server/registry"
import { ServerScope } from "@/runtime/server/scope"
import type { Tab } from "@/shell/tabs/tabs"
import type { createNotificationCoordinator } from "@/shell/notifications/coordinator"
import type { AsyncStorage } from "@solid-primitives/storage"

type NotificationDelivery = Parameters<ReturnType<typeof createNotificationCoordinator>["system"]>[1]

// SAFETY: this is the key format `ServerConnection.key` produces for a local server.
const server = "local\nhttp://localhost:4096" as ServerConnection.Key

const session = { id: "session-1", title: "Test session", location: { directory: "/project" } }

const alerts: string[] = []

const sounds: string[] = []

const clicks: Array<() => void> = []

const selected: string[] = []

const desktopStorage = new Map<string, AsyncStorage>()

const tabs = {
  store: new Array<Tab>(),
  addSessionTab: (input: { server: ServerConnection.Key; sessionId: string }) => ({
    type: "session" as const,
    ...input,
  }),
  rememberSessionRoute: () => {},
  select: (tab: Tab) => {
    if (tab.type === "session") selected.push(tab.sessionId)
  },
}

let createServerNotificationState: typeof import("@/shell/notifications/notification").createServerNotificationState

const preferences = {
  autoApprove: false,
  agent: true,
  permissions: true,
  questions: true,
  permissionsSound: true,
  questionsSound: true,
}

// Each test fakes only the parts of the SDK, data store and coordinator that the notification state reads.
const createState = (input: {
  sdk: object
  data: object
  coordinator: object
  muted?: (id: string) => boolean
  preferencesLoaded?: Promise<unknown>
}) =>
  // SAFETY: the fakes cover every member the notification state reaches in that test.
  createServerNotificationState({
    key: server,
    muted: () => false,
    ...input,
    sdk: {
      api: { session: { active: async () => ({}) } },
      connection: { status: () => "connected" },
      ...input.sdk,
    },
  } as never)

const waitFor = async (predicate: () => boolean, description: string) => {
  const deadline = Date.now() + 1_000

  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

beforeAll(async () => {
  // Fakes replace only the hooks this test controls. Spreading the real module keeps every other export, such as
  // projectSettingsKey, for the modules the notification state imports.
  const [platform, settings, language, tabModule] = await Promise.all([
    import("@/runtime/platform/platform"),
    import("@/settings/model"),
    import("@/runtime/i18n/language"),
    import("@/shell/tabs/tabs"),
  ])

  mock.module("@/runtime/platform/platform", () => ({
    ...platform,
    usePlatform: () => ({
      platform: desktopStorage.has("desktop") ? "desktop" : "web",
      windowID: "notification-test",
      storage: () => desktopStorage.get("desktop"),
      notify: async (title: string, _description?: string, onClick?: () => void) => {
        alerts.push(title)

        if (onClick) clicks.push(onClick)
      },
    }),
  }))
  mock.module("@/runtime/i18n/language", () => ({
    ...language,
    useLanguage: () => ({ t: (key: string) => key }),
  }))
  mock.module("@/settings/model", () => ({
    ...settings,
    useSettings: () => ({
      sounds: {
        agentEnabled: () => false,
        errorsEnabled: () => false,
        permissionsEnabled: () => preferences.permissionsSound,
        permissions: () => "alert-01",
        questionsEnabled: () => preferences.questionsSound,
        questions: () => "alert-02",
      },
      notifications: {
        agent: () => preferences.agent,
        errors: () => true,
        permissions: () => preferences.permissions,
        questions: () => preferences.questions,
      },
      permissions: { autoApproves: () => preferences.autoApprove },
    }),
  }))
  mock.module("@/shell/tabs/tabs", () => ({ ...tabModule, useTabs: () => tabs }))
  mock.module("@/shell/notifications/sound", () => ({
    playSoundById: async (id: string) => {
      sounds.push(id)
    },
  }))
  createServerNotificationState = (await import("@/shell/notifications/notification")).createServerNotificationState
})

beforeEach(() => {
  alerts.length = 0
  sounds.length = 0
  clicks.length = 0
  selected.length = 0
  desktopStorage.clear()
  Object.assign(preferences, {
    autoApprove: false,
    agent: true,
    permissions: true,
    questions: true,
    permissionsSound: true,
    questionsSound: true,
  })
})

const requests = [
  { kind: "permission", category: "permissions", title: "notification.permission.title" },
  { kind: "question", category: "questions", title: "notification.question.title" },
  { kind: "mcp-elicitation", category: "questions", title: "notification.elicitation.title" },
  { kind: "websearch.provider", category: "permissions", title: "notification.permission.title" },
] as const

test.each(
  requests.flatMap((request) =>
    [
      "enabled",
      "other category disabled",
      "notifications disabled",
      "sound disabled",
      "resolved",
      "auto approve",
      "root tab",
      "muted root",
      "no tab",
      "disposed",
    ].map((scenario) => ({ ...request, scenario })),
  ),
)("request alerts: $kind / $scenario", async (options) => {
  preferences.agent = false
  preferences.autoApprove = options.scenario === "auto approve"
  preferences[options.category] = options.scenario !== "notifications disabled"
  preferences[options.category === "questions" ? "questionsSound" : "permissionsSound"] =
    options.scenario !== "sound disabled"

  if (options.scenario === "other category disabled") {
    preferences[options.category === "questions" ? "permissions" : "questions"] = false
    preferences[options.category === "questions" ? "permissionsSound" : "questionsSound"] = false
  }

  tabs.store =
    options.scenario === "no tab"
      ? []
      : [{ type: "session", server, sessionId: options.scenario === "root tab" ? "root" : session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()

  const deliveries = new Array<NotificationDelivery>()

  const pending = { value: true }

  const dispose = createRoot((dispose) => {
    createState({
      muted: (id) => options.scenario === "muted root" && id === "root",
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          get: () => ({ ...session, parentID: "root", projectID: "project-1" }),
          root: () => "root",
          permission: { list: () => (pending.value ? [{ id: "request-1" }] : []) },
          form: { list: () => (pending.value ? [{ id: "request-1" }] : []) },
        },
      },
      coordinator: {
        sound: async (_key: string, run: NotificationDelivery) => {
          deliveries.push(run)
        },
        system: async (_key: string, run: NotificationDelivery) => {
          deliveries.push(run)
        },
      },
    })

    return dispose
  })

  try {
    const event: OpenCodeEvent =
      options.kind === "permission"
        ? {
            id: "event-1",
            created: 0,
            location: session.location,
            type: "permission.asked",
            data: { sessionID: session.id, id: "request-1", action: "shell", resources: [], metadata: {} },
          }
        : {
            id: "event-1",
            created: 0,
            location: session.location,
            type: "form.created",
            data: {
              form: {
                sessionID: session.id,
                id: "request-1",
                title: "Input",
                fields: [{ key: "answer", type: "string", title: "Continue?" }],
                metadata: { kind: options.kind },
              },
            },
          }

    listeners.forEach((listener) => listener(event))
    await Promise.resolve()

    if (options.scenario === "resolved") pending.value = false

    if (options.scenario === "disposed") dispose()
    await Promise.all(deliveries.map((run) => run()))

    const suppressed =
      ["resolved", "disposed", "no tab", "muted root"].includes(options.scenario) ||
      (options.scenario === "auto approve" && options.kind === "permission")

    expect(alerts).toEqual(!suppressed && options.scenario !== "notifications disabled" ? [options.title] : [])
    expect(sounds).toEqual(
      !suppressed && options.scenario !== "sound disabled"
        ? [options.category === "questions" ? "alert-02" : "alert-01"]
        : [],
    )
    clicks.forEach((click) => click())
    expect(selected).toEqual(alerts.length ? [options.scenario === "root tab" ? "root" : session.id] : [])
  } finally {
    dispose()
  }
})

test.each([
  ["session.execution.succeeded", "notification.session.responseReady.title"],
  ["session.execution.failed", "notification.session.error.title"],
] as const)("system alert for %s requires an open tab and loaded, unmuted preferences", async (type, title) => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: "another-session" }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  let muted = false
  const preferencesLoaded = Promise.withResolvers<void>()

  const emit = (id: string) =>
    listeners.forEach((listener) =>
      // SAFETY: the notification state reads only the type, id and session of execution events.
      listener({ type, id, data: { sessionID: session.id, error: { type: "api", message: "failed" } } } as never),
    )

  const dispose = createRoot((dispose) => {
    createState({
      muted: () => muted,
      preferencesLoaded: preferencesLoaded.promise,
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: { session: { get: () => session, family: () => [session.id], status: () => "idle" } },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit("event-1")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(alerts).toEqual([])

  tabs.store = [{ type: "session", server, sessionId: session.id }]
  emit("event-2")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(alerts).toEqual([])

  muted = true
  preferencesLoaded.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(alerts).toEqual([])

  muted = false
  emit("event-3")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(alerts).toEqual([title])
  dispose()
})

test("evicts processed terminal markers without evicting active notification state", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: "another-session" }]
  const sessions = new Map<string, typeof session>()
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const emit = (id: string, sessionID: string) =>
    listeners.forEach((listener) =>
      listener({
        type: "session.execution.failed",
        id,
        data: { sessionID, error: { type: "api", message: "failed" } },
      } as never),
    )

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [...sessions.values()],
          get: (id: string) => sessions.get(id),
          root: (id: string) => id,
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  for (let index = 0; index <= 256; index++) {
    const sessionID = `history-${index}`
    sessions.set(sessionID, { ...session, id: sessionID })
    emit(`completion-${index}`, sessionID)
  }

  tabs.store = [{ type: "session", server, sessionId: "history-0" }]
  emit("completion-0", "history-0")
  await waitFor(() => alerts.length === 1, "notification after processed marker eviction")
  expect(alerts).toEqual(["notification.session.error.title"])
  dispose()
})

test("defers a root completion notification until its child session is idle", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "child-session", parentID: session.id }
  const statuses = new Map([[child.id, "running"]])
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const emit = (id: string, sessionID: string) =>
    listeners.forEach((listener) =>
      listener({
        type: "session.execution.succeeded",
        id,
        data: { sessionID },
      } as never),
    )

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session, child],
          get: (id: string) => ({ [session.id]: session, [child.id]: child })[id],
          root: (id: string) => (id === child.id ? session.id : id),
          status: (id: string) => statuses.get(id),
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit("root-complete", session.id)
  await Promise.resolve()
  expect(alerts).toEqual([])

  statuses.delete(child.id)
  emit("child-complete", child.id)
  await Promise.resolve()
  await Promise.resolve()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose()
})

test("defers a root completion notification until its background shell exits", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const emit = (event: OpenCodeEvent) => listeners.forEach((listener) => listener(event))
  const shellID = "shell-background"

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: { session: { list: () => [session], get: () => session, root: (id: string) => id } },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit({
    type: "shell.created",
    id: "shell-created",
    location: { directory: "/project" },
    data: {
      info: {
        id: shellID,
        status: "running",
        command: "bun run check",
        cwd: "/project",
        shell: "sh",
        file: "output",
        metadata: { sessionID: session.id },
        time: { started: 1 },
      },
    },
  } as never)
  emit({ type: "session.execution.succeeded", id: "root-complete", data: { sessionID: session.id } } as never)
  await Promise.resolve()
  expect(alerts).toEqual([])

  emit({
    type: "shell.exited",
    id: "shell-exited",
    location: { directory: "/project" },
    data: { id: shellID, status: "exited", exit: 0 },
  } as never)
  await Promise.resolve()
  await Promise.resolve()
  expect(alerts).toEqual(["notification.session.responseReady.title"])

  emit({
    type: "shell.exited",
    id: "shell-exited-again",
    location: { directory: "/project" },
    data: { id: shellID, status: "exited", exit: 0 },
  } as never)
  await Promise.resolve()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose()
})

test("hydrates nested descendants before settling a root completion", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "nested-child", parentID: session.id, time: { created: 1 } }
  const grandchild = { ...session, id: "nested-grandchild", parentID: child.id, time: { created: 1 } }
  const root = { ...session, time: { created: 1, idle: 1 } }
  const sessions = new Map([[root.id, root]])
  const statuses = new Map([[grandchild.id, "running"]])
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const emit = (id: string, sessionID: string) => {
    // SAFETY: the notification state reads only the type, id and session of execution events.
    const event = { type: "session.execution.succeeded", id, data: { sessionID } } as never
    listeners.forEach((listener) => listener(event))
  }

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [...sessions.values()],
          get: (id: string) => sessions.get(id),
          root: (id: string) => (id === child.id || id === grandchild.id ? root.id : id),
          family: () => [...sessions.keys()],
          status: (id: string) => statuses.get(id),
          sync: async (id: string) => {
            if (id === root.id) sessions.set(child.id, child)
            if (id === child.id) sessions.set(grandchild.id, grandchild)
          },
          invalidate: () => {},
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit("nested-root-complete", root.id)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(alerts).toEqual([])

  statuses.delete(grandchild.id)
  emit("nested-grandchild-complete", grandchild.id)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose()
})

test("reconnect hydrates pre-existing shells before root completion", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const shell = {
    id: "pre-existing-shell",
    status: "running",
    command: "bun run check",
    cwd: "/project",
    shell: "sh",
    file: "output",
    metadata: { sessionID: session.id },
    time: { started: 1 },
    location: { directory: "/project" },
  }
  let shellAvailable = true
  let cachedShell: typeof shell | undefined
  const emit = (event: unknown) => {
    // SAFETY: each fixture below includes the fields consumed by the notification event listener.
    listeners.forEach((listener) => listener(event as OpenCodeEvent))
  }

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: { list: () => [session], get: () => session, root: (id: string) => id },
        shell: {
          listBySession: () => (cachedShell ? [cachedShell] : []),
          sync: async () => {
            cachedShell = shellAvailable ? shell : undefined
          },
          invalidate: () => {},
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit({ type: "server.connected" })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()

  emit({ type: "session.execution.succeeded", id: "reconnect-root-complete", data: { sessionID: session.id } })
  await Promise.resolve()
  await Promise.resolve()
  expect(alerts).toEqual([])

  shellAvailable = false
  cachedShell = undefined
  emit({
    type: "shell.exited",
    id: "pre-existing-shell-exited",
    location: { directory: "/project" },
    data: { id: shell.id, status: "exited", exit: 0 },
  })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose()
})

test("reuses successful hydration while a deferred completion settles", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const shellID = "cached-shell"
  let sessionSyncs = 0
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session],
          get: () => session,
          root: (id: string) => id,
          sync: async () => {
            sessionSyncs++
          },
          invalidate: () => {},
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit({
    type: "shell.created",
    id: "cached-shell-created",
    location: { directory: "/project" },
    data: {
      info: {
        id: shellID,
        status: "running",
        command: "bun run check",
        cwd: "/project",
        shell: "sh",
        file: "output",
        metadata: { sessionID: session.id },
        time: { started: 1 },
      },
    },
  } as never)
  emit({ type: "session.execution.succeeded", id: "cached-root-complete", data: { sessionID: session.id } } as never)
  await waitFor(() => sessionSyncs === 1, "initial session hydration")
  expect(alerts).toEqual([])

  emit({
    type: "shell.exited",
    id: "cached-shell-exited",
    location: { directory: "/project" },
    data: { id: shellID, status: "exited", exit: 0 },
  } as never)
  await waitFor(() => alerts.length === 1, "deferred completion notification")
  expect(sessionSyncs).toBe(1)

  emit({ type: "session.execution.started", id: "cached-root-started", data: { sessionID: session.id } } as never)
  emit({
    type: "session.execution.succeeded",
    id: "cached-root-complete-again",
    data: { sessionID: session.id },
  } as never)
  await waitFor(() => alerts.length === 2, "notification after a new execution")
  expect(sessionSyncs).toBe(2)
  dispose()
})

test("does not let stale completion hydration replace a newer deferred execution", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const child = { ...session, id: "hydration-child", parentID: session.id }
  const statuses = new Map([[child.id, "running"]])
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const notificationIDs: string[] = []
  let releaseOldHydration = () => {}
  const oldHydration = new Promise<void>((resolve) => {
    releaseOldHydration = resolve
  })
  let syncCalls = 0
  let newCompletionChecked = false
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session, child],
          get: (id: string) => ({ [session.id]: session, [child.id]: child })[id],
          root: (id: string) => (id === child.id ? session.id : id),
          status: (id: string) => {
            if (id === child.id) newCompletionChecked = true
            return statuses.get(id)
          },
          sync: async () => {
            syncCalls++
            if (syncCalls === 1) await oldHydration
          },
          invalidate: () => {},
        },
      },
      coordinator: {
        system: async (id: string, fn: () => Promise<void>) => {
          notificationIDs.push(id)
          return fn()
        },
      },
    })

    return dispose
  })

  emit({ type: "session.execution.succeeded", id: "old-complete", data: { sessionID: session.id } })
  await waitFor(() => syncCalls === 1, "old completion hydration")

  emit({ type: "session.execution.started", id: "new-started", data: { sessionID: session.id } })
  emit({ type: "session.execution.succeeded", id: "new-complete", data: { sessionID: session.id } })
  await waitFor(() => newCompletionChecked, "new completion background check")

  releaseOldHydration()
  statuses.delete(child.id)
  emit({ type: "session.execution.succeeded", id: "child-complete", data: { sessionID: child.id } })
  await waitFor(() => notificationIDs.length === 1, "new completion notification")
  expect(notificationIDs).toEqual([`${server}\0new-complete`])
  dispose()
})

test("keeps incomplete completion hydration bounded", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: "another-session" }]
  const sessions = new Map<string, typeof session>()
  const releases: Array<() => void> = []
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  let syncCalls = 0
  const emit = (id: string, sessionID: string) =>
    listeners.forEach((listener) => listener({ type: "session.execution.succeeded", id, data: { sessionID } } as never))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [...sessions.values()],
          get: (id: string) => sessions.get(id),
          root: (id: string) => id,
          sync: async () => {
            syncCalls++
            await new Promise<void>((resolve) => releases.push(resolve))
          },
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  for (let index = 0; index < 257; index++) {
    const sessionID = `pending-${index}`
    sessions.set(sessionID, { ...session, id: sessionID })
    if (index < 256) emit(`completion-${index}`, sessionID)
  }

  await waitFor(() => syncCalls === 256, "pending completion hydration")
  emit("completion-256", "pending-256")
  await waitFor(() => syncCalls === 257, "bounded overflow recovery hydration")
  expect(syncCalls).toBe(257)

  dispose()
  releases.forEach((release) => release())
})

test("flushes deferred completion after reconnecting clears", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const shellID = "reconnecting-shell"
  let reconnectSyncs = 0
  let blockSync = false
  let releaseSync = () => {}
  const reconnectHydration = new Promise<void>((resolve) => {
    releaseSync = resolve
  })
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: { list: () => [session], get: () => session, root: (id: string) => id },
        shell: {
          sync: async () => {
            reconnectSyncs++
            if (blockSync) await reconnectHydration
          },
          invalidate: () => {},
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit({
    type: "shell.created",
    id: "reconnecting-shell-created",
    location: { directory: "/project" },
    data: {
      info: {
        id: shellID,
        status: "running",
        command: "bun run check",
        cwd: "/project",
        shell: "sh",
        file: "output",
        metadata: { sessionID: session.id },
        time: { started: 1 },
      },
    },
  } as never)
  emit({
    type: "session.execution.succeeded",
    id: "reconnecting-root-complete",
    data: { sessionID: session.id },
  } as never)
  await waitFor(() => reconnectSyncs === 1, "initial shell hydration")
  expect(alerts).toEqual([])

  blockSync = true
  emit({ type: "server.connected" })
  await waitFor(() => reconnectSyncs >= 2, "reconnect hydration")
  emit({
    type: "shell.exited",
    id: "reconnecting-shell-exited",
    location: { directory: "/project" },
    data: { id: shellID, status: "exited", exit: 0 },
  } as never)
  expect(alerts).toEqual([])

  releaseSync()
  await waitFor(() => alerts.length === 1, "post-reconnect deferred completion notification")
  dispose()
})

test("reconciles a completion that settles after reconnect flushes", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  let releaseInitialHydration = () => {}
  const initialHydration = new Promise<void>((resolve) => {
    releaseInitialHydration = resolve
  })
  let staleHydrationSettled = false
  let syncs = 0
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session],
          get: () => session,
          root: (id: string) => id,
          sync: async () => {
            syncs++
            if (syncs === 1) {
              await initialHydration
              staleHydrationSettled = true
              throw new Error("stale hydration")
            }
          },
          invalidate: () => {},
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit({ type: "session.execution.succeeded", id: "late-settlement-complete", data: { sessionID: session.id } })
  await waitFor(() => syncs === 1, "initial completion hydration")
  emit({ type: "server.connected" })
  await waitFor(() => syncs === 2, "reconnect hydration")
  await waitFor(() => alerts.length === 1, "reconnect completion notification")
  expect(alerts).toEqual(["notification.session.responseReady.title"])

  releaseInitialHydration()
  await waitFor(() => staleHydrationSettled, "stale hydration settlement")
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose()
})

test("drops deferred hydration that settles after a reconnect deadline", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  let releaseInitialHydration = () => {}
  const initialHydration = new Promise<void>((resolve) => {
    releaseInitialHydration = resolve
  })
  let resolveInitialStarted = () => {}
  const initialStarted = new Promise<void>((resolve) => {
    resolveInitialStarted = resolve
  })
  let resolveReconnectStarted = () => {}
  const reconnectStarted = new Promise<void>((resolve) => {
    resolveReconnectStarted = resolve
  })
  let resolveTimeoutRecoveryStarted = () => {}
  const timeoutRecoveryStarted = new Promise<void>((resolve) => {
    resolveTimeoutRecoveryStarted = resolve
  })
  let syncs = 0
  let staleHydrationSettled = false
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session],
          get: () => session,
          root: (id: string) => id,
          sync: async () => {
            syncs++
            if (syncs === 1) {
              resolveInitialStarted()
              await initialHydration
              staleHydrationSettled = true
              return
            }
            if (syncs === 2) {
              resolveReconnectStarted()
              await new Promise<void>(() => {})
            }
            resolveTimeoutRecoveryStarted()
            await new Promise<void>(() => {})
          },
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  try {
    emit({ type: "session.execution.succeeded", id: "deadline-old-complete", data: { sessionID: session.id } })
    await initialStarted

    vi.useFakeTimers()
    emit({ type: "server.connected" })
    await reconnectStarted
    vi.advanceTimersToNextTimer()
    vi.useRealTimers()

    await timeoutRecoveryStarted
    releaseInitialHydration()
    await waitFor(() => staleHydrationSettled, "stale hydration settlement after reconnect deadline")
    expect(alerts).toEqual([])
  } finally {
    vi.useRealTimers()
    releaseInitialHydration()
    dispose()
  }
})

test("uses the active-session snapshot over cached idle state during reconnect", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const notificationIDs: string[] = []
  let releaseActive = () => {}
  let activeCalls = 0
  const active = new Promise<Record<string, { type: "running" }>>((resolve) => {
    releaseActive = () => resolve({ [session.id]: { type: "running" } })
  })
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        api: {
          session: {
            active: async () => {
              activeCalls++
              return active
            },
          },
        },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session],
          get: () => session,
          root: (id: string) => id,
          status: () => "idle",
          invalidate: () => {},
        },
      },
      coordinator: {
        system: async (id: string, fn: () => Promise<void>) => {
          notificationIDs.push(id)
          return fn()
        },
      },
    })

    return dispose
  })

  emit({ type: "session.execution.succeeded", id: "cached-idle-complete", data: { sessionID: session.id } })
  emit({ type: "server.connected" })
  await waitFor(() => activeCalls === 1, "active-session snapshot")
  expect(alerts).toEqual([])

  emit({ type: "session.execution.succeeded", id: "post-reconnect-complete", data: { sessionID: session.id } })
  releaseActive()
  await waitFor(() => notificationIDs.length === 1, "post-reconnect completion notification")
  expect(notificationIDs).toEqual([`${server}\0post-reconnect-complete`])
  dispose()
})

test("resets a stale terminal marker when reconnect sees a new active execution", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const notificationIDs: string[] = []
  let activeCalls = 0
  let activeSnapshot = false
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        api: {
          session: {
            active: async () => {
              activeCalls++
              return activeSnapshot ? { [session.id]: { type: "running" } } : {}
            },
          },
        },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session],
          get: () => session,
          root: (id: string) => id,
          invalidate: () => {},
        },
      },
      coordinator: {
        system: async (id: string, fn: () => Promise<void>) => {
          notificationIDs.push(id)
          return fn()
        },
      },
    })

    return dispose
  })

  emit({ type: "session.execution.succeeded", id: "old-complete", data: { sessionID: session.id } })
  await waitFor(() => notificationIDs.length === 1, "old completion notification")
  expect(notificationIDs).toEqual([`${server}\0old-complete`])

  activeSnapshot = true
  emit({ type: "server.connected" })
  await waitFor(() => activeCalls === 1, "reconnect active-session snapshot")
  for (let index = 0; index < 12; index++) await Promise.resolve()

  emit({ type: "session.execution.succeeded", id: "new-complete", data: { sessionID: session.id } })
  await waitFor(() => notificationIDs.length === 2, "new completion notification")
  emit({ type: "session.execution.succeeded", id: "new-complete", data: { sessionID: session.id } })
  await Promise.resolve()
  expect(notificationIDs).toEqual([`${server}\0old-complete`, `${server}\0new-complete`])
  dispose()
})

test("uses the current running status when a started event is missed", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const notificationIDs: string[] = []
  let status: "idle" | "running" = "idle"
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session],
          get: () => session,
          root: (id: string) => id,
          status: () => status,
        },
      },
      coordinator: {
        system: async (id: string, fn: () => Promise<void>) => {
          notificationIDs.push(id)
          return fn()
        },
      },
    })

    return dispose
  })

  emit({ type: "session.execution.succeeded", id: "old-complete", data: { sessionID: session.id } })
  await waitFor(() => notificationIDs.length === 1, "old completion notification")

  status = "running"
  emit({ type: "session.execution.succeeded", id: "new-complete", data: { sessionID: session.id } })
  await waitFor(() => notificationIDs.length === 2, "new completion after missed started event")
  expect(notificationIDs).toEqual([`${server}\0old-complete`, `${server}\0new-complete`])
  dispose()
})

test("recovers a root completion after lifecycle queue overflow", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const root = { ...session, time: { created: 1, idle: 2 } }
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  let releaseHydration = () => {}
  const hydration = new Promise<void>((resolve) => {
    releaseHydration = resolve
  })
  const emit = (event: unknown) => {
    // SAFETY: each fixture below includes the fields consumed by the notification event listener.
    listeners.forEach((listener) => listener(event as OpenCodeEvent))
  }

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [root],
          get: (id: string) => (id === root.id ? root : undefined),
          root: (id: string) => id,
          sync: async () => hydration,
          invalidate: () => {},
        },
      },
      coordinator: { system: async (_id: string, fn: () => Promise<void>) => fn() },
    })

    return dispose
  })

  emit({ type: "server.connected" })
  emit({ type: "session.execution.succeeded", id: "overflow-root-complete", data: { sessionID: root.id } })
  for (let index = 0; index <= 1024; index++) {
    emit({
      type: "session.execution.succeeded",
      id: `overflow-${index}`,
      data: { sessionID: `overflow-session-${index}` },
    })
  }
  expect(alerts).toEqual([])

  releaseHydration()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose()
})

test("recovers an online root completion after pending terminal marker overflow", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const root = { ...session, time: { idle: undefined as number | undefined } }
  const pendingSessions = Array.from({ length: 256 }, (_, index) => ({
    ...session,
    id: `online-overflow-${index}`,
    time: { idle: 1 },
  }))
  const sessions = [root, ...pendingSessions]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const notificationIDs: string[] = []
  let pendingHydrationCalls = 0
  let releasePendingHydration = () => {}
  let releaseRootHydration = () => {}
  const pendingHydration = new Promise<void>((resolve) => {
    releasePendingHydration = resolve
  })
  const rootHydration = new Promise<void>((resolve) => {
    releaseRootHydration = resolve
  })
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => sessions,
          get: (id: string) => sessions.find((item) => item.id === id),
          root: (id: string) => id,
          sync: async (id: string) => {
            if (id === root.id) await rootHydration
            else {
              pendingHydrationCalls++
              await pendingHydration
            }
          },
        },
      },
      coordinator: {
        system: async (id: string, fn: () => Promise<void>) => {
          notificationIDs.push(id)
          return fn()
        },
      },
    })

    return dispose
  })

  pendingSessions.forEach((pending) =>
    emit({ type: "session.execution.succeeded", id: `${pending.id}-complete`, data: { sessionID: pending.id } }),
  )
  await waitFor(() => pendingHydrationCalls === 256, "online pending marker hydration")

  emit({ type: "session.execution.succeeded", id: "online-overflow-root-complete", data: { sessionID: root.id } })
  expect(alerts).toEqual([])

  emit({ type: "session.execution.started", id: "online-overflow-root-started-again", data: { sessionID: root.id } })
  emit({
    type: "session.execution.succeeded",
    id: "online-overflow-root-complete-again",
    data: { sessionID: root.id },
  })

  root.time.idle = 2
  releasePendingHydration()
  releaseRootHydration()
  await waitFor(() => notificationIDs.length === 1, "online overflow completion notification")
  expect(notificationIDs).toEqual([`${server}\0online-overflow-root-complete-again`])
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose()
})

test("restores overflow recovery state when reconnect supersedes hydration", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const root = { ...session, time: { idle: 2 } }
  const pendingSessions = Array.from({ length: 256 }, (_, index) => ({
    ...session,
    id: `superseded-overflow-${index}`,
  }))
  const sessions = [root, ...pendingSessions]
  const statuses = new Set(pendingSessions.map((item) => item.id))
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const notificationIDs: string[] = []
  let rootSyncs = 0
  let pendingHydrationCalls = 0
  let pendingHydrationCompleted = 0
  let releasePendingHydration = () => {}
  const pendingHydration = new Promise<void>((resolve) => {
    releasePendingHydration = resolve
  })
  let releaseRootHydration = () => {}
  const rootHydration = new Promise<void>((resolve) => {
    releaseRootHydration = resolve
  })
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => sessions,
          get: (id: string) => sessions.find((item) => item.id === id),
          root: (id: string) => id,
          status: (id: string) => (statuses.has(id) ? "running" : "idle"),
          sync: async (id: string) => {
            if (id !== root.id) {
              pendingHydrationCalls++
              await pendingHydration
              pendingHydrationCompleted++
              return
            }
            rootSyncs++
            if (rootSyncs === 1) await rootHydration
          },
          invalidate: () => {},
        },
      },
      coordinator: {
        system: async (id: string, fn: () => Promise<void>) => {
          notificationIDs.push(id)
          return fn()
        },
      },
    })

    return dispose
  })

  try {
    pendingSessions.forEach((pending) =>
      emit({ type: "session.execution.succeeded", id: `${pending.id}-complete`, data: { sessionID: pending.id } }),
    )
    await waitFor(() => pendingHydrationCalls === 256, "overflow marker hydration setup")

    emit({ type: "session.execution.succeeded", id: "superseded-root-complete", data: { sessionID: root.id } })
    await waitFor(() => rootSyncs === 1, "overflow recovery hydration")

    statuses.clear()
    releasePendingHydration()
    await waitFor(() => pendingHydrationCompleted === 256, "settled overflow markers")
    emit({ type: "server.connected" })
    releaseRootHydration()
    await waitFor(() => rootSyncs >= 2, "reconnect hydration")
    await waitFor(() => notificationIDs.length === 1, "recovered completion after reconnect")
    expect(notificationIDs).toEqual([`${server}\0superseded-root-complete`])
    expect(alerts).toEqual(["notification.session.responseReady.title"])
  } finally {
    releaseRootHydration()
    dispose()
  }
})

test("recovers a deferred completion after a transient hydration failure", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const notificationIDs: string[] = []
  let syncCalls = 0
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => [session],
          get: () => session,
          root: (id: string) => id,
          sync: async () => {
            syncCalls++
            if (syncCalls === 1) throw new Error("temporary hydration failure")
          },
          invalidate: () => {},
        },
      },
      coordinator: {
        system: async (id: string, fn: () => Promise<void>) => {
          notificationIDs.push(id)
          return fn()
        },
      },
    })

    return dispose
  })

  try {
    emit({ type: "session.execution.succeeded", id: "transient-hydration-complete", data: { sessionID: session.id } })
    await waitFor(() => syncCalls === 1, "initial failed hydration")
    await Promise.resolve()
    expect(notificationIDs).toEqual([])

    await waitFor(() => notificationIDs.length === 1, "bounded deferred recovery")
    expect(syncCalls).toBe(2)
    expect(notificationIDs).toEqual([`${server}\0transient-hydration-complete`])
    expect(alerts).toEqual(["notification.session.responseReady.title"])
  } finally {
    dispose()
  }
})

test("backs off failed online overflow recovery until reconnect", async () => {
  alerts.length = 0
  tabs.store = [{ type: "session", server, sessionId: session.id }]
  const root = { ...session, time: { idle: 2 } }
  const pendingSessions = Array.from({ length: 256 }, (_, index) => ({
    ...session,
    id: `failed-overflow-${index}`,
    time: { idle: 1 },
  }))
  const sessions = [root, ...pendingSessions]
  const listeners = new Array<(event: OpenCodeEvent) => void>()
  const notificationIDs: string[] = []
  let rootSyncs = 0
  let pendingHydrationCalls = 0
  let allowPendingHydration = false
  let releasePendingHydration = () => {}
  const pendingHydration = new Promise<void>((resolve) => {
    releasePendingHydration = resolve
  })
  const emit = (event: unknown) => listeners.forEach((listener) => listener(event as OpenCodeEvent))

  const dispose = createRoot((dispose) => {
    createState({
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: {
          listen: (listener: (event: OpenCodeEvent) => void) => {
            listeners.push(listener)

            return () => {}
          },
        },
      },
      data: {
        session: {
          list: () => sessions,
          get: (id: string) => sessions.find((item) => item.id === id),
          root: (id: string) => id,
          sync: async (id: string) => {
            if (id === root.id) {
              rootSyncs++
              if (rootSyncs === 1) throw new Error("offline")
              return
            }

            pendingHydrationCalls++
            if (!allowPendingHydration) await pendingHydration
          },
        },
      },
      coordinator: {
        system: async (id: string, fn: () => Promise<void>) => {
          notificationIDs.push(id)
          return fn()
        },
      },
    })

    return dispose
  })

  pendingSessions.forEach((pending) =>
    emit({ type: "session.execution.succeeded", id: `${pending.id}-complete`, data: { sessionID: pending.id } }),
  )
  await waitFor(() => pendingHydrationCalls === 256, "failed recovery pending hydration")

  emit({ type: "session.execution.succeeded", id: "failed-overflow-root-complete", data: { sessionID: root.id } })
  await waitFor(() => rootSyncs === 1, "failed online recovery hydration")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(rootSyncs).toBe(1)
  expect(notificationIDs).toEqual([])
  expect(alerts).toEqual([])

  allowPendingHydration = true
  releasePendingHydration()
  await new Promise((resolve) => setTimeout(resolve, 0))
  emit({ type: "server.connected" })
  await waitFor(() => notificationIDs.length === 1, "recovery after reconnect")
  expect(notificationIDs).toEqual([`${server}\0failed-overflow-root-complete`])
  expect(alerts).toEqual(["notification.session.responseReady.title"])
  dispose()
})

test("manual unread edits wait for desktop storage to load", async () => {
  const loaded = Promise.withResolvers<string | null>()

  const hydrated = Promise.withResolvers<void>()

  desktopStorage.set("desktop", {
    getItem: (key) => (key === "notification.manual-unread" ? loaded.promise : Promise.resolve(null)),
    setItem: async () => {},
    removeItem: async () => {},
  })

  const mounted = createRoot((dispose) => {
    const state = createState({
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: { listen: () => () => {} },
      },
      data: {
        session: {
          root: (id: string) => id,
          get: () => ({ id: "desktop-marked", time: { idle: 1, viewed: 1 } }),
        },
      },
      coordinator: {},
    })

    createEffect(() => {
      if (state.session.ready()) hydrated.resolve()
    })

    return { dispose, state }
  })

  try {
    expect(mounted.state.session.ready()).toBe(false)
    mounted.state.session.opened("desktop-marked")
    mounted.state.session.markUnread("desktop-new")
    loaded.resolve(JSON.stringify({ sessions: ["desktop-marked", "desktop-other"] }))
    await hydrated.promise
    expect(mounted.state.session.manuallyUnread("desktop-marked")).toBe(false)
    expect(mounted.state.session.manuallyUnread("desktop-other")).toBe(true)
    expect(mounted.state.session.manuallyUnread("desktop-new")).toBe(true)
  } finally {
    mounted.dispose()
  }
})

test("manual unread marks survive remounts and clear on read, reopen or deletion", () => {
  const views: { sessionID: string; idle: number }[] = []

  const listeners = new Set<(event: OpenCodeEvent) => void>()

  const [sessions, setSessions] = createStore({
    marked: { id: "manual-marked", time: { idle: 3, viewed: 3 }, location: { directory: "/manual" } },
    other: { id: "manual-other", time: { idle: 4, viewed: 4 }, location: { directory: "/manual" } },
  })

  const start = () =>
    createRoot((dispose) => ({
      dispose,
      state: createState({
        sdk: {
          scope: ServerScope.local,
          connection: { status: () => "connected" },
          event: {
            listen: (listener: (event: OpenCodeEvent) => void) => {
              listeners.add(listener)

              return () => listeners.delete(listener)
            },
          },
          api: {
            session: {
              view: async (input: { sessionID: string; idle: number }) => {
                views.push(input)
                setSessions("marked", "time", "viewed", input.idle)
              },
            },
          },
        },
        data: {
          session: {
            root: (id: string) => (id === "manual-child" ? sessions.marked.id : id),
            get: (id: string) => Object.values(sessions).find((session) => session.id === id),
            list: () => Object.values(sessions),
          },
        },
        coordinator: {},
      }),
    }))

  vi.useFakeTimers()
  const first = start()

  try {
    first.state.session.markUnread("manual-child")
    first.state.session.markUnread(sessions.marked.id)
    first.state.session.markUnread(sessions.other.id)
    expect(first.state.session.unread("manual-child")).toBe(true)
    expect(first.state.project.hasUnread("/manual")).toBe(true)
    expect(views).toEqual([])
    vi.runOnlyPendingTimers()
    first.dispose()

    const second = start()

    try {
      expect(second.state.session.unread(sessions.marked.id)).toBe(true)
      second.state.session.markRead("manual-child")
      expect(second.state.session.unread(sessions.marked.id)).toBe(false)
      expect(second.state.session.unread(sessions.other.id)).toBe(true)
      expect(views).toEqual([])
      second.state.session.markUnread(sessions.marked.id)
      setSessions("marked", "time", "idle", 5)
      second.state.session.markViewed("manual-child")
      expect(second.state.session.unread(sessions.marked.id)).toBe(true)
      second.state.session.opened("manual-child")
      expect(second.state.session.unread(sessions.marked.id)).toBe(false)
      second.state.session.markUnread(sessions.marked.id)
      listeners.forEach((listener) =>
        listener({
          type: "session.deleted",
          id: "manual-deleted",
          created: 0,
          location: sessions.marked.location,
          data: { sessionID: sessions.marked.id },
        }),
      )
      expect(second.state.session.unread(sessions.marked.id)).toBe(false)
      second.state.project.markViewed("/manual")
      expect(second.state.project.hasUnread("/manual")).toBe(false)

      setSessions("marked", "time", "idle", 6)
      second.state.session.markRead(sessions.marked.id)
      expect(views).toEqual([
        { sessionID: sessions.marked.id, idle: 5 },
        { sessionID: sessions.marked.id, idle: 6 },
      ])
      expect(second.state.session.unread(sessions.marked.id)).toBe(false)
    } finally {
      second.dispose()
    }
  } finally {
    first.dispose()
    vi.useRealTimers()
  }
})

test("unread state and viewing follow the server's idle and viewed watermarks", async () => {
  const views: { sessionID: string; idle: number }[] = []
  const failures = { remaining: 1 }

  type Info = {
    id: string
    parentID?: string
    time: { idle?: number; viewed?: number; archived?: number }
    location: { directory: string }
  }

  const [store, setStore] = createStore<{ viewing?: string; sessions: Record<string, Info> }>({
    sessions: {
      root: { id: "root", time: { idle: 2, viewed: 1 }, location: { directory: "/project" } },
      child: { id: "child", parentID: "root", time: { idle: 5 }, location: { directory: "/project" } },
      read: { id: "read", time: { idle: 3, viewed: 3 }, location: { directory: "/project" } },
      archived: { id: "archived", time: { idle: 4, archived: 1 }, location: { directory: "/project" } },
      other: { id: "other", time: { idle: 4 }, location: { directory: "/other" } },
    },
  })

  const dispose = createRoot((dispose) => {
    const state = createState({
      sdk: {
        scope: ServerScope.local,
        connection: { status: () => "connected" },
        event: { listen: () => () => {} },
        api: {
          session: {
            view: async (input: { sessionID: string; idle: number }) => {
              views.push(input)

              if (failures.remaining-- > 0) throw new Error("offline")
            },
          },
        },
      },
      data: {
        session: {
          get: (id: string) => store.sessions[id],
          root: (id: string) => store.sessions[id]?.parentID ?? id,
          list: () => Object.values(store.sessions),
        },
      },
      coordinator: {},
    })

    // Mirrors the session route, which re-runs markViewed whenever what it reads changes.
    createEffect(() => {
      if (store.viewing) state.session.markViewed(store.viewing)
    })

    return { dispose, state }
  })

  const state = dispose.state

  // Unread reads the root session; children and archived sessions never mark a project unread.
  expect(["root", "child", "read", "other"].map((id) => state.session.unread(id))).toEqual([true, true, false, true])
  expect(state.project.hasUnread("/project")).toBe(true)

  // Viewing a child acknowledges its root's idle watermark; a failed report retries after a backoff.
  setStore("viewing", "child")
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(views).toEqual([{ sessionID: "root", idle: 2 }])
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(views).toEqual([
    { sessionID: "root", idle: 2 },
    { sessionID: "root", idle: 2 },
  ])

  setStore("sessions", "root", "time", "viewed", 2)
  expect(state.session.unread("root")).toBe(false)
  expect(state.project.hasUnread("/project")).toBe(false)

  // A newer turn while the session stays open makes it unread and reports the new watermark once.
  setStore("sessions", "root", "time", "idle", 6)
  expect(state.session.unread("root")).toBe(true)
  state.project.markViewed("/project")
  expect(views.slice(2)).toEqual([{ sessionID: "root", idle: 6 }])

  // Menu and Inbox actions mark sessions viewed from event handlers, with nothing to re-run them: a failed report
  // still retries on its own, and a sibling's success does not cancel that retry.
  setStore("viewing", undefined)
  setStore("sessions", "root", "time", "idle", 8)
  failures.remaining = 1
  state.project.markViewed("/project")
  state.project.markViewed("/other")
  expect(views.slice(3)).toEqual([
    { sessionID: "root", idle: 8 },
    { sessionID: "other", idle: 4 },
  ])
  await new Promise((resolve) => setTimeout(resolve, 300))
  expect(views.slice(5)).toEqual([{ sessionID: "root", idle: 8 }])
  dispose.dispose()
})

test("unread state honours the old local list until its viewed state is carried to the server, then deletes it", async () => {
  const key = "opencode.global.dat:notification"
  const lists: unknown[] = []
  const views: { sessionID: string; idle: number }[] = []
  const failures = { remaining: 1 }

  // The old list was found at time 10: sessions that went idle by then were read here unless the list says otherwise.
  vi.useFakeTimers()
  setSystemTime(new Date(10))
  localStorage.setItem(
    key,
    JSON.stringify({
      list: [
        { type: "turn-complete", time: 1, viewed: true, session: "read-here" },
        { type: "turn-complete", time: 2, viewed: false, session: "unread-here" },
      ],
    }),
  )

  const sessions = [
    { id: "read-here", time: { idle: 5 } },
    { id: "unread-here", time: { idle: 6 } },
    { id: "viewed", time: { idle: 4, viewed: 4 } },
    { id: "untracked", time: { idle: 7, viewed: 3 } },
    { id: "new", time: { idle: 20 } },
    { id: "never-ran", time: {} },
  ]

  const start = () =>
    createRoot((dispose) => ({
      dispose,
      state: createState({
        sdk: {
          scope: ServerScope.local,
          connection: { status: () => "connected" },
          event: { listen: () => () => {} },
          api: {
            session: {
              list: async (input: { cursor?: string }) => {
                lists.push(input)

                return input.cursor
                  ? { data: sessions.slice(3), cursor: {} }
                  : { data: sessions.slice(0, 3), cursor: { next: "second" } }
              },
              view: async (input: { sessionID: string; idle: number }) => {
                views.push(input)

                if (failures.remaining-- > 0) throw new Error("offline")
              },
            },
          },
        },
        data: { session: { get: () => undefined, root: (id: string) => id } },
        coordinator: {},
      }),
    }))

  // Sessions come from fetched snapshots here, like home rows for sessions that aren't loaded.
  const unread = (state: ReturnType<typeof start>["state"]) =>
    sessions.flatMap((session) =>
      // SAFETY: the snapshots carry the id and time fields unread state reads.
      state.session.unread(session.id, session as never) ? [session.id] : [],
    )

  // Advances fake time, then lets the mocked requests it started settle.
  const advance = async (ms: number) => {
    vi.advanceTimersByTime(ms)

    for (const _ of Array.from({ length: 50 })) await Promise.resolve()
  }

  const first = start()
  // localStorage holds the old list, so it is read at once: nothing read here lights up, while a session that went
  // idle after the list was found is new.
  expect(unread(first.state)).toEqual(["unread-here", "new"])

  // The carry-over waits for startup to settle, then a failed report keeps the list for the next connection.
  await advance(4_000)
  expect(lists).toEqual([])
  await advance(1_000)
  expect(views).toEqual([{ sessionID: "read-here", idle: 5 }])
  expect(JSON.parse(localStorage.getItem(key) ?? "null")).toMatchObject({ started: 10 })
  first.dispose()

  // A later start keeps the first start's cutoff, reports every page, then deletes the list without anything flashing.
  setSystemTime(new Date(100))
  lists.length = 0
  views.length = 0
  const second = start()
  await advance(0)
  expect(unread(second.state)).toEqual(["unread-here", "new"])
  await advance(5_000)
  expect(lists).toEqual([
    { limit: 200, order: "desc", parentID: null },
    { limit: 200, order: "desc", parentID: null, cursor: "second" },
  ])
  expect(views).toEqual([
    { sessionID: "read-here", idle: 5 },
    { sessionID: "untracked", idle: 7 },
  ])
  expect(localStorage.getItem(key)).toBeNull()
  expect(unread(second.state)).toEqual(["unread-here", "new"])
  second.dispose()

  // Without the old list, later starts never touch the server's viewed state.
  const third = start()
  await advance(5_000)
  expect(lists).toHaveLength(2)
  expect(views).toHaveLength(2)
  third.dispose()
  vi.useRealTimers()
  setSystemTime()
})
