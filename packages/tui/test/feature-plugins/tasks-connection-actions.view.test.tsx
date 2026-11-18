import { expect, test } from "bun:test"
import { InputRenderable, TextareaRenderable } from "@opentui/core"
import type { TaskQueueCreateInput } from "@opencode/client"
import { createAppFixture } from "../fixture/app"
import { taskQueue } from "../fixture/task-queue"
import { createEventStream, createFetch, directory, json, type FetchHandler } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"

test.each((["start", "resume", "stop", "delete", "create"] as const).flatMap((action) => [
  [`${action}/success`, action, true] as const, [`${action}/failure`, action, false] as const,
]))("obsolete %s cannot apply control data, errors or draft transitions to a replacement connection", async (_, action, success) => {
  takeDraft(undefined)
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const submitted = Promise.withResolvers<void>()
  const created = Promise.withResolvers<Response>()
  const old = taskQueue({ directory, title: "Obsolete operation", status: action === "resume" ? "stopped" : action === "stop" ? "running" : "queued" })
  const replacement = taskQueue({ directory, title: "Replacement control receipt" })
  const payloads: TaskQueueCreateInput[] = []
  await using app = await migration(async (url, request) => {
    const selected = action === "create" ? request.method === "POST" && url.pathname === "/api/task-queue"
      : action === "delete" ? request.method === "DELETE" : url.pathname.endsWith(`/${action}`)
    if (selected) { requested.resolve(); return response.promise }
    return json({ data: url.pathname === "/api/task-queue" ? [old] : old })
  }, async (url, request) => {
    if (url.pathname === "/api/task-queue" && request.method === "POST") {
      payloads.push(await request.json() as TaskQueueCreateInput)
      submitted.resolve()
      return created.promise
    }
    return json({ data: url.pathname === "/api/task-queue" ? [replacement] : replacement })
  })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app, old.title!)
    if (action === "create") {
      app.mockInput.pressKey("a", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("新建批次"))
      await addTask(app)
      app.mockInput.pressKey("r", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("创建前预览"))
      app.mockInput.pressKey("s", { ctrl: true })
    }
    if (action === "delete") {
      app.mockInput.pressKey("x", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("删除批次？"))
      app.mockInput.pressKey("x", { ctrl: true })
    }
    if (!["create", "delete"].includes(action)) {
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("rounds"))
      app.mockInput.pressKey(action === "resume" ? "e" : action === "stop" ? "x" : "s", { ctrl: true })
    }
    await requested.promise
    const oldCount = await app.migrate()
    await app.waitForFrame((frame) => frame.includes("连接已更换"))
    if (action === "create") {
      // The submitted A operation becomes obsolete, but its draft is not erased.
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("新建批次") && frame.includes("Preserved task"))
      app.mockInput.pressKey("r", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("创建前预览"))
      app.mockInput.pressKey("s", { ctrl: true })
      await submitted.promise
      await app.waitForFrame((frame) => frame.includes("创建中，暂不能修改"))
      response.resolve(success ? json({ data: { ...old, time: { created: 1, updated: 99 } } }) : new Response(null, { status: 503 }))
      await app.renderOnce()
      expect(app.captureCharFrame()).toContain("创建中，暂不能修改")
      expect(app.captureCharFrame()).toContain("Preserved task")
      expect(app.captureCharFrame()).not.toContain("UnexpectedStatus: 503")
      app.mockInput.pressKey("s", { ctrl: true })
      app.mockInput.pressKey("s", { ctrl: true })
      await app.renderOnce()
      expect(payloads).toHaveLength(1)
      expect(app.captureCharFrame()).toContain("创建中，暂不能修改")
      created.resolve(json({ data: { ...replacement, tasks: payloads[0].tasks.map((task) => ({ ...replacement.tasks[0], ...task })) } }))
      await app.waitForFrame((frame) => frame.includes(replacement.title!) && frame.includes("rounds"))
      expect(payloads.map((input) => input.tasks)).toEqual([[{ prompt: "Preserved task\n完整描述\n第二行" }]])
    }
    if (action !== "create") {
      // migrate() observes B's HTTP request, not its decoded list or mounted
      // detail controls. Escape must target those controls, not the root dialog
      // during the transient empty detail while B's list is still in flight.
      await app.waitForFrame((frame) => frame.includes(replacement.title!) && frame.includes(action === "delete" ? "删除批次？" : "rounds"))
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && frame.includes(replacement.title!) && app.renderer.currentFocusedEditor instanceof InputRenderable)
      response.resolve(success ? action === "delete" ? new Response(null, { status: 204 }) : json({ data: { ...old, status: "running", time: { created: 1, updated: 99 } } }) : new Response(null, { status: 503 }))
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes(replacement.title!) && frame.includes("rounds"))
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && frame.includes(replacement.title!))
      expect(app.captureCharFrame()).not.toContain(old.title!)
      expect(app.captureCharFrame()).not.toContain("UnexpectedStatus: 503")
    }
    expect(app.oldRequests).toHaveLength(oldCount)
    expect(app.rejected).toEqual([])
  } finally {
    response.resolve(action === "delete" ? new Response(null, { status: 204 }) : json({ data: old }))
    created.resolve(json({ data: replacement }))
  }
})

