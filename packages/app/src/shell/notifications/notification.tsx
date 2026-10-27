import { createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { Schema } from "effect"
import type { LocationRef, OpenCodeEvent, SessionInfo } from "@opencode/client/promise"
import type { ServerSDK } from "@/runtime/server/client"
import type { Data } from "@opencode/client/solid"
import { usePlatform } from "@/runtime/platform/platform"
import { useLanguage } from "@/runtime/i18n/language"
import { useSettings } from "@/settings/model"
import { Persist, persisted, removePersisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { playSoundById } from "@/shell/notifications/sound"
import type { createNotificationCoordinator } from "@/shell/notifications/coordinator"
import { ServerConnection } from "@/runtime/server/registry"
import { sessionIDHasOpenTab, useTabs } from "@/shell/tabs/tabs"
import { useServer } from "@/runtime/server/current"

type NotificationTabs = Pick<ReturnType<typeof useTabs>, "addSessionTab" | "rememberSessionRoute" | "select">

export function openNotificationSession(tabs: NotificationTabs, server: ServerConnection.Key, sessionID: string) {
  const tab = tabs.addSessionTab({ server, sessionId: sessionID })

  if (tab.type !== "session") return
  tabs.rememberSessionRoute(tab, sessionID)
  tabs.select(tab)
}

/** A session is unread when its latest terminal execution is newer than the last one any client viewed. */
function isSessionUnread(session?: Pick<SessionInfo, "time">) {
  const time = session?.time

  return time?.idle !== undefined && (time.viewed === undefined || time.idle > time.viewed)
}

// The list Desktop kept before unread state moved to the server. Until its viewed state reaches the server, unread
// state still honours it, so sessions read here don't light up while the server catches up.
const LegacyNotificationStore = Persistence.struct({
  list: Schema.optional(
    Persistence.array(Persistence.struct({ session: Schema.optional(Schema.String), viewed: Schema.Boolean })),
  ),
  // When this client first found the list. Sessions that went idle later are new, whatever the list says.
  started: Schema.optional(Schema.Finite),
})

// The carry-over waits this long after connecting so it doesn't compete with startup requests.
const LEGACY_MIGRATION_DELAY = 5_000

const LEGACY_MIGRATION_PAGE = 200

const LEGACY_MIGRATION_CONCURRENCY = 4

const VIEW_RETRY_DELAY = 250

const VIEW_RETRY_MAX_DELAY = 5_000

const MAX_TERMINAL_MARKERS = 256

const MAX_HYDRATED_ROOTS = 256

const MAX_DELETED_MARKERS = 256

const MAX_PENDING_LIFECYCLE_EVENTS = 1024

const RECONNECT_DEADLINE = 10_000

const DEFERRED_RECOVERY_DELAY = 250

const MAX_DEFERRED_RECOVERY_ATTEMPTS = 3

type TerminalMarker = {
  eventID: string
  generation: number
  type: "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted"
  notified: boolean
  processed: boolean
  idle?: number
}

type DeferredCompletion = {
  eventID: string
  generation: number
}

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

type OverflowTerminalEvent = Extract<
  LifecycleEvent,
  {
    type: "session.execution.succeeded" | "session.execution.failed" | "session.execution.interrupted"
  }
>

type OverflowTerminal = {
  event: OverflowTerminalEvent
  generation: number
}

type LifecycleRecoveryResult = {
  success: boolean
  progressed: boolean
  retry: boolean
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
  const disposed = { value: false }
  // An active or unprocessed terminal event is retained so replayed events cannot notify twice while it is handled.
  const terminal = new Map<string, TerminalMarker>()
  // A root completion waits here while descendants or shells are still running.
  const deferred = new Map<string, DeferredCompletion>()
  const running = new Set<string>()
  const parents = new Map<string, string | undefined>()
  const shells = new Map<
    string,
    { ownerSessionID: string; ancestors: Set<string>; location: LocationRef | undefined }
  >()
  const deleted = new Set<string>()
  const pendingLifecycleEvents: LifecycleEvent[] = []
  const overflowedSessions = new Set<string>()
  const overflowedTerminalEvents = new Map<string, OverflowTerminal>()
  const executionGenerations = new Map<string, number>()
  const hydrating = new Map<string, Promise<boolean>>()
  const lookingUp = new Map<string, Promise<SessionInfo | undefined>>()
  const failedLookups = new Set<string>()
  const hydrated = new Set<string>()
  const settlingDeferred = new Set<string>()
  let reconnecting: Promise<void> | undefined
  let cancelReconnectDeadline: (() => void) | undefined
  let reconnectAttempt = 0
  // A successful reconnect snapshot overrides stale session status until lifecycle events update it again.
  let activeSessionIDs: Set<string> | undefined
  // Only retry after a state change observed during an async settlement; otherwise a blocked root would self-loop.
  let deferredRevision = 0
  let deferredFlushScheduled = false
  let pendingLifecycleOverflowed = false
  let lifecycleOverflowRecovery: Promise<void> | undefined
  let lifecycleOverflowRecoveryPending = false
  let deferredRecoveryTimer: ReturnType<typeof setTimeout> | undefined
  let deferredRecoveryAttempts = 0
  // Idle watermarks already reported per root session, so reactive re-runs don't re-post them.
  const acknowledged = new Map<string, number>()
  // A failed view report re-runs the tracking caller with backoff, like the TUI.
  const [state, setState] = createStore({ viewRetry: 0, legacyMigrated: false })
  let viewRetryTimer: ReturnType<typeof setTimeout> | undefined
  let viewRetryAttempt = 0
  onCleanup(() => clearTimeout(viewRetryTimer))

  const executionGeneration = (sessionID: string) => executionGenerations.get(sessionID) ?? 0

  const advanceExecutionGeneration = (sessionID: string) => {
    const generation = executionGeneration(sessionID) + 1
    executionGenerations.set(sessionID, generation)
    return generation
  }

  const isCurrentAttempt = (attempt: number) => !disposed.value && reconnectAttempt === attempt

  const isCurrentCompletion = (sessionID: string, eventID: string, generation: number, attempt: number) => {
    const marker = terminal.get(sessionID)
    return (
      isCurrentAttempt(attempt) &&
      marker?.eventID === eventID &&
      marker?.generation === generation
    )
  }

  const legacyTarget = Persist.serverGlobal(input.sdk.scope, "notification")
  const [legacy, setLegacy, , legacyReady] = persisted(legacyTarget, LegacyNotificationStore, {}, platform)
  const started = Date.now()
  const legacyStarted = () => legacy.started ?? started

  // Sessions the old list still had unread, while its viewed state hasn't reached the server yet.
  const legacyUnseen = createMemo(() => {
    const list = legacy.list

    if (!list || state.legacyMigrated) return

    return new Set(list.flatMap((item) => (!item.viewed && item.session ? [item.session] : [])))
  })

  // Idle watermarks the carry-over reported, so rows drawn from an older fetched copy of a session stay read.
  const legacyReported = new Map<string, number>()

  const unread = (session?: Pick<SessionInfo, "id" | "time">) => {
    const idle = session?.time.idle

    // Until the old list is read, a session it had read could flash unread.
    if (!legacyReady() || !session || idle === undefined || !isSessionUnread(session)) return false

    if (idle <= (legacyReported.get(session.id) ?? -Infinity)) return false
    const unseen = legacyUnseen()

    return !unseen || unseen.has(session.id) || idle > legacyStarted()
  }

  // Carry the old list's viewed state to the server in the background: page through every root session and report
  // the ones the server has unread but this client shows read. Then delete the list. A failure keeps it, and the
  // next connection retries; reports already made are skipped because the server then has them read.
  let legacyMigration: "idle" | "scheduled" | "running" = "idle"

  const migrateLegacy = async () => {
    legacyMigration = "running"
    let cursor: string | undefined

    for (;;) {
      const page = await input.sdk.api.session.list({
        limit: LEGACY_MIGRATION_PAGE,
        order: "desc",
        parentID: null,
        cursor,
      })

      const hidden = page.data.flatMap((session) =>
        session.time.idle !== undefined && isSessionUnread(session) && !unread(session)
          ? [{ sessionID: session.id, idle: session.time.idle }]
          : [],
      )

      for (let index = 0; index < hidden.length; index += LEGACY_MIGRATION_CONCURRENCY) {
        if (disposed.value) return

        await Promise.all(
          hidden.slice(index, index + LEGACY_MIGRATION_CONCURRENCY).map(async (report) => {
            await input.sdk.api.session.view(report)
            legacyReported.set(report.sessionID, report.idle)
          }),
        )
      }

      if (page.data.length === 0 || !page.cursor.next) break
      cursor = page.cursor.next
    }

    removePersisted(legacyTarget, platform)
    setState("legacyMigrated", true)
  }

  createEffect(() => {
    if (!legacyReady() || !legacyUnseen()) return

    if (untrack(() => legacy.started) === undefined) setLegacy("started", started)

    if (input.sdk.connection.status() !== "connected" || legacyMigration !== "idle") return
    legacyMigration = "scheduled"

    const timer = setTimeout(
      () =>
        void migrateLegacy().catch(() => {
          legacyMigration = "idle"
        }),
      LEGACY_MIGRATION_DELAY,
    )

    onCleanup(() => {
      clearTimeout(timer)

      if (legacyMigration === "scheduled") legacyMigration = "idle"
    })
  })

  const sessionList = () => input.data.session.list?.() ?? []

  const roots = (directory: string) =>
    sessionList().filter(
      (session) =>
        !session.parentID && session.time.archived === undefined && session.location.directory === directory,
    )

  const view = (sessionID: string) => {
    void state.viewRetry
    const root = input.data.session.root(sessionID)
    const session = input.data.session.get(root)
    const idle = session?.time.idle

    if (idle === undefined || !isSessionUnread(session) || acknowledged.get(root) === idle) return
    acknowledged.set(root, idle)
    void input.sdk.api.session.view({ sessionID: root, idle }).then(
      () => {
        clearTimeout(viewRetryTimer)
        viewRetryTimer = undefined
        viewRetryAttempt = 0
      },
      () => {
        if (acknowledged.get(root) !== idle) return
        acknowledged.delete(root)

        if (viewRetryTimer) return

        const delay = Math.min(VIEW_RETRY_DELAY * 2 ** viewRetryAttempt, VIEW_RETRY_MAX_DELAY)
        viewRetryAttempt++
        viewRetryTimer = setTimeout(() => {
          viewRetryTimer = undefined
          setState("viewRetry", (value) => value + 1)
        }, delay)
      },
    )
  }

  // Loading the session keeps a background completion visible in the server-derived unread state.
  const lookup = (sessionID: string) => {
    const session = input.data.session.get(sessionID)

    if (session) {
      failedLookups.delete(sessionID)
      return Promise.resolve(session)
    }

    if (!input.data.session.sync) {
      failedLookups.delete(sessionID)
      return Promise.resolve(undefined)
    }
    const existing = lookingUp.get(sessionID)
    if (existing) return existing

    const request = Promise.resolve()
      .then(() => input.data.session.sync?.(sessionID))
      .then(() => input.data.session.get(sessionID))
      .then((session) => {
        failedLookups.delete(sessionID)
        return session
      })
      .catch(() => {
        failedLookups.add(sessionID)
        if (failedLookups.size > MAX_TERMINAL_MARKERS)
          failedLookups.delete(failedLookups.values().next().value!)
        return undefined
      })
    lookingUp.set(sessionID, request)
    void request.then(() => {
      if (lookingUp.get(sessionID) === request) lookingUp.delete(sessionID)
    })
    return request
  }

  const pruneTerminal = () => {
    if (terminal.size <= MAX_TERMINAL_MARKERS) return

    const protectedSessions = new Set([
      ...running,
      ...deferred.keys(),
      ...settlingDeferred,
      ...hydrating.keys(),
      ...[...shells.values()].flatMap((shell) => [shell.ownerSessionID, ...shell.ancestors]),
    ])
    for (const [sessionID, marker] of terminal) {
      if (terminal.size <= MAX_TERMINAL_MARKERS) break
      if (protectedSessions.has(sessionID) || !marker.processed) continue
      terminal.delete(sessionID)
    }
  }

  const pendingTerminalCount = () => [...terminal.values()].filter((marker) => !marker.processed).length

  const markTerminalProcessed = (sessionID: string, eventID: string, generation = executionGeneration(sessionID)) => {
    const marker = terminal.get(sessionID)
    if (marker?.eventID !== eventID || marker.generation !== generation) return
    marker.processed = true
    pruneTerminal()
  }

  const parentID = (sessionID: string) => {
    if (parents.has(sessionID)) return parents.get(sessionID)
    return input.data.session.get(sessionID)?.parentID
  }

  const rootSessionID = (sessionID: string) => {
    let currentID = sessionID
    const visited = new Set<string>()

    while (!visited.has(currentID)) {
      visited.add(currentID)
      const currentParentID = parentID(currentID)
      if (!currentParentID) break
      currentID = currentParentID
    }

    return input.data.session.root?.(currentID) ?? currentID
  }

  const invalidateHydration = (sessionID: string) => {
    const rootID = rootSessionID(sessionID)
    hydrated.delete(rootID)
    hydrating.delete(rootID)
    lookingUp.delete(sessionID)
    settlingDeferred.delete(rootID)
  }

  const pruneHydrated = () => {
    const protectedRoots = new Set([...running, ...deferred.keys()])

    while (hydrated.size > MAX_HYDRATED_ROOTS) {
      const oldest = [...hydrated].find((rootID) => !protectedRoots.has(rootID)) ?? hydrated.values().next().value
      if (oldest === undefined) return
      hydrated.delete(oldest)
    }
  }

  const rememberHydrated = (rootID: string) => {
    // Set iteration order is the LRU order. Eviction only drops a cache entry, so an active or deferred root can
    // safely be rehydrated if all entries are protected and the cache must still stay bounded.
    hydrated.delete(rootID)
    hydrated.add(rootID)
    pruneHydrated()
  }

  const shellAncestors = (sessionID: string) => {
    const ancestors = new Set<string>()
    const visited = new Set<string>()
    let currentID: string | undefined = sessionID

    while (currentID) {
      if (visited.has(currentID)) break
      visited.add(currentID)
      const currentParentID = parentID(currentID)
      if (!currentParentID || visited.has(currentParentID)) break
      ancestors.add(currentParentID)
      currentID = currentParentID
    }

    return ancestors
  }

  const refreshShellAncestors = () => {
    for (const shell of shells.values()) shell.ancestors = shellAncestors(shell.ownerSessionID)
  }

  const reconcileShells = () => {
    if (!input.data.shell?.get) return

    for (const shellID of shells.keys()) {
      const shell = input.data.shell.get(shellID)
      if (!shell || shell.status !== "running") shells.delete(shellID)
    }
  }

  const synchronize = (reconnect = false) => {
    const sessions = sessionList()

    if (reconnect) reconcileShells()

    if (reconnect && activeSessionIDs) {
      for (const sessionID of activeSessionIDs) {
        if (deleted.has(sessionID)) continue
        if (!running.has(sessionID)) advanceExecutionGeneration(sessionID)
        terminal.delete(sessionID)
        deferred.delete(sessionID)
        overflowedSessions.delete(sessionID)
        overflowedTerminalEvents.delete(sessionID)
        running.add(sessionID)
      }
    }

    for (const session of sessions) {
      if (deleted.has(session.id)) continue
      parents.set(session.id, session.parentID)
      if (!reconnect) continue

      // Reconnect status is authoritative for the current execution: an old terminal marker must not hide it.
      const statusRunning = input.data.session.status?.(session.id) === "running"
      const active = activeSessionIDs?.has(session.id) ?? false
      const knownRunning = !activeSessionIDs && running.has(session.id)
      if (statusRunning || active || knownRunning) {
        if (!knownRunning) {
          if (!running.has(session.id)) advanceExecutionGeneration(session.id)
          terminal.delete(session.id)
          deferred.delete(session.id)
          overflowedSessions.delete(session.id)
          overflowedTerminalEvents.delete(session.id)
        }
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
      const visited = new Set<string>()
      let currentID: string | undefined = sessionID
      while (currentID && !visited.has(currentID)) {
        visited.add(currentID)
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

  const addLocation = (locations: Map<string, LocationRef>, location: LocationRef | undefined) => {
    if (!location) return
    locations.set(`${location.directory}\0${location.workspaceID ?? ""}`, location)
  }

  const syncLocations = async (locations: Map<string, LocationRef>) => {
    if (!input.data.shell?.sync) return true

    const results = await Promise.allSettled([...locations.values()].map((location) => input.data.shell?.sync?.(location)))
    return results.every((result) => result.status === "fulfilled")
  }

  // The solid data API's children option fetches one parent level. Completion decisions need the whole
  // discovered family, otherwise an unobserved grandchild can make a root appear idle too early.
  const syncRootFamily = async (rootID: string) => {
    const discovered = new Set([rootID])
    const synced = new Set<string>()
    let complete = true

    if (input.data.session.sync) {
      for (;;) {
        const pending = [...discovered].filter((sessionID) => !synced.has(sessionID))
        if (pending.length === 0) break

        pending.forEach((sessionID) => {
          input.data.session.invalidate?.(sessionID)
        })
        const results = await Promise.allSettled(
          pending.map((sessionID) =>
            Promise.resolve().then(() => input.data.session.sync?.(sessionID, { children: true })),
          ),
        )
        if (results.some((result) => result.status === "rejected")) complete = false
        pending.forEach((sessionID) => synced.add(sessionID))

        for (const sessionID of input.data.session.family?.(rootID) ?? []) discovered.add(sessionID)
        for (const session of sessionList()) {
          if (session.id === rootID || input.data.session.root?.(session.id) === rootID) discovered.add(session.id)
        }
      }
    }

    const locations = new Map<string, LocationRef>()
    for (const sessionID of discovered) addLocation(locations, input.data.session.get(sessionID)?.location)
    for (const session of sessionList()) {
      if (session.id === rootID || input.data.session.root?.(session.id) === rootID) addLocation(locations, session.location)
    }
    for (const shell of shells.values()) {
      if (shell.ownerSessionID === rootID || shell.ancestors.has(rootID)) addLocation(locations, shell.location)
    }
    if (locations.size === 0) addLocation(locations, input.data.location?.default?.())

    if (!(await syncLocations(locations))) complete = false
    return complete
  }

  const hydrateRoot = (rootID: string) => {
    if (hydrated.has(rootID)) {
      rememberHydrated(rootID)
      return Promise.resolve(true)
    }

    const existing = hydrating.get(rootID)
    if (existing) return existing

    const request = syncRootFamily(rootID).catch(() => false)
    hydrating.set(rootID, request)
    void request.then((complete) => {
      if (complete && hydrating.get(rootID) === request) rememberHydrated(rootID)
      if (hydrating.get(rootID) === request) hydrating.delete(rootID)
    })
    return request
  }

  const completionHydrationTimers = new Set<ReturnType<typeof setTimeout>>()
  onCleanup(() => {
    completionHydrationTimers.forEach((timer) => clearTimeout(timer))
    completionHydrationTimers.clear()
  })

  const hydrateForCompletion = (sessionID: string, current: () => boolean) => {
    if (!input.data.session.sync && !input.data.shell?.sync) return hydrateRoot(sessionID)

    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        if (timer) completionHydrationTimers.delete(timer)
        if (current()) invalidateHydration(sessionID)
        resolve(false)
      }, RECONNECT_DEADLINE)
      if (timer) completionHydrationTimers.add(timer)
    })

    return Promise.race([hydrateRoot(sessionID), timeout]).finally(() => {
      if (!timer) return
      clearTimeout(timer)
      completionHydrationTimers.delete(timer)
    })
  }

  const listShellsBySession = (sessionID: string) => {
    if (input.data.shell?.listBySession) return input.data.shell.listBySession(sessionID)

    const location = input.data.location?.default?.()
    if (!location || !input.data.shell?.list) return []

    return input.data.shell.list(location).filter((shell) => shell.metadata.sessionID === sessionID)
  }

  const isDescendant = (sessionID: string, ancestorID: string) => {
    if (sessionID === ancestorID) return false

    const visited = new Set<string>()
    let currentID: string | undefined = sessionID
    while (currentID && !visited.has(currentID)) {
      visited.add(currentID)
      const currentParentID = parentID(currentID)
      if (!currentParentID) break
      if (currentParentID === ancestorID) return true
      currentID = currentParentID
    }

    return input.data.session.family?.(ancestorID).includes(sessionID) ?? false
  }

  const isRunning = (sessionID: string) => {
    if (deleted.has(sessionID)) return false
    if (input.data.session.status?.(sessionID) === "running") return true
    if (activeSessionIDs) return activeSessionIDs.has(sessionID)
    if (terminal.has(sessionID)) return false
    return running.has(sessionID)
  }

  const hasRunningBackground = (sessionID: string) => {
    synchronize()
    const candidates = new Set([
      ...sessionList().map((session) => session.id),
      ...(input.data.session.family?.(sessionID) ?? []),
      ...running,
      ...(activeSessionIDs ?? []),
    ])
    for (const shell of shells.values()) candidates.add(shell.ownerSessionID)

    const descendants = [...candidates].filter((candidateID) => isDescendant(candidateID, sessionID))
    if (descendants.some(isRunning)) return true

    if (pendingLifecycleEvents.some((event) => isDescendant(event.data.sessionID, sessionID))) return true

    if ([...shells.values()].some((shell) => shell.ownerSessionID === sessionID || shell.ancestors.has(sessionID))) return true

    return [sessionID, ...descendants].some((candidateID) =>
      listShellsBySession(candidateID).some((shell) => shell.status === "running"),
    )
  }

  const notifySessionIdle = (sessionID: string, eventID: string, generation: number, session: SessionInfo) => {
    const hasOpenTab = sessionIDHasOpenTab(tabs.store, input.key, sessionID)
    const marker = terminal.get(sessionID)

    if (marker?.eventID !== eventID || marker.generation !== generation) return
    marker.processed = true
    if (hasOpenTab) marker.notified = true

    if (hasOpenTab && settings.sounds.agentEnabled()) {
      void input.coordinator.sound(`${input.key}\0${eventID}`, () => playSoundById(settings.sounds.agent()))
    }

    if (hasOpenTab && settings.notifications.agent()) {
      void input.coordinator.system(`${input.key}\0${eventID}`, () =>
        platform.notify(language.t("notification.session.responseReady.title"), session.title ?? sessionID, () =>
          openNotificationSession(tabs, input.key, sessionID),
        ),
      )
    }

    pruneTerminal()
  }

  const cancelDeferredRecovery = (reset = true) => {
    if (deferredRecoveryTimer) {
      clearTimeout(deferredRecoveryTimer)
      deferredRecoveryTimer = undefined
    }
    if (reset) deferredRecoveryAttempts = 0
  }

  function scheduleDeferredRecovery() {
    if (
      disposed.value ||
      reconnecting ||
      pendingLifecycleOverflowed ||
      deferred.size === 0 ||
      deferredRecoveryTimer ||
      deferredRecoveryAttempts >= MAX_DEFERRED_RECOVERY_ATTEMPTS
    )
      return

    const delay = Math.min(DEFERRED_RECOVERY_DELAY * 2 ** deferredRecoveryAttempts, VIEW_RETRY_MAX_DELAY)
    deferredRecoveryAttempts++
    deferredRecoveryTimer = setTimeout(() => {
      deferredRecoveryTimer = undefined
      if (disposed.value || reconnecting || pendingLifecycleOverflowed || deferred.size === 0) return
      requestDeferredFlush(false)
    }, delay)
  }

  const flushDeferred = () => {
    if (reconnecting || pendingLifecycleOverflowed) return

    for (const [sessionID, completion] of deferred) {
      if (settlingDeferred.has(sessionID)) continue
      settlingDeferred.add(sessionID)
      const revision = deferredRevision
      const attempt = reconnectAttempt
      const { eventID, generation } = completion
      void (async () => {
        try {
          if (
            deleted.has(sessionID) ||
            deferred.get(sessionID)?.eventID !== eventID ||
            deferred.get(sessionID)?.generation !== generation ||
            !isCurrentCompletion(sessionID, eventID, generation, attempt)
          )
            return

          const marker = terminal.get(sessionID)
          if (marker?.type === "session.execution.failed") {
            const session = await lookup(sessionID)
            if (
              deleted.has(sessionID) ||
              !session ||
              !isCurrentCompletion(sessionID, eventID, generation, attempt)
            )
              return

            deferred.delete(sessionID)
            handleSessionError(sessionID, eventID, generation, attempt)
            return
          }

          const hydrated = await hydrateForCompletion(
            sessionID,
            () => isCurrentCompletion(sessionID, eventID, generation, attempt),
          )
          if (!isCurrentCompletion(sessionID, eventID, generation, attempt) || !hydrated) return

          const session = await lookup(sessionID)
          if (
            deleted.has(sessionID) ||
            !session ||
            !isCurrentCompletion(sessionID, eventID, generation, attempt) ||
            parentID(sessionID) !== undefined ||
            session.parentID ||
            isRunning(sessionID) ||
            hasRunningBackground(sessionID)
          )
            return

          if (deferred.get(sessionID)?.eventID !== eventID || deferred.get(sessionID)?.generation !== generation) return
          deferred.delete(sessionID)
          notifySessionIdle(sessionID, eventID, generation, session)
        } finally {
          settlingDeferred.delete(sessionID)
          if (
            isCurrentAttempt(attempt) &&
            deferred.has(sessionID) &&
            deferredRevision !== revision
          )
            scheduleDeferredFlush()
          else if (isCurrentAttempt(attempt) && deferred.has(sessionID)) scheduleDeferredRecovery()
        }
      })()
    }
  }

  const scheduleDeferredFlush = () => {
    if (deferredFlushScheduled || reconnecting || pendingLifecycleOverflowed) return
    deferredFlushScheduled = true
    queueMicrotask(() => {
      deferredFlushScheduled = false
      if (!disposed.value) flushDeferred()
    })
  }

  const requestDeferredFlush = (resetRecovery = true) => {
    deferredRevision++
    if (resetRecovery) cancelDeferredRecovery()
    flushDeferred()
  }

  const isCurrentRootCompletion = (sessionID: string, eventID: string, generation: number, session?: SessionInfo) => {
    const currentSession = input.data.session.get(sessionID) ?? session

    return (
      !disposed.value &&
      !deleted.has(sessionID) &&
      terminal.get(sessionID)?.eventID === eventID &&
      terminal.get(sessionID)?.generation === generation &&
      parentID(sessionID) === undefined &&
      !currentSession?.parentID
    )
  }

  const handleSessionIdle = (sessionID: string, eventID: string, generation = executionGeneration(sessionID)) => {
    const attempt = reconnectAttempt
    const revision = deferredRevision
    let deferredSetRevision: number | undefined
    const process = async (session: SessionInfo | undefined) => {
      if (!session) {
        if (!failedLookups.delete(sessionID)) {
          if (isCurrentCompletion(sessionID, eventID, generation, attempt))
            markTerminalProcessed(sessionID, eventID, generation)
          return
        }
        if (!isCurrentRootCompletion(sessionID, eventID, generation)) return
        deferred.set(sessionID, { eventID, generation })
        deferredRevision++
        deferredSetRevision = deferredRevision
        return
      }
      if (!isCurrentCompletion(sessionID, eventID, generation, attempt)) return
      if (!isCurrentRootCompletion(sessionID, eventID, generation, session)) {
        if (session.parentID || parentID(sessionID) !== undefined)
          markTerminalProcessed(sessionID, eventID, generation)
        return
      }

      const marker = terminal.get(sessionID)
      if (marker?.eventID === eventID && marker.generation === generation) marker.idle = session.time?.idle

      const hydrated = await hydrateForCompletion(
        sessionID,
        () => isCurrentCompletion(sessionID, eventID, generation, attempt),
      )
      if (!isCurrentCompletion(sessionID, eventID, generation, attempt)) return
      if (!isCurrentRootCompletion(sessionID, eventID, generation, session)) return

      if (!hydrated || reconnecting) {
        if (!isCurrentRootCompletion(sessionID, eventID, generation, session)) return
        deferred.set(sessionID, { eventID, generation })
        deferredRevision++
        deferredSetRevision = deferredRevision
        return
      }

      if (!isCurrentRootCompletion(sessionID, eventID, generation, session)) return
      if (hasRunningBackground(sessionID)) {
        if (!isCurrentRootCompletion(sessionID, eventID, generation, session)) return
        deferred.set(sessionID, { eventID, generation })
        deferredRevision++
        deferredSetRevision = deferredRevision
        return
      }

      if (!isCurrentRootCompletion(sessionID, eventID, generation, session)) return
      notifySessionIdle(sessionID, eventID, generation, session)
    }

    const session = input.data.session.get(sessionID)
    if (session) {
      void process(session).finally(() => {
        if (!isCurrentAttempt(attempt) || !deferred.has(sessionID)) return
        if (deferredRevision !== (deferredSetRevision ?? revision)) scheduleDeferredFlush()
        else scheduleDeferredRecovery()
      })
      return
    }
    void lookup(sessionID)
      .then(process)
      .finally(() => {
        if (!isCurrentAttempt(attempt) || !deferred.has(sessionID)) return
        if (deferredRevision !== (deferredSetRevision ?? revision)) scheduleDeferredFlush()
        else scheduleDeferredRecovery()
      })
  }

  const handleSessionError = (
    sessionID: string,
    eventID: string,
    generation = executionGeneration(sessionID),
    attempt = reconnectAttempt,
  ) => {
    const process = (session: SessionInfo | undefined) => {
      if (!isCurrentCompletion(sessionID, eventID, generation, attempt) || deleted.has(sessionID)) return

      const hasOpenTab = sessionIDHasOpenTab(tabs.store, input.key, sessionID)
      const marker = terminal.get(sessionID)

      if (marker?.eventID === eventID && marker.generation === generation) {
        marker.processed = true
        marker.idle = session?.time?.idle
      }

      if (parentID(sessionID) !== undefined || session?.parentID) {
        pruneTerminal()
        return
      }

      if (marker?.eventID === eventID && hasOpenTab) marker.notified = true

      if (hasOpenTab && settings.sounds.errorsEnabled()) {
        void input.coordinator.sound(`${input.key}\0${eventID}`, () => playSoundById(settings.sounds.errors()))
      }

      const description = session?.title ?? language.t("notification.session.error.fallbackDescription")

      if (hasOpenTab && settings.notifications.errors()) {
        void input.coordinator.system(`${input.key}\0${eventID}`, () =>
          platform.notify(language.t("notification.session.error.title"), description, () =>
            openNotificationSession(tabs, input.key, sessionID),
          ),
        )
      }

      pruneTerminal()
    }

    const session = input.data.session.get(sessionID)
    if (session) {
      process(session)
      return
    }
    void lookup(sessionID).then((session) => {
      if (!isCurrentCompletion(sessionID, eventID, generation, attempt)) return
      process(session)
    })
  }

  const processTerminalEvent = (event: TerminalEvent, expectedGeneration?: number) => {
    const sessionID = event.data.sessionID
    const previous = terminal.get(sessionID)
    if (previous?.eventID === event.id) return
    const statusRunning = input.data.session.status?.(sessionID) === "running"

    // A dropped started event can leave a notified marker behind. A live status is explicit evidence that this is a
    // newer execution, so discard only that stale state before applying the terminal event.
    if (statusRunning && !running.has(sessionID)) {
      advanceExecutionGeneration(sessionID)
      invalidateHydration(sessionID)
      terminal.delete(sessionID)
      deferred.delete(sessionID)
      overflowedSessions.delete(sessionID)
      overflowedTerminalEvents.delete(sessionID)
      running.add(sessionID)
    } else if (activeSessionIDs?.has(sessionID)) {
      if (!running.has(sessionID)) advanceExecutionGeneration(sessionID)
      terminal.delete(sessionID)
      deferred.delete(sessionID)
      running.delete(sessionID)
    }
    activeSessionIDs?.delete(sessionID)
    const marker = terminal.get(sessionID)
    if (
      deleted.has(sessionID) ||
      marker?.notified ||
      (marker !== undefined && marker.type !== event.type) ||
      (marker !== undefined && !marker.processed) ||
      deferred.has(sessionID)
    )
      return

    pruneTerminal()
    if (pendingTerminalCount() >= MAX_TERMINAL_MARKERS) {
      // Keep only bounded recovery state. It is deliberately not turned into a processed marker: recovery may notify
      // after the server exposes a newer idle watermark, but an incomplete settlement must never become a false alert.
      rememberOverflowedEvent(event)
      scheduleLifecycleOverflowRecovery()
      return
    }

    const generation = executionGeneration(sessionID)
    if (expectedGeneration !== undefined && generation !== expectedGeneration) return
    terminal.set(sessionID, {
      eventID: event.id,
      generation,
      type: event.type,
      notified: false,
      processed: false,
    })
    running.delete(sessionID)
    pruneTerminal()

    if (event.type === "session.execution.failed") {
      deferred.delete(sessionID)
      handleSessionError(sessionID, event.id, generation, reconnectAttempt)
      requestDeferredFlush()
      return
    }

    handleSessionIdle(sessionID, event.id, generation)
    requestDeferredFlush()
  }

  const processLifecycleEvent = (event: LifecycleEvent, expectedGeneration?: number) => {
    if (event.type === "session.execution.started") {
      if (deleted.has(event.data.sessionID)) return
      const generation = expectedGeneration ?? advanceExecutionGeneration(event.data.sessionID)
      if (expectedGeneration !== undefined) executionGenerations.set(event.data.sessionID, generation)
      activeSessionIDs?.add(event.data.sessionID)
      invalidateHydration(event.data.sessionID)
      terminal.delete(event.data.sessionID)
      deferred.delete(event.data.sessionID)
      overflowedSessions.delete(event.data.sessionID)
      overflowedTerminalEvents.delete(event.data.sessionID)
      running.add(event.data.sessionID)
      const session = input.data.session.get(event.data.sessionID)
      if (session) parents.set(event.data.sessionID, session.parentID)
      return
    }

    if (event.type === "session.execution.interrupted") {
      if (deleted.has(event.data.sessionID)) return
      activeSessionIDs?.delete(event.data.sessionID)
      running.delete(event.data.sessionID)
      deferred.delete(event.data.sessionID)
      overflowedSessions.delete(event.data.sessionID)
      overflowedTerminalEvents.delete(event.data.sessionID)
      if (!terminal.has(event.data.sessionID))
        terminal.set(event.data.sessionID, {
          eventID: event.id,
          generation: executionGeneration(event.data.sessionID),
          type: "session.execution.interrupted",
          notified: false,
          processed: true,
        })
      pruneTerminal()
      requestDeferredFlush()
      return
    }

    processTerminalEvent(event, expectedGeneration)
  }

  const rememberOverflowedSession = (sessionID: string) => {
    overflowedSessions.add(sessionID)
    if (overflowedSessions.size <= MAX_PENDING_LIFECYCLE_EVENTS) return
    const oldest = overflowedSessions.values().next().value
    if (oldest !== undefined) overflowedSessions.delete(oldest)
  }

  const rememberOverflowedEvent = (event: LifecycleEvent, generation = executionGeneration(event.data.sessionID)) => {
    rememberOverflowedSession(event.data.sessionID)
    if (event.type === "session.execution.started") {
      overflowedTerminalEvents.delete(event.data.sessionID)
      return
    }
    overflowedTerminalEvents.set(event.data.sessionID, { event, generation })
    if (overflowedTerminalEvents.size <= MAX_PENDING_LIFECYCLE_EVENTS * 2) return
    const oldest = overflowedTerminalEvents.keys().next().value
    if (oldest !== undefined) overflowedTerminalEvents.delete(oldest)
  }

  const hasLifecycleRecovery = () =>
    pendingLifecycleOverflowed || overflowedSessions.size > 0 || overflowedTerminalEvents.size > 0

  const replayPendingLifecycleEvents = () => {
    if (pendingLifecycleOverflowed) return false

    while (pendingLifecycleEvents.length) {
      const event = pendingLifecycleEvents.shift()
      if (event) processLifecycleEvent(event)
    }

    return true
  }

  const restorePendingLifecycleEvents = (pendingEvents: LifecycleEvent[], pendingOverflowed: boolean) => {
    const currentPendingEvents = pendingLifecycleEvents.splice(0)
    const currentPendingOverflowed = pendingLifecycleOverflowed

    const restore = (event: LifecycleEvent) => {
      const sessionID = event.data.sessionID
      const marker = terminal.get(sessionID)
      if (deleted.has(sessionID) || (marker?.eventID === event.id && marker.processed)) return
      if (running.has(sessionID) && !marker) return
      if (!overflowedTerminalEvents.has(sessionID)) rememberOverflowedEvent(event)
    }

    pendingEvents.forEach(restore)
    currentPendingEvents.forEach(restore)

    pendingLifecycleOverflowed =
      pendingOverflowed || currentPendingOverflowed || pendingEvents.length > 0 || currentPendingEvents.length > 0
  }

  const restoreLifecycleOverflow = (
    affected: Set<string>,
    terminalEvents: Map<string, OverflowTerminal>,
    pendingEvents: LifecycleEvent[],
    pendingOverflowed: boolean,
    snapshotGenerations?: Map<string, number>,
  ) => {
    restorePendingLifecycleEvents(pendingEvents, pendingOverflowed)

    for (const sessionID of affected) {
      if (deleted.has(sessionID)) continue
      const snapshotGeneration = snapshotGenerations?.get(sessionID)
      if (snapshotGeneration !== undefined && executionGeneration(sessionID) !== snapshotGeneration) continue

      const marker = terminal.get(sessionID)
      const overflow = terminalEvents.get(sessionID)
      if (overflow) {
        // A newer lifecycle event may have superseded the failed recovery while it was awaiting I/O. Do not put the
        // old event back in front of the newer marker or an active execution.
        if (marker && (marker.eventID !== overflow.event.id || marker.generation !== overflow.generation)) {
          if (overflowedTerminalEvents.get(sessionID)?.event.id === overflow.event.id)
            overflowedTerminalEvents.delete(sessionID)
          overflowedSessions.delete(sessionID)
          continue
        }
        if (marker?.eventID === overflow.event.id && marker.generation === overflow.generation && marker.processed) {
          overflowedTerminalEvents.delete(sessionID)
          overflowedSessions.delete(sessionID)
          continue
        }
        if (running.has(sessionID) && !marker) {
          overflowedSessions.delete(sessionID)
          if (overflowedTerminalEvents.get(sessionID)?.event.id === overflow.event.id)
            overflowedTerminalEvents.delete(sessionID)
          continue
        }
        if (!overflowedTerminalEvents.has(sessionID) && !overflowedSessions.has(sessionID))
          rememberOverflowedEvent(overflow.event, overflow.generation)
        continue
      }

      if (marker || running.has(sessionID)) {
        overflowedSessions.delete(sessionID)
        continue
      }
      rememberOverflowedSession(sessionID)
    }
  }

  // Overflow means the event stream is no longer a complete execution history. Rebuild the affected roots from
  // current session/shell state and only synthesize a completion when the server exposes a newer idle watermark.
  const recoverLifecycleOverflow = async (isCurrent: () => boolean): Promise<LifecycleRecoveryResult> => {
    const affected = [...new Set([...overflowedSessions, ...overflowedTerminalEvents.keys()])]
    const affectedIDs = new Set(affected)
    const terminalEvents = new Map(overflowedTerminalEvents)
    const snapshotGenerations = new Map(affected.map((sessionID) => [sessionID, executionGeneration(sessionID)]))
    affected.forEach((sessionID) => overflowedSessions.delete(sessionID))
    for (const [sessionID, overflow] of terminalEvents) {
      if (overflowedTerminalEvents.get(sessionID)?.event.id === overflow.event.id)
        overflowedTerminalEvents.delete(sessionID)
    }
    const pendingEvents = pendingLifecycleEvents.splice(0)
    const pendingOverflowed = pendingLifecycleOverflowed
    pendingLifecycleOverflowed = false
    const restoreIfInvalidated = () => {
      if (disposed.value || isCurrent()) return false
      restoreLifecycleOverflow(new Set(affected), terminalEvents, pendingEvents, pendingOverflowed, snapshotGenerations)
      return true
    }

    const roots = new Set(
      affected.map((sessionID) => input.data.session.root?.(sessionID) ?? sessionID),
    )
    const hydration = await Promise.allSettled([...roots].map((rootID) => hydrateRoot(rootID)))
    if (disposed.value) return { success: false, progressed: false, retry: false }
    if (!isCurrent()) {
      restoreIfInvalidated()
      return { success: false, progressed: false, retry: false }
    }
    if (hydration.some((result) => result.status === "rejected" || !result.value)) {
      if (!disposed.value && isCurrent())
        restoreLifecycleOverflow(new Set(affected), terminalEvents, pendingEvents, pendingOverflowed, snapshotGenerations)
      return { success: false, progressed: false, retry: false }
    }

    synchronize(true)
    if (!replayPendingLifecycleEvents()) {
      if (isCurrent())
        restoreLifecycleOverflow(new Set(affected), terminalEvents, pendingEvents, pendingOverflowed, snapshotGenerations)
      else restoreIfInvalidated()
      return { success: false, progressed: false, retry: false }
    }

    const ready = new Set<string>()
    const unresolved = new Set<string>()

    for (const sessionID of affected) {
      if (!isCurrent()) {
        restoreIfInvalidated()
        return { success: false, progressed: false, retry: false }
      }
      const snapshotGeneration = snapshotGenerations.get(sessionID)
      const event = terminalEvents.get(sessionID)
      if (snapshotGeneration !== executionGeneration(sessionID)) continue
      if (deleted.has(sessionID) || (!event && isRunning(sessionID))) {
        overflowedSessions.delete(sessionID)
        if (event && overflowedTerminalEvents.get(sessionID)?.event.id === event.event.id)
          overflowedTerminalEvents.delete(sessionID)
        continue
      }

      const session = input.data.session.get(sessionID)
      const idle = session?.time?.idle
      if (!session || idle === undefined) {
        unresolved.add(sessionID)
        continue
      }

      ready.add(sessionID)
    }

    for (const sessionID of ready) {
      if (!isCurrent()) {
        restoreIfInvalidated()
        return { success: false, progressed: false, retry: false }
      }

      const snapshotGeneration = snapshotGenerations.get(sessionID)
      if (snapshotGeneration !== executionGeneration(sessionID)) continue
      const event = terminalEvents.get(sessionID)
      const session = input.data.session.get(sessionID)
      const idle = session?.time?.idle
      if (!session || idle === undefined) {
        unresolved.add(sessionID)
        continue
      }

      const marker = terminal.get(sessionID)
      if (
        marker &&
        marker.generation === snapshotGeneration &&
        (marker.idle === undefined || marker.idle >= idle)
      ) {
        overflowedSessions.delete(sessionID)
        if (event && overflowedTerminalEvents.get(sessionID)?.event.id === event.event.id)
          overflowedTerminalEvents.delete(sessionID)
        continue
      }

      overflowedSessions.delete(sessionID)
      if (event && overflowedTerminalEvents.get(sessionID)?.event.id === event.event.id)
        overflowedTerminalEvents.delete(sessionID)
      terminal.delete(sessionID)
      deferred.delete(sessionID)
      if (event) {
        if (event.event.type === "session.execution.interrupted") processLifecycleEvent(event.event, event.generation)
        else processTerminalEvent(event.event, event.generation)
      }
    }

    if (unresolved.size > 0) restorePendingLifecycleEvents(pendingEvents, pendingOverflowed)

    const retry =
      pendingLifecycleOverflowed ||
      [...overflowedSessions].some((sessionID) => !affectedIDs.has(sessionID)) ||
      [...overflowedTerminalEvents].some(
        ([sessionID, overflow]) => terminalEvents.get(sessionID)?.event.id !== overflow.event.id,
      )

    return { success: unresolved.size === 0, progressed: ready.size > 0, retry }
  }

  const scheduleLifecycleOverflowRecovery = () => {
    if (disposed.value) return
    if (lifecycleOverflowRecovery) {
      lifecycleOverflowRecoveryPending = true
      return
    }
    if (reconnecting || input.sdk.connection.status() !== "connected" || !hasLifecycleRecovery()) return

    const attempt = reconnectAttempt
    lifecycleOverflowRecoveryPending = false
    const recovery = recoverLifecycleOverflow(() => isCurrentAttempt(attempt)).then(
      () => {},
      () => {},
    )
    const completion = recovery.finally(() => {
      if (lifecycleOverflowRecovery !== completion) return
      lifecycleOverflowRecovery = undefined
      const shouldRecoverAgain = lifecycleOverflowRecoveryPending
      lifecycleOverflowRecoveryPending = false
      if (shouldRecoverAgain && isCurrentAttempt(attempt) && !reconnecting)
        queueMicrotask(() => scheduleLifecycleOverflowRecovery())
    })
    lifecycleOverflowRecovery = completion
  }

  const flushPendingLifecycleEvents = () => {
    return replayPendingLifecycleEvents()
  }

  const handleLifecycleEvent = (event: LifecycleEvent) => {
    if (reconnecting) {
      if (event.type !== "session.execution.started") {
        const latestStarted = pendingLifecycleEvents.findLastIndex(
          (pending) => pending.data.sessionID === event.data.sessionID && pending.type === "session.execution.started",
        )
        const existing = pendingLifecycleEvents.findIndex(
          (pending, index) =>
            index > latestStarted && pending.data.sessionID === event.data.sessionID && pending.type === event.type,
        )
        if (existing >= 0) {
          pendingLifecycleEvents[existing] = event
          return
        }
      }

      if (pendingLifecycleEvents.length >= MAX_PENDING_LIFECYCLE_EVENTS) {
        pendingLifecycleOverflowed = true
        pendingLifecycleEvents.forEach(rememberOverflowedEvent)
        rememberOverflowedEvent(event)
        return
      }

      if (pendingLifecycleOverflowed) rememberOverflowedEvent(event)
      pendingLifecycleEvents.push(event)
      return
    }
    processLifecycleEvent(event)
  }

  const withReconnectDeadline = (operation: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel = () => {}
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("notification reconnect timed out")), RECONNECT_DEADLINE)
      cancel = () => {
        if (timer) clearTimeout(timer)
        reject(new Error("notification reconnect cancelled"))
      }
    })
    cancelReconnectDeadline = cancel

    return Promise.race([operation, deadline]).finally(() => {
      if (timer) clearTimeout(timer)
      if (cancelReconnectDeadline === cancel) cancelReconnectDeadline = undefined
    })
  }

  const reconnect = () => {
    if (reconnecting) return reconnecting

    const attempt = ++reconnectAttempt
    const isCurrent = () => !disposed.value && reconnectAttempt === attempt
    let completed = false
    let scheduleLifecycleRecoveryAfterReconnect = false

    const work = async () => {
      // Reconnect owns lifecycle reconciliation. Wait for an already-running online pass instead of racing it.
      if (lifecycleOverflowRecovery) await lifecycleOverflowRecovery
      if (!isCurrent()) return

      activeSessionIDs = undefined
      const active = await Promise.resolve().then(() => input.sdk.api.session.active())
      if (!isCurrent()) return
      activeSessionIDs = new Set(Object.keys(active))

      const locations = new Map<string, LocationRef>()
      for (const session of sessionList()) addLocation(locations, session.location)
      for (const shell of shells.values()) addLocation(locations, shell.location)
      if (locations.size === 0) addLocation(locations, input.data.location?.default?.())

      const roots = new Set<string>()
      const addRootCandidate = (sessionID: string) => {
        roots.add(input.data.session.root?.(sessionID) ?? sessionID)
      }
      for (const session of sessionList()) {
        if (!session.parentID) addRootCandidate(session.id)
      }
      for (const sessionID of [
        ...running,
        ...deferred.keys(),
        ...hydrating.keys(),
        ...[...terminal].flatMap(([sessionID, marker]) => (marker.processed ? [] : [sessionID])),
        ...overflowedSessions,
        ...overflowedTerminalEvents.keys(),
        ...(activeSessionIDs ?? []),
      ])
        addRootCandidate(sessionID)
      for (const shell of shells.values()) addRootCandidate(shell.ownerSessionID)

      hydrated.clear()
      hydrating.clear()
      lookingUp.clear()
      settlingDeferred.clear()
      deferredRevision++

      for (const location of locations.values()) input.data.shell?.invalidate?.(location)
      for (const rootID of roots) input.data.session.invalidate?.(rootID)

      const results = await Promise.all([syncLocations(locations), ...[...roots].map((rootID) => hydrateRoot(rootID))])
      if (!isCurrent()) return
      if (results.some((result) => !result)) throw new Error("notification reconnect hydration failed")

      synchronize(true)
      if (!isCurrent()) return

      if (flushPendingLifecycleEvents() && !hasLifecycleRecovery()) {
        completed = true
        return
      }

      if (hasLifecycleRecovery()) {
        const recovery = await recoverLifecycleOverflow(isCurrent)
        if (!isCurrent()) return
        scheduleLifecycleRecoveryAfterReconnect = recovery.retry
        if (!recovery.success) {
          fail()
          // A known completion may already be waiting in deferred. It is safe to settle that marker after the
          // reconnect snapshot succeeded, but never manufacture one when hydration itself failed.
          completed = recovery.progressed
          return
        }
      }

      if (!isCurrent()) return
      synchronize(true)
      completed = true
    }

    const fail = () => {
      if (reconnectAttempt !== attempt) return
      reconnectAttempt++
      hydrated.clear()
      hydrating.clear()
      lookingUp.clear()
      settlingDeferred.clear()
      deferredRevision++
      activeSessionIDs = undefined

      pendingLifecycleEvents.forEach(rememberOverflowedEvent)
      pendingLifecycleEvents.length = 0
      pendingLifecycleOverflowed = false

      for (const [sessionID, marker] of terminal) {
        if (
          !marker.processed &&
          (marker.type === "session.execution.succeeded" || marker.type === "session.execution.failed")
        )
          deferred.set(sessionID, { eventID: marker.eventID, generation: marker.generation })
      }
    }

    reconnecting = withReconnectDeadline(Promise.resolve().then(work))
      .catch(fail)
      .finally(() => {
        reconnecting = undefined
        if (disposed.value) return
        if (completed) {
          for (const [sessionID, marker] of terminal) {
            if (
              !marker.processed &&
              (marker.type === "session.execution.succeeded" || marker.type === "session.execution.failed")
            )
              deferred.set(sessionID, { eventID: marker.eventID, generation: marker.generation })
          }
          if (flushPendingLifecycleEvents()) requestDeferredFlush()

          if (scheduleLifecycleRecoveryAfterReconnect && input.sdk.connection?.status?.() === "connected") {
            queueMicrotask(() => {
              if (!disposed.value && !reconnecting && input.sdk.connection?.status?.() === "connected")
                scheduleLifecycleOverflowRecovery()
            })
          }
          return
        }

        // A deadline/failure invalidates the in-flight work, but the completion is still retained. Give it one
        // controlled settlement attempt after reconnecting clears; a failed hydration waits for a later event or
        // reconnect instead of spinning.
        queueMicrotask(() => {
          if (disposed.value || reconnecting) return
          requestDeferredFlush()
          if (input.sdk.connection?.status?.() === "connected") scheduleLifecycleOverflowRecovery()
        })
      })

    return reconnecting
  }

  synchronize()

  const unsub = input.sdk.event.listen((event) => {
    if (event.type === "server.connected") {
      void reconnect()
      return
    }

    if (event.type === "session.created") {
      deleted.delete(event.data.sessionID)
      invalidateHydration(event.data.sessionID)
      if (event.data.parentID) invalidateHydration(event.data.parentID)
      overflowedSessions.delete(event.data.sessionID)
      overflowedTerminalEvents.delete(event.data.sessionID)
      synchronize()
      parents.set(event.data.sessionID, event.data.parentID)
      refreshShellAncestors()
      requestDeferredFlush()
      return
    }

    if (event.type === "session.deleted") {
      invalidateHydration(event.data.sessionID)
      deleted.add(event.data.sessionID)
      if (deleted.size > MAX_DELETED_MARKERS) {
        const oldest = deleted.values().next().value
        if (oldest !== undefined) deleted.delete(oldest)
      }
      running.delete(event.data.sessionID)
      failedLookups.delete(event.data.sessionID)
      terminal.delete(event.data.sessionID)
      deferred.delete(event.data.sessionID)
      executionGenerations.delete(event.data.sessionID)
      overflowedSessions.delete(event.data.sessionID)
      overflowedTerminalEvents.delete(event.data.sessionID)
      activeSessionIDs?.delete(event.data.sessionID)
      synchronize()
      requestDeferredFlush()
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
        location: event.location ?? input.data.location?.default?.(),
      })
      synchronize()
      return
    }

    if (event.type === "shell.exited" || event.type === "shell.deleted") {
      shells.delete(event.data.id)
      synchronize()
      requestDeferredFlush()
      return
    }

    if (
      event.type === "session.execution.started" ||
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      handleLifecycleEvent(event)
    }
  })

  onCleanup(() => {
    disposed.value = true
    cancelDeferredRecovery()
    reconnectAttempt++
    cancelReconnectDeadline?.()
    cancelReconnectDeadline = undefined
    hydrated.clear()
    hydrating.clear()
    lookingUp.clear()
    failedLookups.clear()
    settlingDeferred.clear()
    pendingLifecycleEvents.length = 0
    overflowedSessions.clear()
    overflowedTerminalEvents.clear()
    pendingLifecycleOverflowed = false
    unsub()
  })

  return {
    session: {
      /**
       * Whether the session's root has an execution result no client has viewed yet. `snapshot` stands in for a root
       * session that isn't loaded, such as a row from the fetched home index.
       */
      unread(sessionID: string, snapshot?: SessionInfo) {
        return unread(input.data.session.get(input.data.session.root(sessionID)) ?? snapshot)
      },
      /** Reports the session's latest idle transition to the server as viewed. */
      markViewed: view,
    },
    project: {
      hasUnread(directory: string) {
        return roots(directory).some((session) => unread(session))
      },
      markViewed(directory: string) {
        roots(directory).forEach((session) => view(session.id))
      },
    },
  }
}

export const useNotification = () => {
  const server = useServer()

  return server.ctx.notification
}
