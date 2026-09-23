import { expect, test } from "bun:test"
import path from "node:path"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { Config } from "../src/config"
import { takeDraft } from "../src/component/prompt/draft-stash"
import type { PackageSource } from "../src/plugin/context"
import { tmpdir } from "./fixture/fixture"
import { createEventStream, createFetch, directory, json, type FetchHandler } from "./fixture/tui-client"

// Exercise run(), not a copy of the provider tree. Both the server and every
// Global directory are test-owned; no installed service or daily config is read.
async function fixture(root: string, input: { config?: Config.Info; configPath?: string; session?: boolean; fetch?: FetchHandler; packages?: PackageSource } = {}) {
  takeDraft(undefined)
  takeDraft("ses_stability")
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const events = createEventStream()
  const session = {
    id: "ses_stability", title: "Stability session", projectID: "proj_test", location: { directory },
    agent: "build", model: { providerID: "provider", id: "model" },
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const calls = createFetch(async (url, request) => {
    const response = await input.fetch?.(url, request)
    if (response) return response
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname.startsWith(`/api/session/${session.id}/`)) return json({ data: [], cursor: {} })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(run({
    app: { name: "test", version: "test", channel: "test" },
    server: { endpoint: { url: server.url.toString() } },
    config: {
      path: input.configPath,
      get: async () => ({ animations: false, tabs: { mode: "off" }, ...input.config,
        ...(input.configPath ? await Bun.file(input.configPath).json() : {}),
      }),
      update: async () => ({}),
    },
    packages: input.packages ?? { prepare: async () => { throw new Error("Unexpected package install") } },
    terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
    args: input.session ? { sessionID: session.id } : {},
  }).pipe(
    Effect.provide(Global.layerWith(Object.fromEntries(
      ["home", "data", "cache", "config", "state", "tmp", "bin", "log", "repos"].map((key) => [key, path.join(root, key)]),
    ))),
    Effect.provide(FileSystem.layerNoop({})),
  ))
  return {
    ...setup, task, events,
    async [Symbol.asyncDispose]() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task
      await server.stop(true)
    },
  }
}

test.each([[false, false], [true, false], [false, true], [true, true]])("pending plugin leaves composer editable (session: %s, exit before setup: %s)", async (session, exitBeforeSetup) => {
  await using root = await tmpdir()
  const gate = Promise.withResolvers<Response>()
  let started = false
  let cleaned = 0
  let lateCommands: string[] | undefined
  let lateInvocations: string[] | undefined
  const bridge = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/gate") { started = true; return gate.promise }
    if (url.pathname === "/cleanup") cleaned++
    if (url.pathname === "/late") {
      lateCommands = JSON.parse(url.searchParams.get("commands")!)
      lateInvocations = JSON.parse(url.searchParams.get("invoked")!)
    }
    return new Response("ok")
  } })
  const plugin = path.join(root.path, "plugin")
  await Bun.write(path.join(plugin, "tui.tsx"), `export default {
    id: "test.pending",
    async setup(ctx) {
      const invoked = []
      ctx.keymap.layer(() => ({ commands: [{ id: "test.early", title: "Early", run() { invoked.push("early") } }] }))
      ctx.data.on("session.renamed", () => {})
      await fetch(${JSON.stringify(new URL("gate", bridge.url).href)})
      ctx.ui.router.register({ name: "late", render: () => <text>LATE_PLUGIN</text> })
      ctx.ui.slot({ append: "app", render: () => <text>LATE_PLUGIN</text> })
      ctx.keymap.layer(() => ({ commands: [{ id: "test.late", title: "Late", run() { invoked.push("late") } }] }))
      ctx.data.listen(() => {})
      ctx.keymap.dispatch("test.early")
      ctx.keymap.dispatch("test.late")
      await fetch(${JSON.stringify(new URL("late", bridge.url).href)} + "?invoked=" + encodeURIComponent(JSON.stringify(invoked)) + "&commands=" + encodeURIComponent(JSON.stringify(ctx.keymap.commands().filter(command => command.id.startsWith("test.")).map(command => command.id))))
      return async () => { await fetch(${JSON.stringify(new URL("cleanup", bridge.url).href)}) }
    }
  }`)
  try {
    await using app = await fixture(root.path, { session, config: { plugins: [plugin] } })
    await app.waitFor(() => started)
    await app.mockInput.typeText("DRAFT_WHILE_PLUGIN_PENDING")
    await app.waitForFrame((frame) => frame.includes("DRAFT_WHILE_PLUGIN_PENDING"))
    if (exitBeforeSetup) {
      app.renderer.destroy()
      await Promise.race([app.task, Bun.sleep(1000).then(() => { throw new Error("Exit waited for plugin setup") })])
    }
    gate.resolve(new Response("released"))
    if (!exitBeforeSetup) {
      await app.waitForFrame((frame) => frame.includes("LATE_PLUGIN") && frame.includes("DRAFT_WHILE_PLUGIN_PENDING"))
      app.renderer.destroy()
      await app.task
    }
    // Renderer waitFor stops pumping once destroyed; late cleanup is host work.
    for (let attempt = 0; attempt < 200 && cleaned === 0; attempt++) await Bun.sleep(10)
    expect(cleaned).toBe(1)
    // Disposed Solid memos can retain the last visible palette snapshot. Actual
    // dispatch must be inert, and the late registration must not be published.
    expect(lateInvocations).toEqual(exitBeforeSetup ? [] : ["early", "late"])
    if (exitBeforeSetup) expect(lateCommands).not.toContain("test.late")
    else expect(lateCommands?.sort()).toEqual(["test.early", "test.late"])
  } finally {
    gate.resolve(new Response("released"))
    await bridge.stop(true)
  }
})

