import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { createRoot, createSignal } from "solid-js"
import { createPanelState } from "../../src/context/panel"
import { createTaskQueueFeed } from "../../src/feature-plugins/system/tasks-data"
import { createTaskQueueDisplay, TASK_QUEUE_PANEL } from "../../src/feature-plugins/system/tasks-display"
import { taskQueue } from "../fixture/task-queue"
import { createFetch, json } from "../fixture/tui-client"

test.each(["list", "create"] as const)("only the current scoped %s confirms directory identity, never SSE/get or an old SDK", async (source) => {
  const alias = "/remote/alias"
  const canonical = "/remote/canonical"
  const value = taskQueue({ directory: canonical })
  let listed = false
  const fetch = createFetch((url, request) => {
    if (url.pathname === "/api/task-queue") return json({ data: request.method === "POST" ? value : listed ? [value] : [] })
    if (url.pathname === `/api/task-queue/${value.id}`) return json({ data: value })
    return undefined
  }).fetch
  let client = OpenCode.make({ baseUrl: "http://fixture", fetch })
  const feed = createTaskQueueFeed(() => client.taskQueue)
  try {
    feed.directory(alias)
    await feed.load()
    feed.update(value)
    await feed.get(value.id)
    expect(feed.sameDirectory(canonical)).toBe(false)
    expect(feed.items()).toEqual([])
    const ticket = feed.capture()
    if (source === "list") { listed = true; await feed.load() }
    if (source === "create") await feed.created(client.taskQueue.create({ directory: alias, tasks: [{ prompt: "Original content" }] }))
    expect(feed.sameDirectory(canonical)).toBe(true)
    expect(feed.sameDirectory(alias)).toBe(true)
    expect(feed.sameDirectory("/remote/other")).toBe(false)
    expect(ticket()).toBe(true)
    expect(feed.items()).toEqual([value])
    client = OpenCode.make({ baseUrl: "http://fixture", fetch })
    expect(feed.sameDirectory(canonical)).toBe(false)
    expect(ticket()).toBe(false)
    expect(feed.items()).toEqual([])
    expect(feed.missing(value.id)).toBe(false)
    feed.directory("/remote/other")
    feed.update(value)
    expect(feed.items()).toEqual([])
  } finally {
    feed.dispose()
  }
})

test.each(["event", "list", "empty", "delete"] as const)("a failed refreshed read retains follow until an authoritative %s fact", async (recovery) => {
  const root = createRoot((dispose) => {
    const [route, navigate] = createSignal("home")
    const panels = createPanelState()
    let value = taskQueue({ status: "running", currentTaskID: "tqt_one", tasks: [{ ...taskQueue().tasks[0], status: "running", sessionID: "ses_first" }] })
    let failing = false
    let empty = false
    const fetch = createFetch(() => failing ? new Response(null, { status: 503 }) : json({ data: empty ? [] : [value] })).fetch
    let client = OpenCode.make({ baseUrl: "http://fixture", fetch })
    const feed = createTaskQueueFeed(() => client.taskQueue)
    const display = createTaskQueueDisplay({ feed, route, navigate, panel: panels.current,
      open: (sessionID) => panels.open({ plugin: "tasks", name: TASK_QUEUE_PANEL, sessionID }), close: () => panels.release("tasks") })
    return { feed, display, route, panels, dispose,
      initial: () => value,
      refresh() { failing = true; client = OpenCode.make({ baseUrl: "http://fixture", fetch }); feed.capture() },
      recover() { failing = false; value = { ...value, tasks: [{ ...value.tasks[0], sessionID: "ses_next" }], time: { created: 1, updated: 3 } }; return value },
      empty() { empty = true },
    }
  })
  try {
    root.feed.directory(root.initial().directory)
    await root.feed.load()
    root.display.prepare()(root.initial(), () => {})
    expect(root.route()).toBe("ses_first")
    root.refresh()
    expect(root.display.info()).toBeUndefined()
    expect(root.feed.missing(root.initial().id)).toBe(false)
    await root.feed.load()
    expect(root.feed.error()).toContain("无法访问任务队列")
    expect(root.feed.loading()).toBe(false)
    expect(root.display.following()).toBe(true)
    expect(root.display.visible()).toBe(true)
    expect(root.panels.current()?.name).toBe(TASK_QUEUE_PANEL)
    const next = root.recover()
    if (recovery === "event") root.feed.update(next)
    if (recovery === "list") await root.feed.load()
    if (recovery === "empty") { root.empty(); await root.feed.load() }
    if (recovery === "delete") root.feed.remove(next.id)
    if (recovery === "event" || recovery === "list") {
      expect(root.route()).toBe("ses_next")
      expect(root.display.following()).toBe(true)
      expect(root.feed.error()).toBeUndefined()
      return
    }
    expect(root.feed.missing(next.id)).toBe(true)
    expect(root.display.info()).toBeUndefined()
    expect(root.display.following()).toBe(false)
    expect(root.panels.current()).toBeUndefined()
    root.feed.update(next)
    expect(root.route()).toBe("ses_first")
    expect(root.display.following()).toBe(false)
  } finally {
    root.feed.dispose()
    root.dispose()
  }
})

