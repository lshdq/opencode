import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { createAppFixture } from "../fixture/app"
import { taskQueue } from "../fixture/task-queue"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { takeDraft } from "../../src/component/prompt/draft-stash"

test.each(["success", "failure"] as const)("real reconnected task panel ignores an obsolete detail %s from the old endpoint", async (outcome) => {
  // TC-033: the panel stays mounted while an old GET finishes after the new
  // authenticated service has already supplied the current queue list.
  takeDraft(undefined)
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const connected = Promise.withResolvers<void>()
  const events = createEventStream()
  const previous = taskQueue({ directory, id: "tq_previous_endpoint", title: "Previous endpoint only" })
  const replacement = taskQueue({ directory, id: "tq_replacement_endpoint", title: "Replacement live queue" })
  const auth = { type: "basic", username: "fixture", password: "late-get-replacement-only" } as const
  const expected = "Basic " + Buffer.from(`${auth.username}:${auth.password}`).toString("base64")
  const rejected: string[] = []
  const oldRequests: string[] = []
  let migrating = false
  const calls = createFetch((url, request) => {
    if (request.headers.get("authorization") !== expected) {
      rejected.push(url.pathname)
      return new Response(null, { status: 401 })
    }
    if (url.pathname === "/api/plugin") connected.resolve()
    if (url.pathname === "/api/task-queue") return json({ data: [replacement] })
    if (url.pathname === `/api/task-queue/${replacement.id}`) {
      // This receipt exists only in the new HTTP detail response, not its list.
      return json({ data: { ...replacement, title: "Replacement detail receipt", time: { created: 1, updated: 2 } } })
    }
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  try {
    await using app = await createAppFixture({ width: 100, height: 30,
      config: { animations: false, tabs: { mode: "off" } },
      auth: { type: "basic", username: "fixture", password: "late-get-old-only" },
      service: { reconnect: async () => ({ url: server.url.toString(), auth }), restart: async () => {} },
      fetch: (url, request) => {
        if (!url.pathname.startsWith("/api/task-queue")) return undefined
        oldRequests.push(`${request.method} ${url.pathname}`)
        if (migrating) return new Response(null, { status: 503 })
        if (url.pathname === `/api/task-queue/${previous.id}`) {
          requested.resolve()
          return response.promise
        }
        return json({ data: [previous] })
      },
    })
    try {
      await app.ready
      await app.waitForFrame((frame) => frame.includes("commands"))
      await app.mockInput.typeText("/tasks")
      await app.waitForFrame((frame) => frame.includes("Task queues"))
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes(previous.title!) && app.renderer.currentFocusedEditor instanceof InputRenderable)
      app.mockInput.pressEnter()
      await requested.promise
      await app.waitForFrame((frame) => frame.includes(previous.title!) && frame.includes("rounds"))
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
      const oldCount = oldRequests.length
      migrating = true
      app.events.disconnect()
      await connected.promise
      await app.waitForFrame((frame) => frame.includes(replacement.title!) && app.renderer.currentFocusedEditor instanceof InputRenderable)
      response.resolve(outcome === "success" ? json({ data: previous }) : new Response(null, { status: 503 }))
      app.mockInput.pressEnter()
      await app.waitForFrame((frame) => frame.includes("Replacement detail receipt") && frame.includes("rounds"))
      app.mockInput.pressEscape()
      await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && frame.includes("Replacement detail receipt") && app.renderer.currentFocusedEditor instanceof InputRenderable)
      expect(oldRequests).toHaveLength(oldCount)
      expect(rejected).toEqual([])
      expect(app.captureCharFrame()).not.toContain(previous.title!)
      expect(app.captureCharFrame()).not.toContain("UnexpectedStatus: 503")
    } finally {
      // Release the private HTTP handler before the app fixture stops its server.
      response.resolve(json({ data: previous }))
    }
  } finally {
    events.disconnect()
    await server.stop(true)
  }
})
