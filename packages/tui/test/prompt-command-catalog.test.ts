import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

async function fixture(state: string, catalog: "pending" | "empty" | "failed") {
  const id = "ses_command_catalog"
  takeDraft(id)
  const gate = Promise.withResolvers<Response>()
  const location = { directory, project: { id: "proj_test", directory, canonical: directory } }
  const sends: { kind: string; body: unknown }[] = []
  let reads = 0
  let recovering = false
  const app = await createAppFixture({
    state,
    args: { sessionID: id },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Catalog model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/command") {
        reads++
        if (catalog === "pending") return gate.promise
        if (catalog === "empty") return json({ location, data: [] })
        // Startup may sync the same failed resource more than once. Keep the
        // outage active until the test explicitly enables the Retry response.
        if (!recovering) return new Response("command catalog unavailable", { status: 503 })
        return gate.promise
      }
      if (url.pathname === `/api/session/${id}`)
        return json({ data: {
          id, title: "Catalog fixture", projectID: "proj_test", location: { directory },
          agent: "build", model: { providerID: "provider", id: "model" }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        } })
      if (request.method === "GET" && /^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (request.method === "POST" && url.pathname.endsWith("/model")) return new Response(null, { status: 204 })
      if (request.method === "POST" && /\/(prompt|command|shell|move)$/.test(url.pathname)) {
        const kind = url.pathname.split("/").at(-1)!
        sends.push({ kind, body: await request.json() })
        return kind === "prompt" ? json({ data: {} }) : new Response(null, { status: 204 })
      }
    },
  })
  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("Build · Catalog model") && app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const input = app.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("Prompt input missing")
    return {
      ...app, input, sends, reads: () => reads,
      recover: () => { recovering = true },
      release: () => gate.resolve(json({ location, data: [{ name: "review", description: "Review fixture" }] })),
      async [Symbol.asyncDispose]() {
        gate.resolve(json({ location, data: [] }))
        await app[Symbol.asyncDispose]()
        takeDraft(id)
      },
    }
  } catch (error) {
    gate.resolve(json({ location, data: [] }))
    await app[Symbol.asyncDispose]()
    takeDraft(id)
    throw error
  }
}

test("an unread command catalog does not block ordinary prompts", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path, "pending")
  await app.mockInput.typeText("ordinary prompt")
  app.mockInput.pressEnter()
  await app.waitFor(() => app.sends.length === 1)
  expect(app.sends[0]).toMatchObject({ kind: "prompt", body: { text: "ordinary prompt" } })
})

test("a loaded-empty command catalog preserves unknown-slash prompt fallback", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path, "empty")
  await app.mockInput.typeText("/unknown captured")
  app.mockInput.pressEscape()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.sends.length === 1)
  expect(app.sends[0]).toMatchObject({ kind: "prompt", body: { text: "/unknown captured" } })
})

test("an absolute shell command does not depend on the slash command catalog", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path, "pending")
  app.mockInput.pressKey("!")
  await app.mockInput.typeText("/bin/echo captured")
  await app.renderOnce()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.sends.length === 1)
  expect(app.sends[0]).toEqual({ kind: "shell", body: { command: "/bin/echo captured" } })
})

test("local argument slash commands remain usable while the server catalog is pending", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path, "pending")
  await app.mockInput.typeText(`/cd ${directory}`)
  app.mockInput.pressEscape()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.sends.length === 1)
  expect(app.sends[0]).toEqual({ kind: "move", body: { directory } })
})

test("built-in help autocomplete remains local with an unread server catalog", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path, "pending")
  await app.mockInput.typeText("/help")
  await app.renderOnce()
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("all available actions and commands"))
  expect(app.sends).toEqual([])
})

test.each(["exit", "quit", ":q"])("the %s entrypoint does not wait for command discovery", async (text) => {
  await using state = await tmpdir()
  await using app = await fixture(state.path, "pending")
  await app.mockInput.typeText(text)
  app.mockInput.pressEnter()
  await app.waitFor(() => app.renderer.isDestroyed)
  expect(app.sends).toEqual([])
})

test("failed command discovery is visible, retryable and never replays the draft automatically", async () => {
  await using state = await tmpdir()
  await using app = await fixture(state.path, "failed")
  await app.waitForFrame((frame) => frame.includes("Location resources unavailable"))
  await app.mockInput.typeText("/review captured")
  app.mockInput.pressEscape()
  app.mockInput.pressEnter()
  await app.renderOnce()
  await app.renderOnce()
  await Bun.sleep(120)
  expect(app.sends).toEqual([])
  expect(app.input.plainText).toBe("/review captured")
  const frame = await app.waitForFrame((frame) => frame.includes("Commands unavailable") && frame.includes("Retry"))
  expect(frame).not.toContain("Location missing")
  const lines = frame.split("\n")
  const row = lines.findIndex((line) => line.includes("Retry"))
  const reads = app.reads()
  app.recover()
  await app.mockMouse.click(lines[row].indexOf("Retry") + 1, row)
  await app.waitFor(() => app.reads() > reads)
  expect(app.sends).toEqual([])
  expect(app.input.plainText).toBe("/review captured")
  app.release()
  await Bun.sleep(120)
  expect(app.sends).toEqual([])
  expect(app.input.plainText).toBe("/review captured")
  app.input.focus()
  app.mockInput.pressEscape()
  app.mockInput.pressEnter()
  await app.waitFor(() => app.sends.length === 1)
  expect(app.sends[0]).toMatchObject({ kind: "command", body: { name: "review", text: "captured" } })
})