test.each(["editor", "draft"] as const)("a new SDK preserves same-directory unsubmitted %s content without replaying it", async (view) => {
  takeDraft(undefined)
  const info = taskQueue({ directory })
  const payloads: TaskQueueCreateInput[] = []
  let oldPosts = 0
  await using app = await migration((_url, request) => {
    if (request.method === "POST") oldPosts++
    return json({ data: [info] })
  }, async (url, request) => {
    if (request.method === "POST") {
      const payload = await request.json() as TaskQueueCreateInput
      payloads.push(payload)
      return json({ data: { ...info, title: "Draft submitted to B", tasks: payload.tasks.map((task) => ({ ...info.tasks[0], ...task })) } })
    }
    return json({ data: url.pathname === "/api/task-queue" ? [info] : { ...info, title: "Draft submitted to B" } })
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await openTasks(app, info.title!)
  app.mockInput.pressKey("a", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("新建批次"))
  await addTask(app, view === "draft")
  const oldCount = await app.migrate()
  await app.renderOnce()
  expect(app.captureCharFrame()).toContain(view === "editor" ? "添加任务" : "新建批次")
  expect(app.captureCharFrame()).toContain("Preserved task")
  expect(payloads).toEqual([])
  expect(oldPosts).toBe(0)
  if (view === "editor") {
    expect(app.renderer.currentFocusedEditor instanceof TextareaRenderable).toBe(true)
    expect((app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe("Preserved task\n完整描述\n第二行")
    app.mockInput.pressKey("s", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("新建批次") && frame.includes("Preserved task"))
  }
  app.mockInput.pressKey("r", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("创建前预览"))
  app.mockInput.pressKey("s", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("Draft submitted to B") && frame.includes("rounds"))
  expect(payloads.map((input) => input.tasks)).toEqual([[{ prompt: "Preserved task\n完整描述\n第二行" }]])
  expect(app.oldRequests).toHaveLength(oldCount)
  expect(app.rejected).toEqual([])
})

test.each(["start", "resume", "stop", "delete", "create"] as const)("a current %s failure stays visible, releases busy for retry, and the new ticket blocks duplicate submissions", async (action) => {
  takeDraft(undefined)
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const info = taskQueue({ directory, title: "Current failure control", status: action === "resume" ? "stopped" : action === "stop" ? "running" : "queued" })
  let attempts = 0
  let removed = false
  let current = info
  await using app = await createAppFixture({ width: 100, height: 30, config: { animations: false, tabs: { mode: "off" } }, fetch: (url, request) => {
    if (!url.pathname.startsWith("/api/task-queue")) return undefined
    const selected = action === "create" ? request.method === "POST" && url.pathname === "/api/task-queue"
      : action === "delete" ? request.method === "DELETE" : url.pathname.endsWith(`/${action}`)
    if (selected) {
      if (++attempts === 1) return json({ _tag: "ForbiddenError", message: "current operation refused" }, { status: 403 })
      requested.resolve()
      return response.promise
    }
    return json({ data: url.pathname === "/api/task-queue" ? removed ? [] : [current] : current })
  } })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await openTasks(app, info.title!)
    if (action === "create") {
      app.mockInput.pressKey("a", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("新建批次"))
      await addTask(app)
      app.mockInput.pressKey("r", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("创建前预览"))
    }
    if (action === "delete") {
      app.mockInput.pressKey("x", { ctrl: true })
      await app.waitForFrame((frame) => frame.includes("删除批次？"))
    }
    if (!["create", "delete"].includes(action)) {
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("rounds"))
    }
    const key = action === "resume" ? "e" : ["stop", "delete"].includes(action) ? "x" : "s"
    app.mockInput.pressKey(key, { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("检查访问权限"))
    expect(attempts).toBe(1)
    app.mockInput.pressKey(key, { ctrl: true })
    await requested.promise
    await app.waitForFrame((frame) => frame.includes(action === "create" ? "创建中，暂不能修改" : action === "delete" ? "删除批次？" : "正在处理"))
    app.mockInput.pressKey(key, { ctrl: true })
    app.mockInput.pressKey(key, { ctrl: true })
    await app.renderOnce()
    expect(attempts).toBe(2)
    expect(app.captureCharFrame()).not.toContain("检查访问权限")
    removed = action === "delete"
    current = { ...info, status: ["start", "resume"].includes(action) ? "running" : action === "stop" ? "stopped" : "queued", time: { created: 1, updated: 2 } }
    response.resolve(action === "delete" ? new Response(null, { status: 204 }) : json({ data: current }))
    await app.waitForFrame((frame) => action === "delete" ? frame.includes("暂无批次") : frame.includes("rounds") && !frame.includes("正在处理"))
    expect(attempts).toBe(2)
    expect(app.captureCharFrame()).not.toContain("检查访问权限")
  } finally {
    response.resolve(action === "delete" ? new Response(null, { status: 204 }) : json({ data: current }))
  }
})

async function migration(previous: FetchHandler, replacement: FetchHandler) {
  const plugin = Promise.withResolvers<void>()
  const listed = Promise.withResolvers<void>()
  const events = createEventStream()
  const rejected: string[] = []
  const oldRequests: string[] = []
  const auth = { type: "basic", username: "fixture", password: "connection-epoch-only" } as const
  const expected = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  const calls = createFetch((url, request) => {
    if (request.headers.get("authorization") !== expected) { rejected.push(url.pathname); return new Response(null, { status: 401 }) }
    if (url.pathname === "/api/plugin") plugin.resolve()
    if (!url.pathname.startsWith("/api/task-queue")) return undefined
    if (url.pathname === "/api/task-queue" && request.method === "GET") listed.resolve()
    return replacement(url, request)
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  let migrated = false
  const app = await createAppFixture({ width: 100, height: 30, config: { animations: false, tabs: { mode: "off" } },
    service: { reconnect: async () => ({ url: server.url.toString(), auth }), restart: async () => {} },
    fetch: (url, request) => {
      if (!url.pathname.startsWith("/api/task-queue")) return undefined
      oldRequests.push(`${request.method} ${url.pathname}`)
      return migrated ? new Response(null, { status: 503 }) : previous(url, request)
    },
  }).catch(async (cause) => { events.disconnect(); await server.stop(true); throw cause })
  return {
    ...app, oldRequests, rejected,
    async migrate() {
      const count = oldRequests.length
      migrated = true
      app.events.disconnect()
      await Promise.all([plugin.promise, listed.promise])
      return count
    },
    async [Symbol.asyncDispose]() {
      try { await app[Symbol.asyncDispose]() } finally { events.disconnect(); await server.stop(true) }
    },
  }
}

async function openTasks(app: Awaited<ReturnType<typeof createAppFixture>>, title: string) {
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes(title) && app.renderer.currentFocusedEditor instanceof InputRenderable)
}

async function addTask(app: Awaited<ReturnType<typeof createAppFixture>>, save = true) {
  app.mockInput.pressKey("a", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("添加任务") && app.renderer.currentFocusedEditor?.id === "task-queue-prompt")
  await app.mockInput.pasteBracketedText("Preserved task\n完整描述\n第二行")
  if (!save) return
  app.mockInput.pressKey("s", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("新建批次") && frame.includes("Preserved task"))
}
