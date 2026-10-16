import { createStore, reconcile } from "solid-js/store"
import { Schema } from "effect"
import { SessionError } from "@opencode/schema/session-error"
import { batch, createEffect, onCleanup } from "solid-js"
import type { ServerSDK } from "@/runtime/server/client"
import type { Data } from "@opencode/client/solid"
import type { LocationRef, OpenCodeEvent } from "@opencode/client/promise"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { playSoundById } from "@/shell/notifications/sound"
import type { createNotificationCoordinator } from "@/shell/notifications/coordinator"
import { ServerConnection } from "@/runtime/server/registry"
import { sessionIDHasOpenTab, useTabs } from "@/shell/tabs/tabs"
import { sessionHref } from "@/shell/routes/session"
import { useServer } from "@/runtime/server/current"

const NotificationBase = {
  directory: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
  time: Schema.Finite,
  viewed: Schema.Boolean,
}

export const Notification = Schema.Union([
  Persistence.struct({ ...NotificationBase, type: Schema.Literal("turn-complete") }),
  Persistence.struct({ ...NotificationBase, type: Schema.Literal("error"), error: SessionError.Error }),
])

export type Notification = typeof Notification.Type

export const NotificationStore = Persistence.struct({ list: Persistence.array(Notification) })

type NotificationIndex = {
  session: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
  project: {
    all: Record<string, Notification[]>
    unseen: Record<string, Notification[]>
    unseenCount: Record<string, number>
    unseenHasError: Record<string, boolean>
  }
}

type NotificationTabs = Pick<ReturnType<typeof useTabs>, "addSessionTab" | "rememberSessionRoute" | "select">

export function openNotificationSession(tabs: NotificationTabs, server: ServerConnection.Key, sessionID: string) {
  const tab = tabs.addSessionTab({ server, sessionId: sessionID })

  if (tab.type !== "session") return
  tabs.rememberSessionRoute(tab, sessionID)
  tabs.select(tab)
}

const MAX_NOTIFICATIONS = 500

const NOTIFICATION_TTL_MS = 1000 * 60 * 60 * 24 * 30

const MAX_TERMINAL_MARKERS = 256

const MAX_DELETED_MARKERS = 256

const MAX_PENDING_LIFECYCLE_EVENTS = 1024

type TerminalEvent = Extract<
  OpenCodeEvent,
  { type: "session.execution.succeeded" | "session.execution.failed" }
>

type LifecycleEvent = Extract<
  OpenCodeEvent,
  {
    type:
      | "session.execution.started"
      | "session.execution.succeeded"
      | "session.execution.failed"
      | "session.execution.interrupted"
  }
>

function pruneNotifications(list: Notification[]) {
  const cutoff = Date.now() - NOTIFICATION_TTL_MS
  const pruned = list.filter((n) => n.time >= cutoff)

  if (pruned.length <= MAX_NOTIFICATIONS) return pruned

  return pruned.slice(pruned.length - MAX_NOTIFICATIONS)
}

function createNotificationIndex(): NotificationIndex {
  return {
    session: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
    project: {
      all: {},
      unseen: {},
      unseenCount: {},
      unseenHasError: {},
    },
  }
}

function buildNotificationIndex(list: Notification[]) {
  const index = createNotificationIndex()

  list.forEach((notification) => {
    if (notification.session) {
      const all = index.session.all[notification.session] ?? []
      index.session.all[notification.session] = [...all, notification]

      if (!notification.viewed) {
        const unseen = index.session.unseen[notification.session] ?? []
        index.session.unseen[notification.session] = [...unseen, notification]
        index.session.unseenCount[notification.session] = unseen.length + 1

        if (notification.type === "error") index.session.unseenHasError[notification.session] = true
      }
    }

    if (notification.directory) {
      const all = index.project.all[notification.directory] ?? []
      index.project.all[notification.directory] = [...all, notification]

      if (!notification.viewed) {
        const unseen = index.project.unseen[notification.directory] ?? []
        index.project.unseen[notification.directory] = [...unseen, notification]
        index.project.unseenCount[notification.directory] = unseen.length + 1

        if (notification.type === "error") index.project.unseenHasError[notification.directory] = true
      }
    }
  })

  return index
}

