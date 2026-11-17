import type { OpenCodeClient, TaskQueueInfo } from "@opencode/client"

type Api = Pick<OpenCodeClient["experimental"]["taskQueue"], "start" | "resume" | "heartbeat" | "stop">
type Origin = {
  key: string | Api
  api: Api
  owned: Map<string, { info: TaskQueueInfo; renewal?: AbortController }>
  pending: Map<string, Promise<TaskQueueInfo>>
  observed: Map<string, TaskQueueInfo>
  ended: Map<string, number>
}

/** Process-local ownership, deliberately neither persisted nor reconstructed from list/get. */
export function createTaskQueueOwner(
  api: () => Api,
  repeat: (run: () => void, milliseconds: number) => () => void = (run, milliseconds) => {
    const timer = setInterval(run, milliseconds)
    timer.unref()
    return () => clearInterval(timer)
  },
  url: () => string | undefined = () => undefined,
) {
  const origins = new Map<string | Api, Origin>()
  let cancel: (() => void) | undefined
  let closing = false
  let closed: Promise<void> | undefined

  function connection() {
    const current = api()
    const key = sourceKey(current, url())
    const origin = origins.get(key)
    if (origin) origin.api = current
    return { key, api: current }
  }

  function release(origin: Origin) {
    if (!origin.owned.size && !origin.pending.size) origins.delete(origin.key)
  }

  function reconcileTimer() {
    const active = !closing && [...origins.values()].some((origin) => origin.owned.size)
    if (active && !cancel) cancel = repeat(heartbeat, 10_000)
    if (active) return
    cancel?.()
    cancel = undefined
  }

  function observe(origin: Origin, info: TaskQueueInfo) {
    const previous = origin.observed.get(info.id)
    if (origin.pending.has(info.id) && (!previous || info.time.updated >= previous.time.updated)) origin.observed.set(info.id, info)
    // A later run must not erase the end of this pending action's own run.
    if (origin.pending.has(info.id) && info.status !== "running") {
      origin.ended.set(info.id, Math.max(origin.ended.get(info.id) ?? -1, info.time.updated))
    }
    const entry = origin.owned.get(info.id)
    if (!entry || info.time.updated < entry.info.time.updated) return
    entry.info = info
    if (info.status !== "running") {
      entry.renewal?.abort()
      origin.owned.delete(info.id)
    }
    release(origin)
    reconcileTimer()
  }

  function heartbeat() {
    if (closing) return
    connection()
    origins.forEach((origin) => origin.owned.forEach((entry, queueID) => {
      if (entry.renewal) return
      const controller = new AbortController()
      entry.renewal = controller
      void origin.api.heartbeat({ queueID }, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) }).then(
        (info) => {
          if (origin.owned.get(queueID) === entry) observe(origin, info)
        },
        // A transient network error must not surrender ownership or stop the batch.
        () => undefined,
      ).finally(() => { if (entry.renewal === controller) entry.renewal = undefined })
    }))
  }

  function stopOnExit(origin: Origin, queueID: string) {
    connection()
    return origin.api.stop(
      { queueID, reason: "启动批次的 TUI 已退出；请通过 /tasks 手动继续。" },
      { signal: AbortSignal.timeout(2_000) },
    ).catch(() => undefined)
  }

  function acquire(queueID: string, action: "start" | "resume") {
    if (closing) return Promise.reject(new Error("TUI 正在退出，无法启动批次。"))
    const current = connection()
    const origin: Origin = origins.get(current.key) ?? {
      ...current,
      owned: new Map(),
      pending: new Map<string, Promise<TaskQueueInfo>>(),
      observed: new Map<string, TaskQueueInfo>(),
      ended: new Map<string, number>(),
    }
    origins.set(current.key, origin)
    const existing = origin.pending.get(queueID)
    if (existing) return existing
    const request = origin.api[action]({ queueID }).then(async (info) => {
      const latest = origin.observed.get(queueID)
      const current = latest && latest.time.updated >= info.time.updated ? latest : info
      // Only the explicit operation's response grants ownership. Observations may
      // update the view, but an end at/after that response revokes this operation.
      const eligible = info.status === "running" && (origin.ended.get(queueID) ?? -1) < info.time.updated
      // Start can finish after the panel unmounts, or after app shutdown has begun.
      if (closing) {
        if (eligible) await stopOnExit(origin, queueID)
        return current
      }
      if (eligible) origin.owned.set(queueID, { info: current })
      reconcileTimer()
      return current
    }).finally(() => {
      origin.pending.delete(queueID)
      origin.observed.delete(queueID)
      origin.ended.delete(queueID)
      release(origin)
    })
    origin.pending.set(queueID, request)
    return request
  }

  function shutdown() {
    if (closed) return closed
    closing = true
    reconcileTimer()
    const stops = [...origins.values()].flatMap((origin) => {
      origin.owned.forEach((entry) => entry.renewal?.abort())
      const requests = [...origin.owned.keys()].map((queueID) => stopOnExit(origin, queueID))
      origin.owned.clear()
      release(origin)
      return requests
    })
    // Do not let an unresponsive service hold terminal teardown indefinitely.
    // A late successful start still runs stopOnExit; process death falls back to the lease TTL.
    closed = new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, 2_000)
      void Promise.allSettled([...stops, ...[...origins.values()].flatMap((origin) => [...origin.pending.values()])]).then(() => {
        clearTimeout(deadline)
        resolve()
      })
    })
    return closed
  }

  function observer(source?: { api: Api; url?: string }) {
    const key = source ? sourceKey(source.api, source.url) : connection().key
    // Event snapshots select identity only: an old buffered SDK must not roll
    // back the current source's refreshed credentials used for control requests.
    return (info: TaskQueueInfo) => {
      const origin = origins.get(key)
      if (origin) observe(origin, info)
    }
  }

  return {
    acquire, observer, observe: (info: TaskQueueInfo) => observer()(info), shutdown,
    refresh(source: { api: Api; url?: string }) {
      // Only active responsibilities retain control resources. A resolved SDK
      // updates them even if another reconnect wins before its events flush.
      const origin = origins.get(sourceKey(source.api, source.url))
      if (origin) origin.api = source.api
    },
    owns: (queueID: string) => origins.get(connection().key)?.owned.has(queueID) ?? false,
  }
}

function sourceKey(api: Api, address?: string) {
  // URL identity survives SDK/credential refresh. Without an endpoint, only
  // the exact resource object's identity is known; never infer migration.
  if (!address) return api
  const endpoint = new URL(address)
  endpoint.username = ""
  endpoint.password = ""
  endpoint.hash = ""
  return endpoint.toString()
}