test("canonical navigation updates the refresh scope without invalidating tickets or keeping old-SDK aliases", async () => {
  const value = taskQueue({ directory: "/remote/real" })
  const scopes: string[] = []
  let failing = false
  const fetch = createFetch((url) => {
    scopes.push(url.searchParams.get("directory")!)
    return failing ? new Response(null, { status: 503 }) : json({ data: [value] })
  }).fetch
  let client = OpenCode.make({ baseUrl: "http://fixture", fetch })
  const feed = createTaskQueueFeed(() => client.taskQueue)
  try {
    feed.directory("/remote/alias")
    await feed.load()
    const ticket = feed.capture()
    expect(feed.directory(value.directory)).toBe(false)
    expect(ticket()).toBe(true)
    await feed.load()
    expect(scopes.at(-1)).toBe(value.directory)
    expect(feed.sameDirectory("/remote/alias")).toBe(true)
    failing = true
    client = OpenCode.make({ baseUrl: "http://fixture", fetch })
    await feed.load()
    expect(ticket()).toBe(false)
    expect(feed.sameDirectory("/remote/alias")).toBe(false)
    expect(feed.sameDirectory(value.directory)).toBe(true)
    feed.update(value)
    expect(feed.items()).toEqual([value])
    const current = feed.capture()
    expect(feed.directory("/remote/different")).toBe(true)
    expect(current()).toBe(false)
  } finally {
    feed.dispose()
  }
})

test("a superseded reveal cancels automatic focus and navigation without changing execution data", () => {
  const root = createRoot((dispose) => {
      const value = taskQueue({ status: "running", currentTaskID: "tqt_one", tasks: [{ ...taskQueue().tasks[0], sessionID: "ses_first" }] })
      const api = OpenCode.make({ baseUrl: "http://fixture", fetch: createFetch(() => json({ data: [] })).fetch })
      const feed = createTaskQueueFeed(() => api.taskQueue)
      const navigations: string[] = []
      const display = createTaskQueueDisplay({ feed, route: () => "home", panel: () => undefined,
        navigate: (id) => navigations.push(id), open: () => { throw new Error("Must not steal a new editor's focus") }, close: () => {} })
      feed.directory(value.directory)
      display.prepare()(value, () => false)
      return { feed, display, value, navigations, dispose }
  })
  try {
    expect(root.navigations).toEqual([])
    expect(root.display.following()).toBe(false)
    expect(root.display.visible()).toBe(false)
    expect(root.feed.items()).toEqual([root.value])
  } finally {
    root.feed.dispose()
    root.dispose()
  }
})

// TC-010/011: identity learned by the previous SDK is not permission to accept
// canonical events after returning to the alias and refreshing credentials.
test("alias return refresh rejects unconfirmed canonical facts until the same SDK's scoped list recovers", async () => {
  const alias = "/remote/alias"
  const canonical = "/remote/canonical"
  const scopes: string[] = []
  let failing = false
  let value = taskQueue({ directory: canonical, status: "running", currentTaskID: "tqt_one",
    tasks: [{ ...taskQueue().tasks[0], status: "running", sessionID: "ses_initial" }] })
  const fetch = createFetch((url) => {
    scopes.push(url.searchParams.get("directory")!)
    return failing ? new Response(null, { status: 503 }) : json({ data: [value] })
  }).fetch
  let client = OpenCode.make({ baseUrl: "http://fixture", fetch })
  const root = createRoot((dispose) => {
    const [route, navigate] = createSignal("home")
    const panels = createPanelState()
    const feed = createTaskQueueFeed(() => client.taskQueue)
    const display = createTaskQueueDisplay({ feed, route, navigate, panel: panels.current,
      open: (sessionID) => panels.open({ plugin: "tasks", name: TASK_QUEUE_PANEL, sessionID }), close: () => panels.release("tasks") })
    return { feed, display, route, dispose }
  })
  try {
    root.feed.directory(alias)
    await root.feed.load()
    root.display.prepare()(value, () => {})
    const old = root.feed.capture()
    expect(root.feed.directory(canonical)).toBe(false)
    expect(root.feed.directory(alias)).toBe(false)
    expect(old()).toBe(true)
    failing = true
    client = OpenCode.make({ baseUrl: "http://fixture", fetch })
    await root.feed.load()
    expect(old()).toBe(false)
    expect(scopes.at(-1)).toBe(alias)
    expect(root.feed.sameDirectory(canonical)).toBe(false)
    expect(root.feed.items()).toEqual([])
    expect(root.feed.missing(value.id)).toBe(false)
    value = { ...value, tasks: [{ ...value.tasks[0], sessionID: "ses_recovered" }], time: { created: 1, updated: 4 } }
    root.feed.update(value)
    expect(root.feed.items()).toEqual([])
    expect(root.route()).toBe("ses_initial")
    expect(root.display.following()).toBe(true)
    expect(root.display.visible()).toBe(true)
    failing = false
    await root.feed.load()
    expect(scopes.at(-1)).toBe(alias)
    expect(root.feed.sameDirectory(canonical)).toBe(true)
    expect(root.feed.error()).toBeUndefined()
    expect(root.route()).toBe("ses_recovered")
    expect(root.display.following()).toBe(true)
    expect(root.feed.directory("/remote/elsewhere")).toBe(true)
    expect(root.feed.items()).toEqual([])
  } finally {
    root.feed.dispose()
    root.dispose()
  }
})
