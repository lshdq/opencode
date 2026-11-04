import type { AttentionDiagnostic, Data } from "@opencode/plugin/tui/context"
import type { LogTags } from "./context/log"

const types = new Set(["default", "question", "permission", "error", "done", "subagent_done"])
const reasons = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "form.created",
  "permission.asked",
])

// Plugin metadata is untrusted. Copy only bounded identifiers and closed classifications,
// never arbitrary tags, text, paths, or exceptions into the shared log.
function identifier(value: unknown) {
  return typeof value === "string" && /^[\w.:-]{1,180}$/.test(value) ? value : null
}

// The host has already validated plugin identity (a nonempty string, not a session ID).
// Keep printable names, including npm scopes; the shared logger quotes logfmt values.
// Bound the source and escape terminal controls without changing plugin registration rules.
function pluginSource(value: string) {
  const bounded = value.length > 180 ? `${value.slice(0, 180)}…` : value
  return bounded.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`)
}

export function createAttentionDiagnostics(input: {
  data?: Data
  log?: (message: string, tags: LogTags) => void
}) {
  const parents = new Map<string, string | undefined>()
  const active = new Set<string>()
  const latestLifecycle = new Map<string, number>()
  const deleted = new Set<string>()
  const shells = new Map<string, string>()
  const dispose: (() => void)[] = []
  const data = input.data
  const advance = (sessionID: string, seq: number | undefined) => {
    if (seq === undefined) return true
    const previous = latestLifecycle.get(sessionID)
    if (previous !== undefined && seq <= previous) return false
    latestLifecycle.set(sessionID, seq)
    return true
  }
  const remember = (sessionID: string) => {
    const visited = new Set<string>()
    let current: string | undefined = sessionID
    while (current && !visited.has(current)) {
      visited.add(current)
      const session = data?.session.get(current)
      if (session) parents.set(current, session.parentID)
      current = parents.get(current)
    }
  }
  if (data) {
    dispose.push(
      data.on("session.created", (event) => {
        if (!advance(event.data.sessionID, event.durable?.seq)) return
        deleted.delete(event.data.sessionID)
        parents.set(event.data.sessionID, event.data.parentID)
      }),
      data.on("session.deleted", (event) => {
        if (!advance(event.data.sessionID, event.durable?.seq)) return
        active.delete(event.data.sessionID)
        deleted.add(event.data.sessionID)
        if (deleted.size > 512) {
          const oldest = deleted.values().next().value
          if (oldest !== undefined) {
            deleted.delete(oldest)
            latestLifecycle.delete(oldest)
          }
        }
        // An observed shell can outlive its owner; retain its ancestry until
        // neither the cache nor observed work needs it.
      }),
      data.on("session.execution.started", (event) => {
        if (deleted.has(event.data.sessionID) || !advance(event.data.sessionID, event.durable?.seq)) return
        active.add(event.data.sessionID)
        remember(event.data.sessionID)
      }),
      ...(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] as const).map(
        (type) => data.on(type, (event) => {
          if (deleted.has(event.data.sessionID) || !advance(event.data.sessionID, event.durable?.seq)) return
          active.delete(event.data.sessionID)
        }),
      ),
      data.on("shell.created", (event) => {
        const owner = event.data.info.metadata.sessionID
        if (typeof owner === "string" && event.data.info.status === "running") {
          shells.set(event.data.info.id, owner)
          remember(owner)
        }
      }),
      data.on("shell.exited", (event) => shells.delete(event.data.id)),
      data.on("shell.deleted", (event) => shells.delete(event.data.id)),
      data.on("server.connected", () => {
        // Observations from the old connection are not proof of current activity.
        // Keep sequence/deletion barriers: raw replay must not undo the recovered cache.
        active.clear()
        shells.clear()
      }),
    )
  }

  function statistics(sessionID: string | null) {
    const unknown = {
      rootSessionID: null,
      runningSubagents: null,
      runningShells: null,
      pendingCount: null,
      statisticsComplete: false,
      statisticsScope: "unassociated" as string,
    }
    if (!sessionID) return unknown
    if (!data) return { ...unknown, statisticsScope: "data_unavailable" }
    const sessions = new Map(data.session.list().map((session) => [session.id, session]))
    const retained = new Set([...sessions.keys(), ...active, ...shells.values()])
    for (const id of retained) {
      remember(id)
      const visited = new Set<string>()
      let current: string | undefined = id
      while (current && !visited.has(current)) {
        visited.add(current)
        retained.add(current)
        current = parents.get(current)
      }
    }
    for (const id of parents.keys()) {
      if (retained.has(id)) continue
      parents.delete(id)
    }
    for (const id of latestLifecycle.keys()) if (!retained.has(id) && !deleted.has(id)) latestLifecycle.delete(id)
    const parent = (id: string) => {
      const session = sessions.get(id) ?? data.session.get(id)
      if (session) return { known: true, id: session.parentID }
      return { known: parents.has(id), id: parents.get(id) }
    }
    const root = (id: string): string | undefined => {
      const visited = new Set<string>()
      let current = id
      while (!visited.has(current)) {
        visited.add(current)
        const next = parent(current)
        if (!next.known) return
        if (!next.id) return current
        current = next.id
      }
    }
    const rootID = root(sessionID)
    if (!rootID) return { ...unknown, statisticsScope: "root_unresolved" }
    const family = new Set([
      rootID,
      ...data.session.family(rootID),
      ...sessions.keys(),
      ...parents.keys(),
      ...active,
      ...shells.values(),
    ].filter((id) => root(id) === rootID))
    const runningShells = new Set([...shells].filter(([, owner]) => family.has(owner)).map(([id]) => id))
    const pending = new Set<string>()
    for (const id of family) {
      const listed = data.shell.listBySession?.(id) ?? data.shell.list().filter((shell) => shell.metadata.sessionID === id)
      for (const shell of listed) if (shell.status === "running") runningShells.add(shell.id)
      for (const item of data.session.pending.list(id)) pending.add(item.id)
    }
    return {
      rootSessionID: identifier(rootID),
      runningSubagents: [...family].filter(
        (id) => id !== rootID && !deleted.has(id) && (active.has(id) || data.session.status(id) === "running"),
      ).length || null,
      runningShells: runningShells.size || null,
      pendingCount: pending.size || null,
      statisticsComplete: false,
      // These APIs return [] even before a read. An empty cache cannot prove zero.
      statisticsEmptyIsUnknown: true,
      statisticsScope: data.shell.listBySession
        ? "known_root_family_cached_locations_and_observed_events"
        : "known_root_family_default_location_and_observed_events",
    }
  }

  return {
    snapshot(diagnostic?: AttentionDiagnostic, pluginID = "tui") {
      const sessionID = identifier(diagnostic?.sessionID)
      const tags = {
        component: "attention",
        type: diagnostic?.type && types.has(diagnostic.type) ? diagnostic.type : "unknown",
        reason: diagnostic?.reason && reasons.has(diagnostic.reason) ? diagnostic.reason : "unknown",
        eventID: identifier(diagnostic?.eventID),
        sessionID,
        pluginID: pluginSource(pluginID),
      }
      try {
        return Object.freeze({ ...tags, ...statistics(sessionID) })
      } catch {
        return Object.freeze({
          ...tags,
          rootSessionID: null,
          runningSubagents: null,
          runningShells: null,
          pendingCount: null,
          statisticsComplete: false,
          statisticsScope: "snapshot_unavailable",
        })
      }
    },
    record(tags: LogTags) {
      try {
        input.log?.("TUI attention", tags)
      } catch {
        // Logging must not change notification behavior, including error handling.
      }
    },
    dispose() {
      dispose.reverse().forEach((cleanup) => cleanup())
      parents.clear()
      active.clear()
      latestLifecycle.clear()
      deleted.clear()
      shells.clear()
    },
  }
}