test("launch directory discovery is background work, not a first-frame barrier", async () => {
  await using root = await tmpdir()
  const gate = Promise.withResolvers<Response>()
  try {
    await using app = await fixture(root.path, { fetch: (url) => url.pathname === "/api/fs/list" ? gate.promise : undefined })
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.mockInput.typeText("DIRECTORY_PENDING_DRAFT")
    await app.waitForFrame((frame) => frame.includes("DIRECTORY_PENDING_DRAFT"))
    app.renderer.destroy()
    await Promise.race([app.task, Bun.sleep(1000).then(() => { throw new Error("Exit waited for location") })])
  } finally {
    gate.resolve(json({ location: { directory }, data: [] }))
  }
})

test("pending package preparation neither blocks Home nor holds exit open", async () => {
  await using root = await tmpdir()
  const gate = Promise.withResolvers<{ directory: string }>()
  let started = false
  await using app = await fixture(root.path, {
    config: { plugins: ["fixture-package"] },
    packages: { prepare: () => { started = true; return gate.promise } },
  })
  try {
    await app.waitFor(() => started)
    await app.mockInput.typeText("INSTALL_PENDING")
    await app.waitForFrame((frame) => frame.includes("INSTALL_PENDING"))
    app.renderer.destroy()
    await Promise.race([app.task, Bun.sleep(1000).then(() => { throw new Error("Exit waited for package install") })])
  } finally {
    gate.resolve({ directory: root.path })
  }
})

test("early repeated Enter preserves the draft without scheduling a late send", async () => {
  await using root = await tmpdir()
  const model = Promise.withResolvers<Response>()
  const location = { directory, project: { id: "proj_test", directory } }
  let sends = 0
  await using app = await fixture(root.path, {
    session: true,
    fetch: (url) => {
      if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model") return model.promise
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname.endsWith("/prompt")) { sends++; return json({ data: {} }) }
      return undefined
    },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("commands"))
    await app.mockInput.typeText("EARLY_DRAFT")
    app.mockInput.pressEnter()
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("EARLY_DRAFT"))
    expect(sends).toBe(0)
    model.resolve(json({ location, data: [{ id: "model", providerID: "provider", name: "Ready model", variants: [] }] }))
    await app.waitForFrame((frame) => frame.includes("Ready model"))
    expect(sends).toBe(0)
    expect(app.captureCharFrame()).toContain("EARLY_DRAFT")
  } finally {
    model.resolve(json({ location, data: [] }))
  }
})

