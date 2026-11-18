import { ClientError, type OpenCodeClient, type TaskQueueInfo, type TaskQueueTask } from "@opencode/client"
import { batch, createSignal } from "solid-js"
import { errorMessage } from "../../util/error"

export function sameTaskDirectory(left: string, right: string) {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "")
  const a = normalize(left)
  const b = normalize(right)
  // A remote POSIX directory is case-sensitive even when this TUI runs on Windows.
  // Trimming a Windows drive root also removes its slash, leaving e.g. "D:".
  return /^[a-z]:(?:\/|$)/i.test(a) || a.startsWith("//") ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function taskQueueCounts(tasks: readonly TaskQueueTask[]) {
  const count = (status: TaskQueueTask["status"]) => tasks.filter((task) => task.status === status).length
  return `完成 ${count("completed")} · 失败 ${count("failed")} · 阻塞 ${count("blocked")} · 待执行 ${count("pending")} · 中断 ${count("interrupted")} · 跳过 ${count("cancelled")}`
}

export function canResumeTaskQueue(info: TaskQueueInfo) {
  return info.status === "stopped" || info.status === "interrupted" ||
    (info.status === "done" && info.tasks.some((task) => task.status === "blocked" || task.status === "failed"))
}

export function taskQueueError(cause: unknown) {
  // HTTP errors are decoded at the client boundary; keep this one presentation check here.
  const error = cause instanceof ClientError ? cause.cause : cause
  if (typeof error === "object" && error !== null &&
    (("status" in error && error.status === 403) || ("_tag" in error && error._tag === "ForbiddenError")))
    return "任务队列不可用，请检查访问权限。"
  return `无法访问任务队列：${errorMessage(cause)}`
}

/** The getter returns the stable SDK resource for the current connection, not a fresh wrapper. */
export function createTaskQueueFeed(api: () => Pick<OpenCodeClient["taskQueue"], "list" | "get">) {
  const [items, setItems] = createSignal<TaskQueueInfo[]>([])
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [listed, setListed] = createSignal(false)
  const [connectionVersion, setConnectionVersion] = createSignal(0)
  const versions = new Map<string, number>()
  // A successful deletion wins over delayed SSE and reads in this directory/connection lifetime.
  const removed = new Set<string>()
  let directory = ""
  let canonical: string | undefined
  let alias: string | undefined
  let epoch = 0
  let revision = 0
  let request = 0
  let connection = api()

  function reset() {
    epoch++
    request++
    canonical = undefined
    alias = undefined
    versions.clear()
    removed.clear()
    batch(() => {
      setListed(false)
      setLoading(true)
      setItems([])
      setError(undefined)
    })
  }

  function sync() {
    const next = api()
    if (next !== connection) {
      connection = next
      reset()
      setConnectionVersion((version) => version + 1)
    }
    return epoch
  }

  // Directory and connection lifetimes invalidate data, not the panel's draft.
  function capture() {
    const current = sync()
    return () => current === sync()
  }

  const belongs = (value: string) => sameTaskDirectory(value, directory) ||
    (canonical !== undefined && sameTaskDirectory(value, canonical)) ||
    (alias !== undefined && sameTaskDirectory(value, alias))

  // Only a successful directory-scoped request can confirm a server-side alias.
  // SSE/get cannot resolve a directory on the client's (possibly different) filesystem.
  function confirm(infos: readonly TaskQueueInfo[]) {
    const value = infos[0]?.directory
    if (value && infos.every((info) => sameTaskDirectory(info.directory, value))) {
      canonical = value
      alias ??= directory
    }
  }

  function update(info: TaskQueueInfo) {
    sync()
    if (!belongs(info.directory) || removed.has(info.id)) return
    const previous = items().find((item) => item.id === info.id)
    if (previous && previous.time.updated > info.time.updated) return
    versions.set(info.id, ++revision)
    setError(undefined)
    setItems((items) => [info, ...items.filter((item) => item.id !== info.id)].sort((a, b) => b.time.created - a.time.created))
  }

  async function load() {
    const valid = capture()
    const attempt = ++request
    const before = revision
    setLoading(true)
    setError(undefined)
    await connection.list({ directory }).then((result) => {
      if (!valid() || attempt !== request) return
      confirm(result)
      const known = new Map(items().map((info) => [info.id, info]))
      // Revision protects in-flight events; the timestamp floor also protects facts known before this read.
      const fresh = result
        .filter((info) => belongs(info.directory) && !removed.has(info.id) && (versions.get(info.id) ?? 0) <= before)
        .map((info) => {
          const previous = known.get(info.id)
          return previous && previous.time.updated > info.time.updated ? previous : info
        })
      const changed = [...known.values()].filter((info) => (versions.get(info.id) ?? 0) > before)
      setItems([...fresh, ...changed].sort((a, b) => b.time.created - a.time.created))
      setListed(true)
    }, (cause) => {
      if (valid() && attempt === request) setError(taskQueueError(cause))
    })
    if (valid() && attempt === request) setLoading(false)
  }

  async function get(queueID: string) {
    const valid = capture()
    const before = versions.get(queueID)
    await connection.get({ queueID }).then((info) => {
      if (valid() && before === versions.get(queueID)) update(info)
    }, (cause) => {
      if (valid()) setError(taskQueueError(cause))
    })
  }

  async function created(response: Promise<TaskQueueInfo>) {
    const valid = capture()
    return response.then((info) => {
      if (!valid()) return
      confirm([info])
      update(info)
      return info
    }, (cause) => { if (valid()) throw cause })
  }

  function remove(queueID: string) {
    sync()
    removed.add(queueID)
    versions.set(queueID, ++revision)
    setItems((items) => items.filter((item) => item.id !== queueID))
  }

  return {
    items, error, loading, load, get, update, remove, created, capture, connection: connectionVersion,
    // Unknown after a new SDK or a failed first read is not a deletion fact.
    missing(queueID: string) {
      return !items().some((info) => info.id === queueID) && (removed.has(queueID) || (listed() && !loading()))
    },
    sameDirectory(value: string) { sync(); return directory !== "" && belongs(value) },
    directory(value: string) {
      sync()
      if (directory !== "" && belongs(value)) {
        // Keep the live spelling as the next SDK's request scope, but preserve
        // this SDK's confirmed alias for same-identity Location transitions.
        directory = value
        return false
      }
      directory = value
      reset()
      void load()
      return true
    },
    dispose() { epoch++; request++; removed.clear(); canonical = undefined; alias = undefined },
  }
}
