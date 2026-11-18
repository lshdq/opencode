import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "../fixture/app"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { taskQueue } from "../fixture/task-queue"
import { takeDraft } from "../../src/component/prompt/draft-stash"

test.each((["start", "resume"] as const).flatMap((action) => (["A-first", "B-first"] as const).map((order) => [`${action}/${order}`, action, order] as const)))("real app explicit replacement %s reaches B before A completes and survives full disposal", async (_, action, order) => {
  const app = await setup(action, true, false)
  let sentBeforeA = false
  let finalFrame = ""
  try {
    await startA(app, action)
    await app.migrate()
    app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("正在处理"))
    sentBeforeA = await received(app.bRequested.promise)
    if (order === "B-first") {
      app.completeB()
      if (sentBeforeA) await app.waitForFrame((frame) => frame.includes("B current result") && frame.includes("执行中") && !frame.includes("正在处理"))
      app.completeA()
    }
    if (order === "A-first") {
      app.completeA()
      await app.renderOnce()
      app.completeB()
    }
    await app.waitForFrame((frame) => frame.includes("执行中") && !frame.includes("正在处理"))
    finalFrame = app.captureCharFrame()
  } finally {
    app.completeA(); app.completeB()
    await app[Symbol.asyncDispose]()
  }
  // These assertions deliberately run after the actual Tui.run async finalizer.
  expect({ sentBeforeA, a: app.aControls, b: app.bControls }).toEqual({ sentBeforeA: true, a: [action, "stop"], b: [action, "stop"] })
  expect(finalFrame).toContain("B current result")
  expect(finalFrame).not.toContain("A obsolete result")
  expect(app.aControls).toEqual([action, "stop"])
  expect(app.bControls).toEqual([action, "stop"])
  expect(app.rejected).toEqual([])
})

test.each((["start", "resume"] as const).flatMap((action) => (["late", "owned"] as const).map((mode) => [`${action}/${mode}`, action, mode] as const)))("real app %s A cleanup never stops the independently running authenticated B", async (_, action, mode) => {
  const app = await setup(action, mode === "late", true)
  try {
    await startA(app, action)
    await app.migrate()
    app.publishB("done", 150)
    app.publishB("running", 151)
    await app.waitForFrame((frame) => frame.includes("B observed result") && frame.includes("执行中"))
    const closing = app[Symbol.asyncDispose]()
    app.completeA()
    await closing
  } finally {
    app.completeA(); app.completeB()
    await app[Symbol.asyncDispose]()
  }
  expect({ a: app.aControls, b: app.bControls, statusB: app.bStatus() }).toEqual({ a: [action, "stop"], b: [], statusB: "running" })
  expect(app.rejected).toEqual([])
})

test.each(["start", "resume"] as const)("real app same URL credential refresh retains its %s owner's exit responsibility", async (action) => {
  const app = await setup(action, false, true)
  try {
    await startA(app, action)
    await app.migrate(true)
  } finally {
    app.completeA(); app.completeB()
    await app[Symbol.asyncDispose]()
  }
  expect(app.aControls).toEqual([action])
  expect(app.bControls).toEqual(["stop"])
  expect(app.bStatus()).toBe("stopped")
  expect(app.rejected).toEqual([])
})