// TC-005: model readiness is not enough to classify a slash command. A slow
// command catalog must not turn a server command into an ordinary LLM prompt.
test.each([false, true])("early Enter never misroutes a server command (pending command catalog: %s)", async (pending) => {
  await using root = await tmpdir()
  const catalog = Promise.withResolvers<Response>()
  const location = { directory, project: { id: "proj_test", directory } }
  const sends: string[] = []
  const ready = { location, data: [{ name: "review", description: "Review fixture" }] }
  if (!pending) catalog.resolve(json(ready))
  await using app = await fixture(root.path, {
    session: true,
    fetch: (url, request) => {
      if (url.pathname === "/api/agent") return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model") return json({ location, data: [{ id: "model", providerID: "provider", name: "Ready model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/command") return catalog.promise
      if (request.method === "POST" && url.pathname.endsWith("/model")) return new Response(null, { status: 204 })
      if (request.method === "POST" && /\/(prompt|command)$/.test(url.pathname)) {
        sends.push(url.pathname.split("/").at(-1)!)
        return json({ data: {} })
      }
    },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Ready model"))
    await app.mockInput.typeText("/review captured")
    app.mockInput.pressEscape()
    await app.renderOnce()
    app.mockInput.pressEnter()
    // Flush the native Enter double-defer, not only the text renderer.
    await app.renderOnce()
    await app.renderOnce()
    await app.renderOnce()
    await Bun.sleep(120)
    if (!pending) {
      await app.waitForFrame(() => sends.length > 0)
      expect(sends).toEqual(["command"])
      return
    }
    expect(sends).toEqual([])
    expect(app.captureCharFrame()).toContain("/review captured")
    catalog.resolve(json(ready))
    await Bun.sleep(120)
    expect(sends).toEqual([])
    app.mockInput.pressEscape()
    await app.renderOnce()
    app.mockInput.pressEnter()
    await app.waitForFrame(() => sends.length > 0)
    expect(sends).toEqual(["command"])
  } finally {
    catalog.resolve(json({ location, data: [] }))
  }
})

test.each(["model", "provider", "mcp", "skill", "config"])("HTTP %s failure does not replace the Session composer and the Retry action recovers", async (resource) => {
  await using root = await tmpdir()
  let failed = true
  let attempts = 0
  await using app = await fixture(root.path, {
    session: true,
    fetch: (url) => {
      if (url.pathname !== `/api/${resource}`) return
      attempts++
      if (failed) return new Response("fixture failure", { status: 503 })
    },
  })
  await app.waitForFrame((frame) => frame.includes("Location resources unavailable"))
  await app.mockInput.typeText("RESOURCE_FAILURE_DRAFT")
  const frame = await app.waitForFrame((frame) => frame.includes("RESOURCE_FAILURE_DRAFT"))
  expect(frame).not.toContain("Location missing")
  const count = attempts
  failed = false
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes("Retry"))
  expect(row).toBeGreaterThanOrEqual(0)
  await app.mockMouse.click(lines[row].indexOf("Retry") + 1, row)
  await app.waitFor(() => attempts > count)
  await app.mockInput.typeText("_AFTER_RETRY")
  const recovered = await app.waitForFrame((frame) => frame.includes("RESOURCE_FAILURE_DRAFT_AFTER_RETRY"))
  expect(recovered).not.toContain("Location missing")
})

test("a failing hot reload restores last-good slots and does not duplicate owned commands", async () => {
  await using root = await tmpdir()
  let commands = 0
  let cleanups = 0
  const bridge = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/command") commands++
    if (new URL(request.url).pathname === "/cleanup") cleanups++
    return new Response("ok")
  } })
  const plugin = path.join(root.path, "plugin")
  const source = (version: string, fail = false) => `export default { id: "test.reload", setup(ctx) {
    ctx.ui.slot({ append: "home.footer", render: () => <text>${version}</text> })
    ctx.keymap.layer(() => ({ mode: "global", commands: [{ id: "test.command", title: "Test", bind: "f8", run() { void fetch(${JSON.stringify(new URL("command", bridge.url).href)}) } }] }))
    ${fail ? 'throw new Error("fixture setup failure")' : `return async () => { await fetch(${JSON.stringify(new URL("cleanup", bridge.url).href)}) }`}
  } }`
  await Bun.write(path.join(plugin, "tui.tsx"), source("LAST_GOOD_PLUGIN"))
  try {
    await using app = await fixture(root.path, { config: { plugins: [plugin] } })
    await app.waitForFrame((frame) => frame.includes("LAST_GOOD_PLUGIN"))
    await app.mockInput.typeText("RELOAD_DRAFT")
    await Bun.write(path.join(plugin, "tui.tsx"), source("BROKEN_PLUGIN", true))
    await app.waitFor(() => cleanups >= 1)
    await app.waitForFrame((frame) => frame.includes("Plugin failed:") && frame.includes("LAST_GOOD_PLUGIN"))
    expect(app.captureCharFrame()).toContain("RELOAD_DRAFT")
    expect(app.captureCharFrame()).not.toContain("BROKEN_PLUGIN")
    app.mockInput.pressKey("F8")
    await app.waitFor(() => commands === 1)
    await Bun.sleep(30)
    expect(commands).toBe(1)
    await Bun.write(path.join(plugin, "tui.tsx"), source("RECOVERED_PLUGIN"))
    await app.waitForFrame((frame) => frame.includes("RECOVERED_PLUGIN") && !frame.includes("LAST_GOOD_PLUGIN"))
    expect(app.captureCharFrame()).toContain("RELOAD_DRAFT")
  } finally {
    await bridge.stop(true)
  }
})