export function createServerNotificationState(input: {
  sdk: ServerSDK
  data: Data
  key: ServerConnection.Key
  coordinator: ReturnType<typeof createNotificationCoordinator>
}) {
  const platform = usePlatform()
  const settings = useSettings()
  const language = useLanguage()
  const tabs = useTabs()
  const empty: Notification[] = []

  const [store, setStore, _, ready] = persisted(
    Persist.serverGlobal(input.sdk.scope, "notification"),
    NotificationStore,
    { list: [] },
  )

  const [index, setIndex] = createStore<NotificationIndex>(buildNotificationIndex(store.list))

  const meta = { pruned: false, disposed: false }
  const terminal = new Map<string, string>()
  const deferred = new Map<string, { eventID: string; time: number }>()
  const running = new Set<string>()
  const parents = new Map<string, string | undefined>()
  const shells = new Map<string, { ownerSessionID: string; ancestors: Set<string>; location: LocationRef }>()
  const deleted = new Set<string>()
  const pendingLifecycleEvents: { event: LifecycleEvent; time: number }[] = []
  let pendingLifecycleOverflowed = false

  const updateUnseen = (scope: "session" | "project", key: string, unseen: Notification[]) => {
    setIndex(scope, "unseen", key, unseen)
    setIndex(scope, "unseenCount", key, unseen.length)
    setIndex(
      scope,
      "unseenHasError",
      key,
      unseen.some((notification) => notification.type === "error"),
    )
  }

  const appendToIndex = (notification: Notification) => {
    if (notification.session) {
      setIndex("session", "all", notification.session, (all = []) => [...all, notification])

      if (!notification.viewed) {
        setIndex("session", "unseen", notification.session, (unseen = []) => [...unseen, notification])
        setIndex("session", "unseenCount", notification.session, (count = 0) => count + 1)

        if (notification.type === "error") setIndex("session", "unseenHasError", notification.session, true)
      }
    }

    if (notification.directory) {
      setIndex("project", "all", notification.directory, (all = []) => [...all, notification])

      if (!notification.viewed) {
        setIndex("project", "unseen", notification.directory, (unseen = []) => [...unseen, notification])
        setIndex("project", "unseenCount", notification.directory, (count = 0) => count + 1)

        if (notification.type === "error") setIndex("project", "unseenHasError", notification.directory, true)
      }
    }
  }

  const removeFromIndex = (notification: Notification) => {
    if (notification.session) {
      setIndex("session", "all", notification.session, (all = []) => all.filter((n) => n !== notification))

      if (!notification.viewed) {
        const unseen = (index.session.unseen[notification.session] ?? empty).filter((n) => n !== notification)
        updateUnseen("session", notification.session, unseen)
      }
    }

    if (notification.directory) {
      setIndex("project", "all", notification.directory, (all = []) => all.filter((n) => n !== notification))

      if (!notification.viewed) {
        const unseen = (index.project.unseen[notification.directory] ?? empty).filter((n) => n !== notification)
        updateUnseen("project", notification.directory, unseen)
      }
    }
  }

  createEffect(() => {
    if (!ready()) return

    if (meta.pruned) return
    meta.pruned = true
    const list = pruneNotifications(store.list)
    batch(() => {
      setStore("list", list)
      setIndex(reconcile(buildNotificationIndex(list), { merge: false }))
    })
  })

  const append = (notification: Notification) => {
    const list = pruneNotifications([...store.list, notification])
    const keep = new Set(list)
    const removed = store.list.filter((n) => !keep.has(n))

    batch(() => {
      if (keep.has(notification)) appendToIndex(notification)
      removed.forEach((n) => removeFromIndex(n))
      setStore("list", list)
    })
  }

  const lookup = async (sessionID?: string) => {
    if (!sessionID) return undefined
    const session = input.data.session.get(sessionID)

    if (session) return session

    return input.data.session
      .sync(sessionID)
      .then(() => input.data.session.get(sessionID))
      .catch(() => undefined)
  }

  const viewedInCurrentSession = (sessionID: string) => {
    return typeof location !== "undefined" && location.pathname === sessionHref(input.key, sessionID)
  }

  const pruneTerminal = () => {
    if (terminal.size <= MAX_TERMINAL_MARKERS) return

    const protectedSessions = new Set([
      ...input.data.session.list().map((session) => session.id),
      ...running,
      ...deferred.keys(),
    ])
    for (const sessionID of terminal.keys()) {
      if (terminal.size <= MAX_TERMINAL_MARKERS) break
      if (protectedSessions.has(sessionID)) continue
      terminal.delete(sessionID)
    }
  }

  const rememberDeleted = (sessionID: string) => {
    deleted.add(sessionID)
    if (deleted.size <= MAX_DELETED_MARKERS) return

    const oldest = deleted.values().next().value
    if (oldest !== undefined) deleted.delete(oldest)
  }

  const refreshShellAncestors = () => {
    for (const shell of shells.values()) shell.ancestors = shellAncestors(shell.ownerSessionID)
  }

  const reconcileShells = () => {
    for (const shellID of shells.keys()) {
      const shell = input.data.shell.get(shellID)
      if (!shell || shell.status !== "running") shells.delete(shellID)
    }
  }

  const synchronize = (reconnect = false) => {
    const sessions = input.data.session.list()

    if (reconnect) reconcileShells()

    for (const session of sessions) {
      if (deleted.has(session.id)) continue
      parents.set(session.id, session.parentID)
      if (!reconnect) continue

      if (input.data.session.status(session.id) === "running") {
        terminal.delete(session.id)
        deferred.delete(session.id)
        running.add(session.id)
        continue
      }
      running.delete(session.id)
    }

    const retained = new Set([...running, ...deferred.keys()])
    for (const shell of shells.values()) {
      retained.add(shell.ownerSessionID)
      shell.ancestors.forEach((ancestorID) => retained.add(ancestorID))
    }

    for (const sessionID of retained) {
      const seen = new Set<string>()
      let currentID: string | undefined = sessionID
      while (currentID && !seen.has(currentID)) {
        seen.add(currentID)
        retained.add(currentID)
        const session = input.data.session.get(currentID)
        if (session) parents.set(currentID, session.parentID)
        else if (!parents.has(currentID)) parents.set(currentID, undefined)
        const currentParentID = parents.get(currentID)
        if (!currentParentID) break
        currentID = currentParentID
      }
    }

    refreshShellAncestors()

    for (const sessionID of parents.keys()) {
      if (!retained.has(sessionID)) parents.delete(sessionID)
    }

    pruneTerminal()
  }

  const parentID = (sessionID: string) => {
    if (parents.has(sessionID)) return parents.get(sessionID)
    return input.data.session.get(sessionID)?.parentID
  }

  const shellAncestors = (sessionID: string) => {
    const ancestors = new Set<string>()
    const seen = new Set<string>()
    let currentID: string | undefined = sessionID

    while (currentID) {
      if (seen.has(currentID)) break
      seen.add(currentID)
      const currentParentID = parentID(currentID)
      if (!currentParentID || seen.has(currentParentID)) break
      ancestors.add(currentParentID)
      currentID = currentParentID
    }

    return ancestors
  }

  const listShellsBySession = (sessionID: string) => {
    if (input.data.shell.listBySession) return input.data.shell.listBySession(sessionID)
    return input.data.shell
      .list(input.data.location?.default?.())
      .filter((shell) => shell.metadata.sessionID === sessionID)
  }

  const isDescendant = (sessionID: string, ancestorID: string) => {
    if (sessionID === ancestorID) return false

    const seen = new Set<string>()
    let currentID: string | undefined = sessionID
    while (currentID && !seen.has(currentID)) {
      seen.add(currentID)
      const currentParentID = parentID(currentID)
      if (!currentParentID) return false
      if (currentParentID === ancestorID) return true
      currentID = currentParentID
    }

    return input.data.session.family(ancestorID).includes(sessionID)
  }

  const hasRunningBackground = (sessionID: string) => {
    synchronize()
    const sessions = input.data.session.list()
    const candidates = new Set([
      ...sessions.map((session) => session.id),
      ...input.data.session.family(sessionID),
      ...running,
    ])
    const descendants = [...candidates].filter((candidateID) => isDescendant(candidateID, sessionID))

    if (
      descendants.some(
        (candidateID) =>
          !deleted.has(candidateID) &&
          !terminal.has(candidateID) &&
          (running.has(candidateID) || input.data.session.status(candidateID) === "running"),
      )
    )
      return true

    if (
      pendingLifecycleEvents.some(
        ({ event }) => !deleted.has(event.data.sessionID) && isDescendant(event.data.sessionID, sessionID),
      )
    )
      return true

    if (
      [...shells.values()].some(
        (shell) => shell.ownerSessionID === sessionID || shell.ancestors.has(sessionID),
      )
    )
      return true

    return [sessionID, ...descendants].some((candidateID) =>
      listShellsBySession(candidateID).some((shell) => shell.status === "running"),
    )
  }

  const notifySessionIdle = (sessionID: string, eventID: string, time: number, session: NonNullable<Awaited<ReturnType<typeof lookup>>>) => {
    const hasOpenTab = sessionIDHasOpenTab(tabs.store, input.key, sessionID)

    if (hasOpenTab && settings.sounds.agentEnabled()) {
      void input.coordinator.sound(`${input.key}\0${eventID}`, () => playSoundById(settings.sounds.agent()))
    }

    append({
      directory: session.location.directory,
      time,
      viewed: viewedInCurrentSession(sessionID),
      type: "turn-complete",
      session: sessionID,
    })

    if (hasOpenTab && settings.notifications.agent()) {
      void input.coordinator.system(`${input.key}\0${eventID}`, () =>
        platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, () =>
          openNotificationSession(tabs, input.key, sessionID),
        ),
      )
    }
  }

  const flushDeferred = () => {
    if (reconnecting || pendingLifecycleOverflowed) return

    for (const [sessionID, pending] of deferred) {
      if (deleted.has(sessionID) || terminal.get(sessionID) !== pending.eventID || hasRunningBackground(sessionID)) continue

      deferred.delete(sessionID)
      void lookup(sessionID).then((session) => {
        if (
          meta.disposed ||
          deleted.has(sessionID) ||
          terminal.get(sessionID) !== pending.eventID ||
          !session ||
          session.parentID
        )
          return
        if (hasRunningBackground(sessionID)) {
          deferred.set(sessionID, pending)
          return
        }
        notifySessionIdle(sessionID, pending.eventID, pending.time, session)
      })
    }
  }

  let reconnecting: Promise<void> | undefined

  const processTerminalEvent = (event: TerminalEvent, time: number) => {
    if (deleted.has(event.data.sessionID) || terminal.has(event.data.sessionID)) return
    terminal.set(event.data.sessionID, event.id)
    running.delete(event.data.sessionID)
    pruneTerminal()

    if (event.type === "session.execution.failed") {
      deferred.delete(event.data.sessionID)
      handleSessionError(event.data.sessionID, event.data.error, event.id, time)
      flushDeferred()
      return
    }

    handleSessionIdle(event.data.sessionID, event.id, time)
    flushDeferred()
  }

  const processLifecycleEvent = (event: LifecycleEvent, time: number) => {
    if (event.type === "session.execution.started") {
      if (deleted.has(event.data.sessionID)) return
      terminal.delete(event.data.sessionID)
      deferred.delete(event.data.sessionID)
      running.add(event.data.sessionID)
      return
    }

    if (event.type === "session.execution.interrupted") {
      if (deleted.has(event.data.sessionID)) return
      running.delete(event.data.sessionID)
      deferred.delete(event.data.sessionID)
      flushDeferred()
      return
    }

    processTerminalEvent(event, time)
  }

  const flushPendingLifecycleEvents = () => {
    if (pendingLifecycleOverflowed) {
      // A partial batch could make a terminal event look like a new execution.
      // Drop it conservatively instead of emitting a completion notification early.
      pendingLifecycleEvents.length = 0
      pendingLifecycleOverflowed = false
      return false
    }

    while (pendingLifecycleEvents.length) {
      const item = pendingLifecycleEvents.shift()
      if (item) processLifecycleEvent(item.event, item.time)
    }

    return true
  }

  const handleLifecycleEvent = (event: LifecycleEvent) => {
    const item = { event, time: Date.now() }
    if (reconnecting) {
      if (event.type !== "session.execution.started") {
        const latestStarted = pendingLifecycleEvents.findLastIndex(
          ({ event: pending }) =>
            pending.data.sessionID === event.data.sessionID && pending.type === "session.execution.started",
        )
        const existing = pendingLifecycleEvents.findIndex(
          ({ event: pending }, index) =>
            index > latestStarted && pending.data.sessionID === event.data.sessionID && pending.type === event.type,
        )
        if (existing >= 0) {
          pendingLifecycleEvents[existing] = item
          return
        }
      }

      if (pendingLifecycleEvents.length >= MAX_PENDING_LIFECYCLE_EVENTS) {
        pendingLifecycleOverflowed = true
        return
      }

      pendingLifecycleEvents.push(item)
      return
    }
    processLifecycleEvent(item.event, item.time)
  }

  const reconnect = () => {
    if (reconnecting) return reconnecting

    const locations = new Map<string, LocationRef>()
    const addLocation = (location: LocationRef) => {
      locations.set(`${location.directory}\0${location.workspaceID ?? ""}`, location)
    }
    for (const session of input.data.session.list()) addLocation(session.location)
    for (const shell of shells.values()) {
      addLocation(shell.location)
    }

    const sessionIDs = new Set<string>()
    const addSessionSyncCandidate = (sessionID: string) => {
      sessionIDs.add(sessionID)
      const rootID = input.data.session.root?.(sessionID)
      if (rootID) sessionIDs.add(rootID)
    }
    for (const session of input.data.session.list()) {
      if (!session.parentID) addSessionSyncCandidate(session.id)
    }
    for (const sessionID of [...running, ...deferred.keys()]) addSessionSyncCandidate(sessionID)
    for (const shell of shells.values()) addSessionSyncCandidate(shell.ownerSessionID)

    for (const location of locations.values()) input.data.shell.invalidate?.(location)
    for (const sessionID of sessionIDs) input.data.session.invalidate?.(sessionID)

    reconnecting = Promise.allSettled([
      ...[...locations.values()].map((location) => input.data.shell.sync(location)),
      ...(input.data.session.sync
        ? [...sessionIDs].map((sessionID) => input.data.session.sync(sessionID, { children: true }))
        : []),
      ])
      .then(() => {
        if (meta.disposed) return
        reconnecting = undefined
        synchronize(true)
        if (flushPendingLifecycleEvents()) flushDeferred()
      })
      .catch(() => undefined)
      .finally(() => {
        reconnecting = undefined
      })

    return reconnecting
  }

  const handleSessionIdle = (sessionID: string, eventID: string, time: number) => {
    const process = (session: Awaited<ReturnType<typeof lookup>>) => {
      if (meta.disposed || deleted.has(sessionID) || terminal.get(sessionID) !== eventID || !session || session.parentID)
        return

      if (hasRunningBackground(sessionID)) {
        deferred.set(sessionID, { eventID, time })
        return
      }

      notifySessionIdle(sessionID, eventID, time, session)
    }

    const session = input.data.session.get(sessionID)
    if (session) {
      process(session)
      return
    }
    void lookup(sessionID).then(process)
  }

  const handleSessionError = (sessionID: string, error: SessionError.Error, eventID: string, time: number) => {
    void lookup(sessionID).then((session) => {
      if (meta.disposed || deleted.has(sessionID) || terminal.get(sessionID) !== eventID) return

      if (session?.parentID) return

      const hasOpenTab = sessionIDHasOpenTab(tabs.store, input.key, sessionID)

      if (hasOpenTab && settings.sounds.errorsEnabled()) {
        void input.coordinator.sound(`${input.key}\0${eventID}`, () => playSoundById(settings.sounds.errors()))
      }

      append({
        directory: session?.location.directory,
        time,
        viewed: viewedInCurrentSession(sessionID),
        type: "error",
        session: sessionID,
        error,
      })

      const description =
        session?.title ??
        (typeof error === "string" ? error : language.t("notification.session.error.fallbackDescription"))

      if (hasOpenTab && settings.notifications.errors()) {
        void input.coordinator.system(`${input.key}\0${eventID}`, () =>
          platform.notify(language.t("notification.session.error.title"), description, () =>
            openNotificationSession(tabs, input.key, sessionID),
          ),
        )
      }
    })
  }

  const unsub = input.sdk.event.listen((event) => {
    if (event.type === "server.connected") {
      void reconnect()
      return
    }

    if (event.type === "session.created") {
      deleted.delete(event.data.sessionID)
      synchronize()
      parents.set(event.data.sessionID, event.data.parentID)
      refreshShellAncestors()
      flushDeferred()
      return
    }

    if (event.type === "session.deleted") {
      rememberDeleted(event.data.sessionID)
      running.delete(event.data.sessionID)
      terminal.delete(event.data.sessionID)
      deferred.delete(event.data.sessionID)
      synchronize()
      flushDeferred()
      return
    }

    if (event.type === "shell.created") {
      const sessionID = event.data.info.metadata.sessionID
      if (typeof sessionID !== "string" || event.data.info.status !== "running") {
        shells.delete(event.data.info.id)
        return
      }

      shells.set(event.data.info.id, {
        ownerSessionID: sessionID,
        ancestors: shellAncestors(sessionID),
        location: event.location ?? input.data.location.default(),
      })
      synchronize()
      return
    }

    if (event.type === "shell.exited" || event.type === "shell.deleted") {
      shells.delete(event.data.id)
      synchronize()
      flushDeferred()
      return
    }

    if (
      event.type !== "session.execution.started" &&
      event.type !== "session.execution.succeeded" &&
      event.type !== "session.execution.failed" &&
      event.type !== "session.execution.interrupted"
    )
      return

    handleLifecycleEvent(event)
  })

  onCleanup(() => {
    meta.disposed = true
    pendingLifecycleEvents.length = 0
    pendingLifecycleOverflowed = false
    unsub()
  })

  return {
    ready,
    session: {
      all(session: string) {
        return index.session.all[session] ?? empty
      },
      unseen(session: string) {
        return index.session.unseen[session] ?? empty
      },
      unseenCount(session: string) {
        return index.session.unseenCount[session] ?? 0
      },
      unseenHasError(session: string) {
        return index.session.unseenHasError[session] ?? false
      },
      markViewed(session: string) {
        const unseen = index.session.unseen[session] ?? empty

        if (!unseen.length) return

        const projects = [
          ...new Set(unseen.flatMap((notification) => (notification.directory ? [notification.directory] : []))),
        ]

        batch(() => {
          setStore("list", (n) => n.session === session && !n.viewed, "viewed", true)
          updateUnseen("session", session, [])
          projects.forEach((directory) => {
            const next = (index.project.unseen[directory] ?? empty).filter(
              (notification) => notification.session !== session,
            )

            updateUnseen("project", directory, next)
          })
        })
      },
    },
    project: {
      all(directory: string) {
        return index.project.all[directory] ?? empty
      },
      unseen(directory: string) {
        return index.project.unseen[directory] ?? empty
      },
      unseenCount(directory: string) {
        return index.project.unseenCount[directory] ?? 0
      },
      unseenHasError(directory: string) {
        return index.project.unseenHasError[directory] ?? false
      },
      markViewed(directory: string) {
        const unseen = index.project.unseen[directory] ?? empty

        if (!unseen.length) return

        const sessions = [
          ...new Set(unseen.flatMap((notification) => (notification.session ? [notification.session] : []))),
        ]

        batch(() => {
          setStore("list", (n) => n.directory === directory && !n.viewed, "viewed", true)
          updateUnseen("project", directory, [])
          sessions.forEach((session) => {
            const next = (index.session.unseen[session] ?? empty).filter(
              (notification) => notification.directory !== directory,
            )

            updateUnseen("session", session, next)
          })
        })
      },
    },
  }
}

export const useNotification = () => {
  const server = useServer()

  return server.ctx.notification
}
