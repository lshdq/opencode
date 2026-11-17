import { expect, test } from "bun:test"
import { InputRenderable } from "@opentui/core"
import { takeDraft } from "../../src/component/prompt/draft-stash"
import { createAppFixture } from "../fixture/app"
import { sourceSignal, taskQueueSource } from "../fixture/task-queue-source"

test("real tasks keyboard keeps A's stop and session target after buffered B terminal and a successful A refresh", async () => {
  takeDraft(undefined)
  // Credential revocation is exercised by the provider/feed tests. Here keep
  // A's credential valid for unrelated activation-owned plugin clients too.
  const wire = taskQueueSource("foreign", false)
  const b = Bun.serve({ port: 0, fetch: (request) => wire.b(request) })
  let aURL = ""
  const app = await createAppFixture({ width: 100, height: 30, config: { animations: false, tabs: { mode: "on", layout: "horizontal" } }, auth: wire.auth("A1"),
    fetch(url, request) { aURL = url.origin; return wire.a(request) },
    service: { reconnect: async () => wire.reconnect(aURL, b.url.toString()), restart: async () => {} },
  }).catch(async (cause) => { wire.dispose(); await b.stop(true); throw cause })
  let detail = ""
  let navigation = ""
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.mockInput.typeText("/tasks")
    await app.waitForFrame((frame) => frame.includes("Task queues"))
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("A actual running") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("rounds"))
    app.mockInput.pressKey("s", { ctrl: true })
    await sourceSignal(wire.started)
    await app.waitForFrame((frame) => frame.includes("执行中") && !frame.includes("正在处理"))
    wire.migrate()
    // This is a real request signal through the production 1s retry backoff,
    // not a frame budget pretending to be a connection clock.
    await sourceSignal(wire.opened)
    await app.waitForFrame((frame) => (frame.includes("A actual running") || frame.includes("B foreign terminal")) &&
      (frame.includes("rounds") || (frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)))
    // The existing connection epoch may legitimately return detail to the list.
    // Escape only a mounted detail, rather than accidentally closing that list.
    if (app.captureCharFrame().includes("rounds")) app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("任务队列 / tasks") && app.renderer.currentFocusedEditor instanceof InputRenderable)
    wire.refreshReceipt()
    const refreshed = wire.nextList()
    app.mockInput.pressKey("r", { ctrl: true })
    await sourceSignal(refreshed)
    // Wait for the response to be applied, not just its request to arrive.
    await app.waitForFrame((frame) => frame.includes("A explicit refresh receipt") && app.renderer.currentFocusedEditor instanceof InputRenderable && !app.renderer.currentFocusedEditor.isDestroyed)
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("rounds"))
    detail = app.captureCharFrame()
    expect(detail).toContain("A explicit refresh receipt")
    expect(detail).toContain("执行中")
    expect(detail).toContain("停止")
    expect(detail).toContain("ses_A")
    expect(detail).not.toContain("ses_B")
    app.mockInput.pressKey("x", { ctrl: true })
    await sourceSignal(wire.stopped)
    await app.waitForFrame((frame) => frame.includes("已停止") && frame.includes("A actual stopped"))
    app.mockInput.pressEnter()
    await sourceSignal(wire.navigated)
    await app.waitForFrame((frame) => frame.includes("Correct A session") && !frame.includes("A actual stopped"))
    navigation = app.captureCharFrame()
  } finally {
    await app[Symbol.asyncDispose]()
    wire.dispose()
    await b.stop(true)
    console.info("R2A16 UI cleanup evidence", JSON.stringify({ controls: wire.controls, sessions: wire.sessions, rejected: wire.rejected }))
  }
  console.info("R2A16 real UI after asyncDispose", JSON.stringify({ controls: wire.controls, versions: wire.versions, sessions: wire.sessions, rejected: wire.rejected }))
  expect(navigation).toContain("Correct A session")
  expect({ controls: wire.controls, versions: wire.versions, sessions: wire.sessions, rejected: wire.rejected }).toEqual({ controls: { A: ["start", "stop"], B: [] }, versions: [1, 1], sessions: ["A:ses_A"], rejected: [] })
})
