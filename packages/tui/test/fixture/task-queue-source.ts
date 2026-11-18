import { createEventStream, createFetch, directory, json } from "./tui-client"
import { taskQueue } from "./task-queue"

/** Actual authenticated HTTP/SSE endpoints shared by the panel and Tui.run regressions. */
export function taskQueueSource(mode: "foreign" | "same" = "foreign", rotate = true) {
  const first = createEventStream()
  const refreshed = createEventStream()
  const opened = Promise.withResolvers<void>()
  const returned = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<void>()
  const navigated = Promise.withResolvers<void>()
  const lists: ReturnType<typeof Promise.withResolvers<void>>[] = []
  const controls = { A: [] as string[], B: [] as string[] }
  const reads = { A: 0, B: 0 }
  const versions: number[] = []
  const rejected: string[] = []
  const sessions: string[] = []
  let version = 1
  let reconnects = 0
  let info = row("A actual running", "queued", "ses_A", 1)
  const foreign = row("B foreign terminal", "done", "ses_B", 3)
  const auth = (source: string) => ({ type: "basic", username: "fixture", password: `panel-${source}` } as const)
  const authorization = (source: string) => "Basic " + Buffer.from(`fixture:${auth(source).password}`).toString("base64")
  const calls = (source: "A" | "B") => createFetch((url, request) => {
    if (request.headers.get("authorization") !== authorization(source === "A" ? `A${rotate ? version : 1}` : "B")) {
      rejected.push(`${source}:${url.pathname}`)
      return new Response(null, { status: 401 })
    }
    if (url.pathname === "/api/event") {
      if (source === "B") return new Response([
        { id: "evt_B_connected", type: "server.connected", data: {} },
        { id: "evt_foreign", created: 3, type: "taskqueue.updated", data: foreign },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
      if (version === 2) { opened.resolve(); return refreshed.v2() }
      return first.v2()
    }
    if (url.pathname.startsWith("/api/task-queue")) {
      const method = url.pathname.split("/").at(-1)!
      if (url.pathname === "/api/task-queue") {
        reads[source]++
        if (source === "A") lists.splice(0).forEach((list) => list.resolve())
        return json({ data: [source === "A" ? info : foreign] })
      }
      if (["start", "stop", "heartbeat"].includes(method)) {
        controls[source].push(method)
        if (source === "A") versions.push(rotate ? version : 1)
      }
      if (source === "A" && method === "start") { info = row("A actual running", "running", "ses_A", 2); started.resolve() }
      if (source === "A" && method === "stop") { info = row("A actual stopped", "stopped", "ses_A", 4); stopped.resolve() }
      return json({ data: source === "A" ? info : foreign })
    }
    const session = /^\/api\/session\/(ses_[AB])$/.exec(url.pathname)?.[1]
    if (session) {
      sessions.push(`${source}:${session}`)
      navigated.resolve()
      return json({ data: { id: session, title: session === "ses_A" ? "Correct A session" : "Wrong B session", projectID: "proj_test", location: { directory },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } } })
    }
    if (/^\/api\/session\/ses_[AB]\/message$/.test(url.pathname)) return json({ data: [], cursor: {} })
    if (/^\/api\/session\/ses_[AB]\/(inbox|permission)$/.test(url.pathname)) return json({ data: [] })
    return undefined
  }).fetch
  return {
    a: calls("A"), b: calls("B"), auth, authorization, controls, reads, versions, rejected, sessions,
    opened: opened.promise, returned: returned.promise, started: started.promise, stopped: stopped.promise, navigated: navigated.promise,
    reconnect(a: string, b: string) {
      reconnects++
      if (mode === "foreign" && reconnects === 1) return { url: b, auth: auth("B") }
      version = 2
      returned.resolve()
      return { url: a, auth: auth(rotate ? "A2" : "A1") }
    },
    migrate() {
      if (mode === "same") first.emit({ id: "evt_old_A", created: 3, type: "taskqueue.updated", data: row("A old terminal", "done", "ses_A", 3) })
      first.disconnect()
    },
    terminal() {
      info = row("A refreshed terminal", "done", "ses_A", 4)
      refreshed.emit({ id: "evt_current_A", created: 4, type: "taskqueue.updated", data: info })
    },
    refreshReceipt() { info = { ...info, title: "A explicit refresh receipt" } },
    nextList() { const list = Promise.withResolvers<void>(); lists.push(list); return list.promise },
    dispose() { first.disconnect(); refreshed.disconnect() },
  }
}

function row(title: string, status: "queued" | "running" | "stopped" | "done", sessionID: string, updated: number) {
  return taskQueue({ directory, title, status, time: { created: 1, updated }, tasks: [{ ...taskQueue().tasks[0],
    status: status === "done" ? "completed" : status === "queued" ? "pending" : status === "stopped" ? "interrupted" : "running",
    sessionID, time: { created: 1, updated },
  }] })
}

export function sourceSignal<T>(promise: Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Actual panel HTTP/SSE signal missing after two seconds")), 2_000)
    void promise.then((value) => { clearTimeout(deadline); resolve(value) }, (cause: unknown) => { clearTimeout(deadline); reject(cause) })
  })
}
