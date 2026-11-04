import { Plugin } from "@opencode/plugin/tui"
import type { LocationRef, OpenCodeEvent, SessionInfo } from "@opencode/client"
import type { AttentionSoundName } from "@opencode/plugin/tui/context"
import { suppressTuiAttention } from "../../attention"
import { createComputed, createRoot, untrack } from "solid-js"

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

type NotificationEvent = Exclude<LifecycleEvent, { type: "session.execution.started" }> | Extract<
  OpenCodeEvent,
  { type: "form.created" | "permission.asked" }
>

const MAX_PENDING_LIFECYCLE_EVENTS = 1024

function notify(
  context: Plugin.Context,
  event: NotificationEvent,
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
    diagnostic: { type: sound, reason: event.type, eventID: event.id, sessionID },
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
    const latestLifecycle = new Map<string, number>()
    let pendingLifecycleOverflowed = false
    const rememberDeleted = (sessionID: string) => {
      deleted.add(sessionID)
      if (deleted.size <= 256) return
      const oldest = deleted.values().next().value
      if (oldest !== undefined) deleted.delete(oldest)
    }
    const forms = new Set<string>()
    const permissions = new Set<string>()
    const resolvedForms = new Set<string>()
    const resolvedPermissions = new Set<string>()
    const resolved = (items: Set<string>, id: string) => {
      items.add(id)
      if (items.size <= 256) return
      const oldest = items.values().next().value
      if (oldest !== undefined) items.delete(oldest)
    }
    const suppress = (event: NotificationEvent, reason: string, sessionID: string, type: AttentionSoundName = "done") =>
      suppressTuiAttention(context.attention, { type, reason: event.type, eventID: event.id, sessionID }, reason)

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
          latestLifecycle.delete(sessionID)
        }
      }
    }

    const parentID = (sessionID: string) =>
      parents.has(sessionID) ? parents.get(sessionID) : context.data.session.get(sessionID)?.parentID

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

    let reconnecting: Promise<void> | undefined

    const processTerminalEvent = (event: TerminalEvent) => {
      const sessionID = event.data.sessionID
      if (deleted.has(sessionID) || terminal.has(sessionID)) {
        suppress(event, deleted.has(sessionID) ? "session_deleted" : "duplicate_terminal", sessionID)
        return
      }

      if (event.type === "session.execution.failed") {
        if (errored.has(sessionID)) {
          ended(event)
          return
        }
        errored.add(sessionID)
        if (event.data.error.type !== "provider.free-limit" && event.data.error.type !== "provider.go-limit") {
          notify(context, event, sessionID, event.data.error.message, "error", undefined, parentID(sessionID) !== undefined)
          context.ui.toast.show({ sessionID, title: "Session failed", message: event.data.error.message, variant: "error" })
        }
      }

      ended(event)
    }

    const processLifecycleEvent = (event: LifecycleEvent) => {
      const previous = latestLifecycle.get(event.data.sessionID)
      if (event.durable && previous !== undefined && event.durable.seq <= previous) {
        if (event.type !== "session.execution.started") suppress(event, "stale_lifecycle", event.data.sessionID)
        return
      }
      if (event.durable) latestLifecycle.set(event.data.sessionID, event.durable.seq)
      if (event.type === "session.execution.started") {
        started(event.data.sessionID)
        return
      }
      if (event.type === "session.execution.interrupted") {
        ended(event)
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
            const previous = pendingLifecycleEvents[existing]
            if (event.durable && previous?.durable && event.durable.seq <= previous.durable.seq) {
              suppress(event, "reconnect_coalesced", event.data.sessionID)
              return
            }
            if (previous && previous.type !== "session.execution.started") {
              suppress(previous, "reconnect_coalesced", previous.data.sessionID)
            }
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
        suppressTuiAttention(context.attention, {}, "reconnect_lifecycle_overflow")
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
          flushPendingLifecycleEvents()
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
    const ended = (event: Exclude<LifecycleEvent, { type: "session.execution.started" }>) => {
      const sessionID = event.data.sessionID
      if (deleted.has(sessionID)) {
        suppress(event, "session_deleted", sessionID)
        return
      }
      // Synchronize first so a running session represents a new execution and
      // clears a terminal marker left by an earlier execution. Once this
      // execution is marked terminal, repeated idle terminal events remain
      // suppressed.
      synchronize()
      if (terminal.has(sessionID)) {
        suppress(event, "duplicate_terminal", sessionID)
        return
      }
      if (context.data.session.status(sessionID) === "running") {
        suppress(event, "session_running", sessionID)
        return
      }
      const subagent = parentID(sessionID) !== undefined
      terminal.add(sessionID)
      active.delete(sessionID)
      const erroredSession = errored.delete(sessionID)
      if (event.type !== "session.execution.succeeded" || erroredSession) {
        deferred.delete(sessionID)
        suppress(event, event.type === "session.execution.interrupted" ? "execution_interrupted" : "execution_failed", sessionID)
        return
      }
      if (context.data.session.pending.list(sessionID).length) {
        deferred.add(sessionID)
        suppress(event, "pending_input", sessionID, subagent ? "subagent_done" : "done")
        return
      }
      if (subagent) {
        notify(context, event, sessionID, "Session done", "subagent_done", undefined, true)
        return
      }
      if (hasRunningDescendant(sessionID)) {
        // This execution paused behind background work. Its success is obsolete:
        // completion delivery will wake the parent and only that new execution
        // may notify. Shell exit, child termination and reconnect never release it.
        deferred.add(sessionID)
        suppress(event, "background_work", sessionID)
        return
      }
      notify(context, event, sessionID, "Session done", "done", undefined, false)
    }

    const dispose = [
      context.data.on("form.created", (event) => {
        if (forms.has(event.data.form.id) || resolvedForms.has(event.data.form.id)) {
          suppress(event, "duplicate_or_resolved_input", event.data.form.sessionID, "question")
          return
        }
        forms.add(event.data.form.id)
        // Let the data projection and same-batch automatic settlement finish,
        // without a timer, before requesting user attention for an input.
        void Promise.resolve().then(() => {
          if (meta.disposed) return
          const pending = context.data.session.form.list(event.data.form.sessionID, event.location)
          if (!forms.has(event.data.form.id) || (pending && !pending.some((form) => form.id === event.data.form.id))) {
            forms.delete(event.data.form.id)
            resolved(resolvedForms, event.data.form.id)
            suppress(event, "input_no_longer_pending", event.data.form.sessionID, "question")
            return
          }
          notify(context, event, event.data.form.sessionID, "Input needs response", "question", event.data.form.title)
        })
      }),
      context.data.on("form.replied", (event) => {
        forms.delete(event.data.id)
        resolved(resolvedForms, event.data.id)
      }),
      context.data.on("form.cancelled", (event) => {
        forms.delete(event.data.id)
        resolved(resolvedForms, event.data.id)
      }),
      context.data.on("permission.asked", (event) => {
        if (permissions.has(event.data.id) || resolvedPermissions.has(event.data.id)) {
          suppress(event, "duplicate_or_resolved_input", event.data.sessionID, "permission")
          return
        }
        permissions.add(event.data.id)
        void Promise.resolve().then(() => {
          if (meta.disposed) return
          const pending = context.data.session.permission.list(event.data.sessionID)
          if (!permissions.has(event.data.id) || (pending && !pending.some((permission) => permission.id === event.data.id))) {
            permissions.delete(event.data.id)
            resolved(resolvedPermissions, event.data.id)
            suppress(event, "input_no_longer_pending", event.data.sessionID, "permission")
            return
          }
          notify(context, event, event.data.sessionID, "Permission needs input", "permission")
        })
      }),
      context.data.on("permission.replied", (event) => {
        permissions.delete(event.data.requestID)
        resolved(resolvedPermissions, event.data.requestID)
      }),
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
        latestLifecycle.delete(sessionID)
        synchronize()
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
      }),
      context.data.on("shell.deleted", (event) => {
        shells.delete(event.data.id)
        synchronize()
      }),
    ]

    const stopObservingActivity = createRoot((dispose) => {
      createComputed(() => {
        const running = context.data.session.list().filter((session) => context.data.session.status(session.id) === "running")
        // Reconnect's active HTTP read can finish after our session/shell barrier.
        // Consume running synchronously, before a terminal projection turns it
        // idle again. This only resets execution markers; it never releases done.
        untrack(() => {
          for (const session of running) {
            if (!deleted.has(session.id) && !active.has(session.id)) started(session.id)
          }
        })
      })
      return dispose
    })

    synchronize()

    return () => {
      meta.disposed = true
      stopObservingActivity()
      pendingLifecycleEvents.length = 0
      pendingLifecycleOverflowed = false
      dispose.reverse().forEach((cleanup) => cleanup())
    }
  },
})
