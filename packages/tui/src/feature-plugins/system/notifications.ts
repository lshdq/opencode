import { Plugin } from "@opencode/plugin/tui"
import type { LocationRef, OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { AttentionSoundName } from "@opencode/plugin/tui/context"

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

const MAX_PENDING_LIFECYCLE_EVENTS = 1024

function notify(
  context: Plugin.Context,
  sessionID: string | undefined,
  message: string,
  sound: AttentionSoundName,
  title?: string,
  isSubagent = sessionID ? context.data.session.get(sessionID)?.parentID !== undefined : false,
) {
  const session = sessionID ? context.data.session.get(sessionID) : undefined
  void context.attention.notify({
    title: title ?? session?.title,
    message,
    notification: isSubagent ? false : { when: "blurred" },
    sound: { name: sound, when: "always" },
  })
}

export default Plugin.define({
  id: "opencode.notifications",
  setup(context) {
    const meta = { disposed: false }
    const errored = new Set<string>()
    const terminal = new Set<string>()
    const deferred = new Set<string>()
    const active = new Set<string>()
    const parents = new Map<string, string | undefined>()
    const shells = new Map<string, { ownerSessionID: string; ancestors: Set<string>; location: LocationRef }>()
    const deleted = new Set<string>()
    const pendingLifecycleEvents: LifecycleEvent[] = []
    let pendingLifecycleOverflowed = false
    const rememberDeleted = (sessionID: string) => {
      deleted.add(sessionID)
      if (deleted.size <= 256) return
      const oldest = deleted.values().next().value
      if (oldest !== undefined) deleted.delete(oldest)
    }
    const forms = new Set<string>()
    const permissions = new Set<string>()

    const synchronize = (reconnect = false) => {
      const sessions = context.data.session.list()
      const byID = new Map(sessions.map((session) => [session.id, session]))
      const loaded = new Set(sessions.map((session) => session.id))

      if (reconnect) reconcileShells()

      for (const session of sessions) {
        if (deleted.has(session.id)) continue
        if (context.data.session.status(session.id) === "running") {
          terminal.delete(session.id)
          deferred.delete(session.id)
          active.add(session.id)
          continue
        }
        if (terminal.has(session.id)) {
          active.delete(session.id)
          continue
        }
        active.delete(session.id)
      }

      const retained = new Set([...active, ...deferred])
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
          const loadedSession: SessionInfo | undefined = deleted.has(currentID) ? undefined : byID.get(currentID)
          const hydratedSession: SessionInfo | undefined =
            deleted.has(currentID) || loadedSession ? undefined : context.data.session.get(currentID)
          if (loadedSession) parents.set(currentID, loadedSession.parentID)
          if (hydratedSession) parents.set(currentID, hydratedSession.parentID)
          const knownParentID: string | undefined = loadedSession
            ? loadedSession.parentID
            : hydratedSession
              ? hydratedSession.parentID
              : parents.get(currentID)
          if (!knownParentID) break
          currentID = knownParentID
        }
      }

      refreshShellAncestors()

      for (const parentID of parents.keys()) {
        if (!retained.has(parentID)) parents.delete(parentID)
      }

      // A terminal marker is only useful while its session is still in the
      // current data set, active, or deferred. Do not use a fixed-size FIFO:
      // that could evict a marker for a live session and turn a duplicate
      // terminal event into another notification.
      for (const sessionID of terminal) {
        if (!loaded.has(sessionID) && !active.has(sessionID) && !deferred.has(sessionID)) {
          terminal.delete(sessionID)
        }
      }
    }

    const parentID = (sessionID: string) =>
      parents.has(sessionID) ? parents.get(sessionID) : context.data.session.get(sessionID)?.parentID

    const isSubagent = (sessionID: string) => {
      synchronize()
      return parentID(sessionID) !== undefined
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

      return context.data.session.family(ancestorID).includes(sessionID)
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

    const listShellsBySession = (sessionID: string) => {
      if (context.data.shell.listBySession) return context.data.shell.listBySession(sessionID)
      return context.data.shell
        .list(context.location)
        .filter((shell) => shell.metadata.sessionID === sessionID)
    }

    const reconcileShells = () => {
      for (const shellID of shells.keys()) {
        const shell = context.data.shell.get(shellID)
        if (!shell || shell.status !== "running") shells.delete(shellID)
      }
    }

    const isRunning = (sessionID: string) =>
      !deleted.has(sessionID) &&
      !terminal.has(sessionID) &&
      (active.has(sessionID) || context.data.session.status(sessionID) === "running")

    const hasRunningDescendant = (sessionID: string) => {
      synchronize()
      const candidates = new Set(context.data.session.family(sessionID))
      for (const session of context.data.session.list()) candidates.add(session.id)
      for (const activeSessionID of active) candidates.add(activeSessionID)
      if ([...candidates].some(
        (candidateID) => isDescendant(candidateID, sessionID) && isRunning(candidateID),
      )) return true

      if (pendingLifecycleEvents.some((event) => isDescendant(event.data.sessionID, sessionID))) return true

      if (
        [...shells.values()].some(
          (shell) => shell.ownerSessionID === sessionID || shell.ancestors.has(sessionID),
        )
      ) return true

      const descendants = [...candidates].filter(
        (candidateID) => candidateID === sessionID || isDescendant(candidateID, sessionID),
      )
      return descendants.some((candidateID) =>
        listShellsBySession(candidateID).some((shell) => shell.status === "running"),
      )
    }

    const notifyReadyDeferredParents = () => {
      if (reconnecting || pendingLifecycleOverflowed) return

      synchronize()
      for (const deferredSessionID of deferred) {
        if (hasRunningDescendant(deferredSessionID)) continue
        deferred.delete(deferredSessionID)
        notify(context, deferredSessionID, "Session done", "done", undefined, isSubagent(deferredSessionID))
      }
    }

    let reconnecting: Promise<void> | undefined

    const processTerminalEvent = (event: TerminalEvent) => {
      const sessionID = event.data.sessionID
      if (deleted.has(sessionID) || terminal.has(sessionID)) return

      if (event.type === "session.execution.failed") {
        if (errored.has(sessionID)) {
          ended(sessionID)
          return
        }
        errored.add(sessionID)
        notify(context, sessionID, event.data.error.message, "error", undefined, parentID(sessionID) !== undefined)
        context.ui.toast.show({ sessionID, title: "Session failed", message: event.data.error.message, variant: "error" })
      }

      ended(sessionID)
    }

    const processLifecycleEvent = (event: LifecycleEvent) => {
      if (event.type === "session.execution.started") {
        started(event.data.sessionID)
        return
      }
      if (event.type === "session.execution.interrupted") {
        ended(event.data.sessionID)
        return
      }
      processTerminalEvent(event)
    }

    const handleLifecycleEvent = (event: LifecycleEvent) => {
      if (reconnecting) {
        if (event.type !== "session.execution.started") {
          const latestStarted = pendingLifecycleEvents.findLastIndex(
            (pending) =>
              pending.data.sessionID === event.data.sessionID && pending.type === "session.execution.started",
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
          return
        }

        pendingLifecycleEvents.push(event)
        return
      }
      processLifecycleEvent(event)
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
        const event = pendingLifecycleEvents.shift()
        if (event) processLifecycleEvent(event)
      }

      return true
    }

    const reconnect = () => {
      if (reconnecting) return reconnecting

      const locations = new Map<string, LocationRef>()
      const addLocation = (location: LocationRef) => {
        locations.set(`${location.directory}\0${location.workspaceID ?? ""}`, location)
      }
      for (const session of context.data.session.list()) {
        if (session.location) addLocation(session.location)
      }
      for (const shell of shells.values()) {
        addLocation(shell.location)
      }

      const sessionIDs = new Set<string>()
      const addSessionSyncCandidate = (sessionID: string) => {
        sessionIDs.add(sessionID)
        const rootID = context.data.session.root?.(sessionID)
        if (rootID) sessionIDs.add(rootID)
      }
      for (const session of context.data.session.list()) {
        if (!session.parentID) addSessionSyncCandidate(session.id)
      }
      for (const sessionID of [...active, ...deferred]) addSessionSyncCandidate(sessionID)
      for (const shell of shells.values()) addSessionSyncCandidate(shell.ownerSessionID)

      for (const location of locations.values()) context.data.shell.invalidate(location)
      for (const sessionID of sessionIDs) context.data.session.invalidate(sessionID)

      reconnecting = Promise.allSettled([
        ...[...locations.values()].map((location) => context.data.shell.sync(location)),
        ...(context.data.session.sync
          ? [...sessionIDs].map((sessionID) => context.data.session.sync(sessionID, { children: true }))
          : []),
      ])
        .then(() => {
          if (meta.disposed) return
          reconnecting = undefined
          synchronize(true)
          if (flushPendingLifecycleEvents()) notifyReadyDeferredParents()
        })
        .catch(() => undefined)
        .finally(() => {
          reconnecting = undefined
        })

      return reconnecting
    }

    const started = (sessionID: string) => {
      errored.delete(sessionID)
      terminal.delete(sessionID)
      deferred.delete(sessionID)
      active.add(sessionID)
      const session = context.data.session.get(sessionID)
      if (session) parents.set(sessionID, session.parentID)
    }
    const ended = (sessionID: string) => {
      if (deleted.has(sessionID)) return
      // Synchronize first so a running session represents a new execution and
      // clears a terminal marker left by an earlier execution. Once this
      // execution is marked terminal, repeated idle terminal events remain
      // suppressed.
      synchronize()
      if (terminal.has(sessionID)) return
      const subagent = parentID(sessionID) !== undefined
      terminal.add(sessionID)
      active.delete(sessionID)
      const erroredSession = errored.delete(sessionID)
      if (subagent) {
        if (!erroredSession) notify(context, sessionID, "Session done", "subagent_done", undefined, true)
        notifyReadyDeferredParents()
        return
      }
      if (erroredSession) {
        deferred.delete(sessionID)
        return
      }
      if (hasRunningDescendant(sessionID)) {
        deferred.add(sessionID)
        return
      }
      notify(context, sessionID, "Session done", "done", undefined, false)
    }

    const dispose = [
      context.data.on("form.created", (event) => {
        if (forms.has(event.data.form.id)) return
        forms.add(event.data.form.id)
        notify(context, event.data.form.sessionID, "Input needs response", "question", event.data.form.title)
      }),
      context.data.on("form.replied", (event) => forms.delete(event.data.id)),
      context.data.on("form.cancelled", (event) => forms.delete(event.data.id)),
      context.data.on("permission.asked", (event) => {
        if (permissions.has(event.data.id)) return
        permissions.add(event.data.id)
        notify(context, event.data.sessionID, "Permission needs input", "permission")
      }),
      context.data.on("permission.replied", (event) => permissions.delete(event.data.requestID)),
      context.data.on("session.created", (event) => {
        const sessionID = event.data.sessionID
        deleted.delete(sessionID)
        // The data layer may not expose a newly-created session yet. Keep the
        // event's relationship until a later synchronization can safely trim
        // it after the session is no longer active or deferred.
        synchronize()
        parents.set(sessionID, event.data.parentID)
        refreshShellAncestors()
      }),
      context.data.on("session.deleted", (event) => {
        const sessionID = event.data.sessionID
        synchronize()
        rememberDeleted(sessionID)
        errored.delete(sessionID)
        terminal.delete(sessionID)
        active.delete(sessionID)
        deferred.delete(sessionID)
        synchronize()
        notifyReadyDeferredParents()
      }),
      context.data.on("session.execution.started", (event) => handleLifecycleEvent(event)),
      context.data.on("session.execution.succeeded", (event) => handleLifecycleEvent(event)),
      context.data.on("session.execution.interrupted", (event) => handleLifecycleEvent(event)),
      context.data.on("session.execution.failed", (event) => handleLifecycleEvent(event)),
      context.data.on("shell.created", (event) => {
        const sessionID = event.data.info.metadata.sessionID
        if (typeof sessionID !== "string" || event.data.info.status !== "running") {
          shells.delete(event.data.info.id)
          return
        }

        shells.set(event.data.info.id, {
          ownerSessionID: sessionID,
          ancestors: shellAncestors(sessionID),
          location: event.location ?? context.data.location.default(),
        })
        synchronize()
      }),
      context.data.on("server.connected", () => void reconnect()),
      context.data.on("shell.exited", (event) => {
        shells.delete(event.data.id)
        synchronize()
        notifyReadyDeferredParents()
      }),
      context.data.on("shell.deleted", (event) => {
        shells.delete(event.data.id)
        synchronize()
        notifyReadyDeferredParents()
      }),
    ]

    synchronize()

    return () => {
      meta.disposed = true
      pendingLifecycleEvents.length = 0
      pendingLifecycleOverflowed = false
      dispose.reverse().forEach((cleanup) => cleanup())
    }
  },
})