async function setup(action: "start" | "resume", pendingA: boolean, otherB: boolean) {
  takeDraft(undefined)
  const aRequested = Promise.withResolvers<void>()
  const bRequested = Promise.withResolvers<void>()
  const aReply = Promise.withResolvers<Response>()
  const bReply = Promise.withResolvers<Response>()
  const plugin = Promise.withResolvers<void>()
  const events = createEventStream()
  const aControls: string[] = []
  const bControls: string[] = []
  const rejected: string[] = []
  const before = { type: "basic", username: "fixture", password: "origin-A-only" } as const
  const after = { type: "basic", username: "fixture", password: "origin-B-only" } as const
  const authorization = (password: string) => "Basic " + Buffer.from(`fixture:${password}`).toString("base64")
  let aURL = ""
  let same = false
  let infoA = taskQueue({ directory, title: "A obsolete result", status: action === "start" ? "queued" : "stopped" })
  let infoB = taskQueue({ directory, title: "B current result", status: otherB ? "running" : action === "start" ? "queued" : "stopped" })
  const replacement = createFetch((url, request) => {
    if (request.headers.get("authorization") !== authorization(after.password)) { rejected.push(`new:${url.pathname}`); return new Response(null, { status: 401 }) }
    if (url.pathname === "/api/plugin") plugin.resolve()
    if (!url.pathname.startsWith("/api/task-queue")) return undefined
    const method = url.pathname.split("/").at(-1)!
    if (["start", "resume", "stop", "heartbeat"].includes(method)) bControls.push(method)
    if (method === "start" || method === "resume") { bRequested.resolve(); return bReply.promise }
    if (method === "stop") infoB = { ...infoB, status: "stopped" }
    return json({ data: url.pathname === "/api/task-queue" ? [infoB] : infoB })
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => replacement.fetch(request) })
  const app = await createAppFixture({ width: 100, height: 30, config: { animations: false, tabs: { mode: "off" } }, auth: before,
    service: { reconnect: async () => ({ url: same ? aURL : server.url.toString(), auth: after }), restart: async () => {} },
    fetch: (url, request) => {
      aURL = url.origin
      if (same) return replacement.fetch(request)
      if (request.headers.get("authorization") !== authorization(before.password)) { rejected.push(`old:${url.pathname}`); return new Response(null, { status: 401 }) }
      if (!url.pathname.startsWith("/api/task-queue")) return undefined
      const method = url.pathname.split("/").at(-1)!
      if (["start", "resume", "stop", "heartbeat"].includes(method)) aControls.push(method)
      if (method === "start" || method === "resume") {
        aRequested.resolve()
        if (pendingA) return aReply.promise
        infoA = { ...infoA, status: "running", time: { created: 1, updated: 99 } }
      }
      if (method === "stop") infoA = { ...infoA, status: "stopped" }
      return json({ data: url.pathname === "/api/task-queue" ? [infoA] : infoA })
    },
  }).catch(async (cause) => { events.disconnect(); await server.stop(true); throw cause })
  let closed: Promise<void> | undefined
  let completedA = false
  let completedB = false
  return {
    ...app, aRequested, bRequested, aControls, bControls, rejected, pendingA, bStatus: () => infoB.status,
    publishB(status: "done" | "running", updated: number) {
      infoB = { ...infoB, title: "B observed result", status, time: { created: 1, updated } }
      events.emit({ id: `evt_B_${updated}`, created: updated, type: "taskqueue.updated", data: infoB })
    },
    completeA() {
      if (completedA) return
      completedA = true
      aReply.resolve(json({ data: { ...infoA, status: "running", time: { created: 1, updated: 99 } } }))
    },
    completeB() {
      if (completedB) return
      completedB = true
      if (bControls.includes(action)) infoB = { ...infoB, status: "running", time: { created: 1, updated: 2 } }
      bReply.resolve(json({ data: infoB }))
    },
    async migrate(sameURL = false) {
      same = sameURL
      app.events.disconnect()
      await plugin.promise
      await app.waitForFrame((frame) => frame.includes(infoB.title!) && frame.includes("rounds") && !frame.includes("正在处理"))
    },
    [Symbol.asyncDispose]() {
      return closed ??= (async () => {
        try { await app[Symbol.asyncDispose]() } finally { events.disconnect(); await server.stop(true) }
      })()
    },
  }
}

async function startA(app: Awaited<ReturnType<typeof setup>>, action: "start" | "resume") {
  await app.ready
  await app.waitForFrame((frame) => frame.includes("commands"))
  await app.mockInput.typeText("/tasks")
  await app.waitForFrame((frame) => frame.includes("Task queues"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("A obsolete result") && frame.includes(action === "start" ? "待开始" : "已停止") && app.renderer.currentFocusedEditor instanceof InputRenderable && !app.renderer.currentFocusedEditor.isDestroyed)
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("rounds"))
  app.mockInput.pressKey(action === "start" ? "s" : "e", { ctrl: true })
  await app.aRequested.promise
  await app.waitForFrame((frame) => frame.includes(app.pendingA ? "正在处理" : "执行中"))
}

function received(promise: Promise<void>) {
  // A missing B request must fail the red test in a bounded time, not leave its
  // HTTP handlers alive after Bun's 30-second test timeout.
  return new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => resolve(false), 2_000)
    void promise.then(() => { clearTimeout(deadline); resolve(true) })
  })
}
