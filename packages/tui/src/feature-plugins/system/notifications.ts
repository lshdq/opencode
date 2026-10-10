import { Plugin } from "@opencode/plugin/tui"
import type { AttentionSoundName } from "@opencode/plugin/tui/context"

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
    const errored = new Set<string>()
    const terminal = new Set<string>()
    const deferred = new Set<string>()
    const active = new Set<string>()
    const parents = new Map<string, string | undefined>()
    const deleted = new Set<string>()
    const rememberDeleted = (sessionID: string) => {
      deleted.add(sessionID)
      if (deleted.size <= 256) return
      const oldest = deleted.values().next().value
      if (oldest !== undefined) deleted.delete(oldest)
    }
    const forms = new Set<string>()
    const permissions = new Set<string>()

    const synchronize = () => {
      const sessions = context.data.session.list()
      const byID = new Map(sessions.map((session) => [session.id, session]))
      const loaded = new Set(sessions.map((session) => session.id))

      for (const session of sessions) {
        if (deleted.has(session.id)) continue
        if (context.data.session.status(session.id) === "running") {
          terminal.delete(session.id)
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
      for (const sessionID of retained) {
        const visited = new Set<string>()
        let currentID: string | undefined = sessionID
        while (currentID && !visited.has(currentID)) {
          visited.add(currentID)
          retained.add(currentID)
          const knownParentID: string | undefined = parents.has(currentID)
            ? parents.get(currentID)
            : byID.get(currentID)?.parentID
          if (!knownParentID) break
          if (!parents.has(currentID)) parents.set(currentID, knownParentID)
          currentID = knownParentID
        }
      }

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

    const isRunning = (sessionID: string) =>
      !deleted.has(sessionID) &&
      !terminal.has(sessionID) &&
      (active.has(sessionID) || context.data.session.status(sessionID) === "running")

    const hasRunningDescendant = (sessionID: string) => {
      synchronize()
      const candidates = new Set(context.data.session.family(sessionID))
      for (const session of context.data.session.list()) candidates.add(session.id)
      for (const activeSessionID of active) candidates.add(activeSessionID)
      return [...candidates].some(
        (candidateID) => isDescendant(candidateID, sessionID) && isRunning(candidateID),
      )
    }

    const notifyReadyDeferredParents = () => {
      synchronize()
      for (const deferredSessionID of deferred) {
        if (hasRunningDescendant(deferredSessionID)) continue
        deferred.delete(deferredSessionID)
        notify(context, deferredSessionID, "Session done", "done", undefined, isSubagent(deferredSessionID))
      }
    }

    const started = (sessionID: string) => {
      errored.delete(sessionID)
      terminal.delete(sessionID)
      deferred.delete(sessionID)
      active.add(sessionID)
      synchronize()
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
        synchronize()
        // The data layer may not expose a newly-created session yet. Keep the
        // event's relationship until a later synchronization can safely trim
        // it after the session is no longer active or deferred.
        parents.set(sessionID, event.data.parentID)
      }),
      context.data.on("session.deleted", (event) => {
        const sessionID = event.data.sessionID
        synchronize()
        rememberDeleted(sessionID)
        errored.delete(sessionID)
        terminal.delete(sessionID)
        active.delete(sessionID)
        deferred.delete(sessionID)
        parents.delete(sessionID)
        notifyReadyDeferredParents()
      }),
      context.data.on("session.execution.started", (event) => started(event.data.sessionID)),
      context.data.on("session.execution.succeeded", (event) => ended(event.data.sessionID)),
      context.data.on("session.execution.interrupted", (event) => ended(event.data.sessionID)),
      context.data.on("session.execution.failed", (event) => {
        const sessionID = event.data.sessionID
        if (deleted.has(sessionID) || terminal.has(sessionID)) return
        if (errored.has(sessionID)) {
          ended(sessionID)
          return
        }
        errored.add(sessionID)
        notify(context, sessionID, event.data.error.message, "error", undefined, parentID(sessionID) !== undefined)
        context.ui.toast.show({ sessionID, title: "Session failed", message: event.data.error.message, variant: "error" })
        ended(sessionID)
      }),
    ]

    synchronize()

    return () => dispose.reverse().forEach((cleanup) => cleanup())
  },
})