// TC-001/002: change membership AND order in a single config generation while
// an existing plugin fails setup. Observe real slots/commands/subscriptions,
// rather than asserting the host's internal fallback map mirrors its code.
test.each(["reorder", "remove"] as const)("multi-plugin structural %s preserves last-good ownership and order", async (change) => {
  await using root = await tmpdir()
  const commands: string[] = []
  const notifications: string[] = []
  const bridge = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/command") commands.push(url.searchParams.get("id")!)
    if (url.pathname === "/event") notifications.push(url.searchParams.get("id")!)
    return new Response("ok")
  } })
  const plugins = ["A", "B", "C"].map((id) => path.join(root.path, id))
  const configPath = path.join(root.path, "cli.json")
  for (const [index, id] of ["A", "B", "C"].entries()) {
    await Bun.write(path.join(plugins[index], "tui.tsx"), `export default { id: "test.${id}", setup(ctx) {
      const label = ctx.options.fail ? "BROKEN_${id}" : "GOOD_${id}"
      ctx.ui.slot({ append: "home.footer", render: () => <text>{label}</text> })
      ctx.keymap.layer(() => ({ mode: "global", commands: [{ id: "test.command.${id}", title: "${id}", bind: "f${6 + index}", run() { void fetch(${JSON.stringify(new URL(`command?id=${id}`, bridge.url).href)}) } }] }))
      ctx.data.on("session.renamed", () => { void fetch(${JSON.stringify(new URL(`event?id=${id}`, bridge.url).href)}) })
      if (ctx.options.fail) throw new Error("structural setup failure")
    } }`)
  }
  await Bun.write(configPath, JSON.stringify({ plugins: plugins.slice(0, 2) }))
  try {
    await using app = await fixture(root.path, { configPath })
    await app.waitForFrame((frame) => frame.includes("GOOD_A") && frame.includes("GOOD_B"))
    await app.mockInput.typeText("STRUCTURAL_DRAFT")
    const failing = { package: plugins[0], options: { fail: true } }
    await Bun.write(configPath, JSON.stringify({ plugins: change === "reorder" ? [plugins[1], failing, plugins[2]] : [failing, plugins[2]] }))
    const frame = await app.waitForFrame((frame) => frame.includes("Plugin failed:") && frame.includes("GOOD_C") && frame.includes("GOOD_A"))
    expect(frame).toContain("STRUCTURAL_DRAFT")
    expect(frame).not.toContain("BROKEN_A")
    expect(frame.indexOf("GOOD_A")).toBeLessThan(frame.indexOf("GOOD_C"))
    if (change === "reorder") expect(frame.indexOf("GOOD_B")).toBeLessThan(frame.indexOf("GOOD_A"))
    else expect(frame).not.toContain("GOOD_B")
    app.mockInput.pressKey("F6")
    app.mockInput.pressKey("F7")
    app.mockInput.pressKey("F8")
    app.events.emit({ id: "evt_structural", type: "session.renamed", created: Date.now(), durable: { aggregateID: "ses_stability", seq: 1, version: 1 }, data: { sessionID: "ses_stability", title: "Renamed" } })
    const expected = change === "reorder" ? ["A", "B", "C"] : ["A", "C"]
    await app.waitFor(() => commands.length >= expected.length && notifications.length >= expected.length)
    await Bun.sleep(120)
    expect(commands.sort()).toEqual(expected)
    expect(notifications.sort()).toEqual(expected)
    // The same failing generation must remain stable on another config refresh.
    await Bun.write(configPath, JSON.stringify({ plugins: change === "reorder" ? [plugins[1], failing, plugins[2]] : [failing, plugins[2]], animations: false }))
    await Bun.sleep(150)
    expect(app.captureCharFrame()).toContain("GOOD_A")
    await Bun.write(configPath, JSON.stringify({ plugins: [plugins[2], plugins[0]] }))
    const recovered = await app.waitForFrame((frame) => frame.includes("GOOD_A") && frame.includes("GOOD_C") && !frame.includes("GOOD_B") && frame.indexOf("GOOD_C") < frame.indexOf("GOOD_A"))
    expect(recovered).toContain("STRUCTURAL_DRAFT")
  } finally {
    await bridge.stop(true)
  }
})
