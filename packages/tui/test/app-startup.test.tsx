import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { TextareaRenderable, TextRenderable, type Renderable } from "@opentui/core"
import type { TuiPluginApi, TuiPromptRef } from "@opencode-ai/plugin/tui"
import type { Args } from "../src/context/args"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

function hasText(root: Renderable, value: string): boolean {
  if (root instanceof TextRenderable && root.plainText.includes(value)) return true
  return root.getChildren().some((child) => hasText(child, value))
}

function session(id: string) {
  return {
    id, title: "Startup session", slug: id, projectID: "project", directory,
    version: "test", time: { created: 1, updated: 1 },
  }
}

async function start(options: { args?: Args; auto?: boolean; cached?: boolean; workspaces?: boolean; replacePrompt?: boolean; replacementDraft?: string; prepare?: () => Promise<void>; fork?: () => Promise<Response>; commands?: Promise<Response>; post?: (url: URL) => Response | Promise<Response> | undefined; remove?: (url: URL) => Response | Promise<Response>; get?: (url: URL) => Response | Promise<Response> | undefined } = {}) {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const workspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
  if (options.workspaces) Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
  // Renderer.waitFor stops at visual idle, even if startup IO is still running.
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 5000
    while (!predicate()) {
      if (Date.now() > until) throw new Error(`Startup predicate timed out\n${setup.captureCharFrame()}`)
      await Bun.sleep(10)
    }
    await setup.renderOnce()
  }
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const server = Promise.withResolvers<void>()
  const plugins = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const loaded = Promise.withResolvers<void>()
  const sends: { path: string; body: unknown; auto: boolean }[] = []
  const shells: { path: string; body: unknown }[] = []
  const creates: unknown[] = []
  const forks: string[] = []
  const requests: URL[] = []
  const deletions: URL[] = []
  const replies: { url: URL; body: unknown }[] = []
  const events = createEventSource()
  const executions: { url: URL; directory?: string; username?: string; auto: boolean }[] = []
  let created: ReturnType<typeof session> & { workspaceID?: string } | undefined
  let api: TuiPluginApi | undefined
  let prompt: TuiPromptRef | undefined
  let disposes = 0
  let disposePlugin: (() => void) | undefined
  const calls = createFetch((url) => {
    const response = options.get?.(url)
    if (response) return response
    if (url.pathname === "/config") {
      return server.promise.then(() => json({ auto_approve: options.auto }))
    }
    if (url.pathname === "/command" && options.commands) return options.commands
    if (url.pathname === "/agent") return json([
      { name: "build", mode: "primary", permission: [], options: {} },
      { name: "plan", mode: "primary", permission: [], options: {} },
    ])
    if (url.pathname === "/config/providers") return json({
      providers: [{ id: "test", name: "Test", models: {
        model: { id: "model", name: "Test model", limit: { context: 32000 }, capabilities: {}, variants: {} },
      } }], default: { test: "model" },
    })
    if (url.pathname === "/provider") return json({ all: [], default: {}, connected: ["test"] })
    if (url.pathname === "/session") return json([session("ses_existing")])
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(session(url.pathname.split("/")[2]))
    if (/^\/session\/[^/]+\/(message|todo|diff)$/.test(url.pathname)) return json([])
    if (url.pathname.endsWith("/directories")) return json([])
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    requests.push(url)
    if (request.method === "POST") {
      const response = options.post?.(url)
      if (response) return response
    }
    if (request.method === "DELETE") {
      deletions.push(url)
      if (!options.remove) throw new Error(`unexpected DELETE: ${url}`)
      return options.remove(url)
    }
    if (request.method === "POST" && /\/permission\/[^/]+\/reply$/.test(url.pathname)) {
      replies.push({ url, body: await request.json() })
      return json({})
    }
    if (request.method === "POST" && (url.pathname === "/session" || /\/(message|shell)$/.test(url.pathname))) {
      executions.push({ url, directory: api?.state.path.directory, username: api?.state.config.username, auto: auto() })
    }
    if (request.method === "POST" && url.pathname === "/session") {
      creates.push(await request.json())
      created = { ...session("ses_created"), directory: url.searchParams.get("directory") ?? directory, workspaceID: url.searchParams.get("workspace") ?? undefined }
      return json(created)
    }
    if (request.method === "POST" && url.pathname.endsWith("/fork")) {
      forks.push(url.pathname)
      if (options.fork) return options.fork()
      return json(session("ses_forked"))
    }
    if (request.method === "POST" && url.pathname.endsWith("/message")) {
      sends.push({ path: url.pathname, body: await request.json(), auto: auto() })
      return json({})
    }
    if (request.method === "POST" && url.pathname.endsWith("/shell")) {
      shells.push({ path: url.pathname, body: await request.json() })
      return json({})
    }
    if (url.pathname === "/session/ses_created" && created) return json(created)
    return calls.fetch(request)
  }) as typeof globalThis.fetch
  function auto() {
    return api?.keymap.getCommands({ visibility: "registered" })
      .find((x) => x.name === "permission.mode")?.title === "Disable auto-approve permissions"
  }
  if (options.cached) { server.resolve(); plugins.resolve() }
  const { run } = await import("../src/app")
  const task = Effect.runPromise(run({
    url: "http://test", directory, fetch, events: events.source,
    config: createTuiResolvedConfig({ plugin_enabled: {}, keybinds: { permission_mode: "ctrl+o" } }),
    args: options.args ?? {},
    prepare: options.prepare,
    pluginHost: {
      async start(input) {
        api = input.api
        started.resolve()
        await plugins.promise
        if (options.replacePrompt) disposePlugin = input.runtime.setupSlots(input.api).register({
          id: "startup-prompt", slots: { home_prompt: (_, props) => input.api.ui.Prompt({ ref: (ref) => {
            prompt = ref
            if (ref && options.replacementDraft) ref.set({ input: options.replacementDraft, parts: [], mode: "normal" })
            props.ref?.(ref)
          } }) },
        })
        loaded.resolve()
      },
      async dispose() { disposes++; disposePlugin?.() },
    },
  }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))))
  await waitFor(() => setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    .catch(async (error) => {
      setup.renderer.destroy()
      server.resolve()
      plugins.resolve()
      await task
      Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = workspaces
      mock.restore()
      throw error
    })
  const textarea = () => {
    const input = setup.renderer.currentFocusedEditor
    if (!(input instanceof TextareaRenderable)) throw new Error("expected editable prompt")
    return input
  }
  return {
    setup: { ...setup, waitFor }, server, plugins, started, sends, shells, creates, forks, requests, deletions, executions, replies, events, task, textarea, auto,
    get api() { return api },
    get prompt() { return prompt },
    get disposes() { return disposes },
    submit() { setup.mockInput.pressEnter() },
    async ready() {
      server.resolve()
      plugins.resolve()
      await loaded.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      await setup.renderOnce()
    },
    async shell(command: string) {
      textarea().setText("")
      await setup.renderOnce()
      if (textarea().traits?.status !== "SHELL") setup.mockInput.pressKey("!")
      await waitFor(() => textarea().traits?.status === "SHELL")
      textarea().setText(command)
      await setup.renderOnce()
    },
    async waiting() { await waitFor(() => hasText(setup.renderer.root, "Waiting for startup")) },
    async close() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      server.resolve()
      plugins.resolve()
      await task
      Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = workspaces
      mock.restore()
    },
  }
}

test("slow server and plugins leave a real prompt editable; repeated Enter sends once with configured permissions", async () => {
  const h = await start({ auto: true })
  try {
    h.textarea().setText("hello startup")
    h.submit()
    h.submit()
    await h.waiting()
    expect(h.textarea().plainText).toBe("hello startup")
    expect(h.sends).toHaveLength(0)
    h.server.resolve()
    await h.started.promise
    expect(h.sends).toHaveLength(0)
    h.plugins.resolve()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.creates).toHaveLength(1)
    expect(h.sends[0].auto).toBe(true)
    expect(h.sends[0].body).toMatchObject({ parts: [{ type: "text", text: "hello startup" }] })
  } finally { await h.close() }
})

for (const action of ["escape", "edit", "navigate", "exit"] as const) {
  test(`startup wait is cancelled by ${action} without a late send`, async () => {
    const h = await start()
    try {
      h.textarea().setText("keep draft")
      h.submit()
      await h.waiting()
      if (action === "escape") h.setup.mockInput.pressEscape()
      if (action === "edit") h.textarea().insertText(" edited")
      if (action === "escape" || action === "edit") {
        await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
      }
      h.server.resolve()
      await h.started.promise
      if (action === "navigate") h.api?.route.navigate("home")
      if (action === "exit") {
        h.setup.renderer.destroy()
        await h.task
        expect(h.disposes).toBe(1)
      }
      h.plugins.resolve()
      if (action !== "exit") {
        await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
        await h.setup.renderOnce()
        expect(h.textarea().plainText).toContain("keep draft")
      }
      await h.setup.renderOnce().catch(() => {})
      expect(h.sends).toHaveLength(0)
      expect(h.creates).toHaveLength(0)
    } finally { await h.close() }
  })
}

test("failed preparation keeps the draft and releases the submission lock", async () => {
  const h = await start()
  try {
    h.textarea().setText("recoverable draft")
    h.submit()
    await h.waiting()
    h.server.resolve()
    await h.started.promise
    h.plugins.reject(new Error("plugin initialization failed"))
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
    expect(h.textarea().plainText).toBe("recoverable draft")
    h.submit()
    await h.setup.renderOnce()
    expect(h.sends).toHaveLength(0)
    expect(h.setup.renderer.isDestroyed).toBe(false)
  } finally { await h.close() }
})

for (const item of [
  { args: {}, auto: true, toggle: true, expected: true },
  { args: { auto: true }, auto: false, toggle: false, expected: true },
  { args: { auto: true }, auto: true, toggle: true, expected: false },
  { args: { auto: false }, auto: true, toggle: false, expected: false },
  { args: {}, auto: false, toggle: false, expected: false },
]) {
  test(`permission initialization honors CLI and explicit selection: ${JSON.stringify(item)}`, async () => {
    const h = await start({ args: item.args, auto: item.auto })
    try {
      if (item.toggle) h.setup.mockInput.pressKey("o", { ctrl: true })
      h.textarea().setText("permission test")
      h.submit()
      await h.waiting()
      h.server.resolve()
      h.plugins.resolve()
      await h.setup.waitFor(() => h.sends.length === 1)
      expect(h.sends[0].auto).toBe(item.expected)
    } finally { await h.close() }
  })
}

for (const args of [
  { prompt: "automatic", agent: "plan" },
  { prompt: "automatic", sessionID: "ses_existing" },
  { prompt: "automatic", continue: true },
  { prompt: "automatic", sessionID: "ses_existing", fork: true },
  { prompt: "automatic", continue: true, fork: true },
]) {
  test(`CLI automatic submission waits for its destination: ${JSON.stringify(args)}`, async () => {
    const h = await start({ args })
    try {
      expect(h.textarea().plainText).toBe("automatic")
      expect(h.sends).toHaveLength(0)
      h.server.resolve()
      await h.started.promise
      expect(h.sends).toHaveLength(0)
      h.plugins.resolve()
      await h.setup.waitFor(() => h.sends.length === 1)
      const target = args.fork ? "ses_forked" : args.sessionID || args.continue ? "ses_existing" : "ses_created"
      expect(h.sends[0].path).toBe(`/session/${target}/message`)
      expect(h.forks).toHaveLength(args.fork ? 1 : 0)
      expect(h.creates).toHaveLength(target === "ses_created" ? 1 : 0)
      if (args.agent) expect(h.sends[0].body).toMatchObject({ agent: "plan" })
    } finally { await h.close() }
  })
}

test("cache-hit startup sends normally", async () => {
  const h = await start({ cached: true })
  try {
    h.textarea().setText("cached startup")
    h.submit()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

test("a late plugin prompt inherits the draft and pending submission exactly once", async () => {
  const h = await start({ replacePrompt: true })
  try {
    h.textarea().setText("plugin replacement")
    h.submit()
    await h.waiting()
    h.server.resolve()
    await h.started.promise
    h.plugins.resolve()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0].body).toMatchObject({ parts: [{ type: "text", text: "plugin replacement" }] })
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

test("Escape cancels automatic submission while continue is still preparing", async () => {
  const h = await start({ args: { continue: true, prompt: "cancel automatic" } })
  try {
    await h.waiting()
    h.setup.mockInput.pressEscape()
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
    h.server.resolve()
    h.plugins.resolve()
    await h.setup.waitFor(() => h.api?.route.current.name === "session")
    expect(h.sends).toHaveLength(0)
    expect(h.textarea().plainText).toBe("cancel automatic")
  } finally { await h.close() }
})

test("user navigation during delayed validation suppresses restoration and automatic submission", async () => {
  const validation = Promise.withResolvers<void>()
  const h = await start({ args: { continue: true, fork: true, prompt: "cancel navigation" }, prepare: () => validation.promise })
  try {
    await h.waiting()
    h.server.resolve()
    await h.started.promise
    h.api?.route.navigate("home")
    validation.resolve()
    h.plugins.resolve()
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
    expect(h.api?.route.current.name).toBe("home")
    expect(h.sends).toHaveLength(0)
    expect(h.forks).toHaveLength(0)
  } finally { validation.resolve(); await h.close() }
})

test("manual submit during continue transfers to the restored session", async () => {
  const h = await start({ args: { continue: true } })
  try {
    h.textarea().setText("restore manually")
    h.submit()
    await h.waiting()
    h.server.resolve()
    h.plugins.resolve()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0].path).toBe("/session/ses_existing/message")
    expect(h.creates).toHaveLength(0)
  } finally { await h.close() }
})

test("exit before server preparation completes never starts plugins or sends", async () => {
  const h = await start({ args: { prompt: "never send" } })
  try {
    await h.waiting()
    h.setup.renderer.destroy()
    await h.task
    expect(h.disposes).toBe(1)
    h.server.resolve()
    h.plugins.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(h.api).toBeUndefined()
    expect(h.sends).toHaveLength(0)
  } finally { await h.close() }
})

// TC-002/003: cancelling a submission must not cancel shared initialization
// or leave a lock that prevents a fresh submission of the revised draft.
test("cancel then resubmit during startup sends only the revised draft", async () => {
  const h = await start()
  try {
    h.textarea().setText("old draft")
    h.submit()
    await h.waiting()
    h.setup.mockInput.pressEscape()
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
    h.textarea().setText("new draft")
    await h.setup.renderOnce()
    h.submit()
    await h.waiting()
    h.server.resolve()
    h.plugins.resolve()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0].body).toMatchObject({ parts: [{ type: "text", text: "new draft" }] })
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

// TC-006: toggling twice explicitly selects false; it is not equivalent to
// never choosing a mode, even though the final value equals the initial value.
test("explicitly returning to manual permissions wins over late auto_approve", async () => {
  const h = await start({ auto: true })
  try {
    h.setup.mockInput.pressKey("o", { ctrl: true })
    // Permission text is inside the agent label, which is not hydrated yet.
    await h.setup.renderOnce()
    h.setup.mockInput.pressKey("o", { ctrl: true })
    await h.setup.renderOnce()
    h.textarea().setText("manual permissions")
    h.submit()
    await h.waiting()
    h.server.resolve()
    h.plugins.resolve()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0].auto).toBe(false)
  } finally { await h.close() }
})

test("late plugin prompt replacement cannot revive an Escape-cancelled submission", async () => {
  const h = await start({ replacePrompt: true })
  try {
    const original = h.textarea()
    original.setText("cancel before replacement")
    h.submit()
    await h.waiting()
    h.setup.mockInput.pressEscape()
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
    h.server.resolve()
    h.plugins.resolve()
    await h.setup.waitFor(() => original.isDestroyed && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(h.textarea().plainText).toBe("cancel before replacement")
    expect(h.sends).toHaveLength(0)
    h.submit()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.creates).toHaveLength(1)
  } finally { await h.close() }
})

test("command discovery is a startup barrier even after config is available", async () => {
  const commands = Promise.withResolvers<Response>()
  const h = await start({ commands: commands.promise })
  try {
    h.textarea().setText("wait for commands")
    h.submit()
    await h.waiting()
    h.server.resolve()
    h.plugins.resolve()
    await h.setup.renderOnce()
    expect(h.sends).toHaveLength(0)
    commands.resolve(json([]))
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.creates).toHaveLength(1)
  } finally { commands.resolve(json([])); await h.close() }
})

test("fork failure retains the automatic draft without sending to a fallback session", async () => {
  const fork = Promise.withResolvers<Response>()
  const h = await start({ args: { continue: true, fork: true, prompt: "retain failed fork" }, fork: () => fork.promise })
  try {
    await h.waiting()
    h.server.resolve()
    h.plugins.resolve()
    await h.setup.waitFor(() => h.forks.length === 1)
    expect(h.sends).toHaveLength(0)
    fork.resolve(json({ name: "ForkFailed", data: { message: "cannot fork" } }, { status: 500 }))
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
    expect(h.textarea().plainText).toBe("retain failed fork")
    expect(h.sends).toHaveLength(0)
    expect(h.creates).toHaveLength(0)
  } finally { fork.resolve(json({})); await h.close() }
})

test("navigation while fork HTTP request is in flight prevents late restore and send", async () => {
  const fork = Promise.withResolvers<Response>()
  const h = await start({ args: { continue: true, fork: true, prompt: "cancel in flight" }, fork: () => fork.promise })
  try {
    await h.waiting()
    h.server.resolve()
    h.plugins.resolve()
    await h.setup.waitFor(() => h.forks.length === 1)
    h.api!.route.navigate("home")
    fork.resolve(json({ id: "ses_late_fork" }))
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
    await h.setup.renderOnce()
    expect(h.api!.route.current.name).toBe("home")
    expect(h.sends).toHaveLength(0)
    expect(h.creates).toHaveLength(0)
    expect(h.textarea().plainText).toBe("cancel in flight")
  } finally { fork.resolve(json({})); await h.close() }
})

// R-001: exercise the textarea-specific Escape binding, not just the command.
test("one Escape cancels a waiting shell submit without changing its execution intent", async () => {
  const h = await start()
  try {
    await h.shell("echo cancelled-shell")
    h.submit()
    await h.waiting()
    h.setup.mockInput.pressEscape()
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
    expect(h.textarea().traits?.status).toBe("SHELL")
    await h.ready()
    expect(h.textarea().plainText).toBe("echo cancelled-shell")
    expect(h.creates).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
    expect(h.shells).toHaveLength(0)
    h.submit()
    await h.setup.waitFor(() => h.shells.length === 1)
    expect(h.shells[0].body).toMatchObject({ command: "echo cancelled-shell" })
    expect(h.sends).toHaveLength(0)
  } finally { await h.close() }
})

test("leaving shell mode with Backspace invalidates a pending submission even without editing text", async () => {
  const h = await start()
  try {
    await h.shell("echo change-mode")
    h.submit()
    await h.waiting()
    h.textarea().gotoBufferHome()
    await h.setup.renderOnce()
    h.setup.mockInput.pressBackspace()
    await h.setup.waitFor(() => h.textarea().traits?.status !== "SHELL")
    await h.ready()
    expect(h.textarea().plainText).toBe("echo change-mode")
    expect(h.creates).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
    expect(h.shells).toHaveLength(0)
  } finally { await h.close() }
})

// R-002: transfer is a complete draft (including mode), not just text or a
// pending flag. Draft-only and cancelled transfers must wait for a new Enter.
for (const destination of ["plugin", "continue", "session-fork", "continue-fork"] as const) {
  for (const intent of ["pending", "draft", "cancelled"] as const) {
    test(`shell ${intent} preserves its mode across ${destination} prompt transfer`, async () => {
      const args = destination === "plugin" ? {}
        : destination === "session-fork" ? { sessionID: "ses_existing", fork: true }
        : { continue: true, fork: destination === "continue-fork" }
      const h = await start({ args, replacePrompt: destination === "plugin" })
      try {
        const original = h.textarea()
        const command = `echo ${destination}-${intent}`
        await h.shell(command)
        if (intent !== "draft") {
          h.submit()
          await h.waiting()
        }
        if (intent === "cancelled") {
          h.setup.mockInput.pressEscape()
          await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
        }
        await h.ready()
        if (intent !== "pending") {
          await h.setup.waitFor(() => original.isDestroyed && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
          expect(h.textarea().plainText).toBe(command)
          expect(h.textarea().traits?.status).toBe("SHELL")
          expect(h.creates).toHaveLength(0)
          expect(h.sends).toHaveLength(0)
          expect(h.shells).toHaveLength(0)
          h.submit()
        }
        await h.setup.waitFor(() => h.shells.length === 1)
        const target = destination === "plugin" ? "ses_created" : args.fork ? "ses_forked" : "ses_existing"
        expect(h.shells[0]).toMatchObject({ path: `/session/${target}/shell`, body: { command } })
        expect(h.sends).toHaveLength(0)
        expect(h.creates).toHaveLength(destination === "plugin" ? 1 : 0)
        expect(h.forks).toHaveLength(args.fork ? 1 : 0)
      } finally { await h.close() }
    })
  }
}

// R-003: successful late forks and failed late forks have the same owner.
for (const failure of ["before-navigation", "after-navigation", "after-new-send"] as const) {
  test(`abandoned startup fork failure ${failure} cannot poison a new home submission`, async () => {
    const fork = Promise.withResolvers<Response>()
    const h = await start({ args: { continue: true, fork: true, prompt: "abandoned fork" }, fork: () => fork.promise })
    try {
      await h.waiting()
      await h.ready()
      await h.setup.waitFor(() => h.forks.length === 1)
      if (failure === "before-navigation") {
        fork.resolve(json({ message: "active fork failed" }, { status: 500 }))
        await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
      }
      h.api!.route.navigate("home")
      await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
      if (failure === "after-navigation") {
        fork.resolve(json({ message: "late fork failed" }, { status: 500 }))
        await new Promise<void>((resolve) => setImmediate(resolve))
        await h.setup.renderOnce()
      }
      h.textarea().setText("new unrelated draft")
      h.submit()
      await h.setup.waitFor(() => h.sends.length === 1)
      expect(h.sends[0]).toMatchObject({ path: "/session/ses_created/message", body: { parts: [{ text: "new unrelated draft" }] } })
      if (failure === "after-new-send") {
        fork.resolve(json({ message: "very late fork failed" }, { status: 500 }))
        await new Promise<void>((resolve) => setImmediate(resolve))
        await h.setup.renderOnce()
      }
      expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
      expect(h.creates).toHaveLength(1)
      expect(h.shells).toHaveLength(0)
    } finally { fork.resolve(json({})); await h.close() }
  })
}

// R-004: neither session.get nor shared session-cache hydration may keep a
// previous route's preparation barrier alive. The old IO stays unresolved
// until after the new message is observed.
for (const phase of ["get", "messages"] as const) {
  for (const destination of ["home", "session"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      test(`abandoned session ${phase} ${outcome} does not delay ${destination} submission`, async () => {
        const old = Promise.withResolvers<Response>()
        const requested = Promise.withResolvers<void>()
        const h = await start({ cached: true, get: (url) => {
          if (url.pathname !== `/session/ses_old${phase === "messages" ? "/message" : ""}`) return
          requested.resolve()
          return old.promise
        } })
        try {
          await h.ready()
          h.api!.route.navigate("session", { sessionID: "ses_old" })
          await requested.promise
          await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
          h.textarea().setText("do not send old route")
          h.submit()
          await h.waiting()
          h.api!.route.navigate(destination, destination === "session" ? { sessionID: "ses_new" } : undefined)
          await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
          h.textarea().setText("new route draft")
          h.submit()
          await h.setup.waitFor(() => h.sends.length === 1)
          expect(h.sends[0]).toMatchObject({
            path: `/session/${destination === "home" ? "ses_created" : "ses_new"}/message`,
            body: { parts: [{ text: "new route draft" }] },
          })
          if (outcome === "failure") old.reject(new Error("abandoned hydration failed"))
          if (outcome === "success") old.resolve(json(phase === "messages" ? [] : { id: "ses_old", directory, workspaceID: "obsolete" }))
          await new Promise<void>((resolve) => setImmediate(resolve))
          await h.setup.renderOnce()
          expect(h.sends).toHaveLength(1)
          expect(h.shells).toHaveLength(0)
          expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
          if (destination === "session") expect(h.api!.route.current).toMatchObject({ name: "session", params: { sessionID: "ses_new" } })
        } finally { old.resolve(json([])); await h.close() }
      })
    }
  }
}

test("abandoning session hydration releases only its barrier, not unfinished plugins", async () => {
  const old = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const h = await start({ get: (url) => {
    if (url.pathname !== "/session/ses_old") return
    requested.resolve()
    return old.promise
  } })
  try {
    h.server.resolve()
    await h.started.promise
    h.api!.route.navigate("session", { sessionID: "ses_old" })
    await requested.promise
    h.api!.route.navigate("home")
    await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("still need plugins")
    h.submit()
    await h.waiting()
    expect(h.sends).toHaveLength(0)
    await h.ready()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0].body).toMatchObject({ parts: [{ text: "still need plugins" }] })
  } finally { old.resolve(json({})); await h.close() }
})

test("abandoned workspace hydration cannot overwrite the new session configuration or path", async () => {
  const config = Promise.withResolvers<Response>()
  const path = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const h = await start({ cached: true, auto: false, get: (url) => {
    if (url.pathname === "/session/ses_old") return json({ ...session("ses_old"), directory: "/obsolete", workspaceID: "old_workspace" })
    if (url.searchParams.get("workspace") !== "old_workspace") return
    if (url.pathname === "/config") {
      requested.resolve()
      return config.promise
    }
    if (url.pathname === "/path") return path.promise
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_old" })
    await requested.promise
    h.api!.route.navigate("session", { sessionID: "ses_new" })
    await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("new workspace submission")
    h.submit()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0]).toMatchObject({ path: "/session/ses_new/message", auto: false })
    config.resolve(json({ auto_approve: true }))
    path.resolve(json({ home: "", state: "", config: "", worktree: "/obsolete", directory: "/obsolete" }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await h.setup.renderOnce()
    expect(h.api!.state.config.auto_approve).toBe(false)
    expect(h.api!.state.path.directory).toBe(directory)
    expect(h.auto()).toBe(false)
    expect(h.api!.route.current).toMatchObject({ name: "session", params: { sessionID: "ses_new" } })
  } finally { config.resolve(json({})); path.resolve(json({})); await h.close() }
})

test("a second session in the same workspace hydrates again instead of reusing cancelled startup data", async () => {
  const old = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  let configurations = 0
  const h = await start({ cached: true, auto: false, get: (url) => {
    if (["/session/ses_old", "/session/ses_new"].includes(url.pathname)) {
      return json({ ...session(url.pathname.split("/")[2]), workspaceID: "shared_workspace" })
    }
    if (url.pathname === "/experimental/workspace") return json([{ id: "shared_workspace", type: "worktree", directory }])
    if (url.pathname === "/experimental/workspace/status") return json([{ workspaceID: "shared_workspace", status: "connected" }])
    if (url.pathname !== "/config" || url.searchParams.get("workspace") !== "shared_workspace") return
    configurations++
    if (configurations > 1) return json({ auto_approve: true })
    requested.resolve()
    return old.promise
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_old" })
    await requested.promise
    h.api!.route.navigate("session", { sessionID: "ses_new" })
    await h.setup.waitFor(() => h.api!.state.config.auto_approve === true && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("same workspace new session")
    h.submit()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(configurations).toBe(2)
    expect(h.sends[0]).toMatchObject({ path: "/session/ses_new/message", auto: true })
    old.resolve(json({ auto_approve: false }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await h.setup.renderOnce()
    expect(h.api!.state.config.auto_approve).toBe(true)
    expect(h.auto()).toBe(true)
  } finally { old.resolve(json({})); await h.close() }
})

test("abandoned CLI session validation cannot block a new route or report a fatal late error", async () => {
  const validation = Promise.withResolvers<void>()
  const h = await start({ args: { continue: true, prompt: "obsolete target" }, prepare: () => validation.promise })
  try {
    await h.waiting()
    await h.ready()
    h.api!.route.navigate("home")
    h.textarea().setText("independent target")
    h.submit()
    await h.setup.waitFor(() => h.sends.length === 1)
    validation.reject(new Error("obsolete session does not exist"))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await h.setup.renderOnce()
    expect(h.sends[0].path).toBe("/session/ses_created/message")
    expect(h.creates).toHaveLength(1)
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
  } finally { validation.resolve(); await h.close() }
})

// TC-010 / DEC-006: a plugin's own draft is not the restored user's intent.
test("a plugin preset draft cannot inherit the old shell pending submission", async () => {
  const h = await start({ replacePrompt: true, replacementDraft: "plugin preset draft" })
  try {
    const original = h.textarea()
    await h.shell("echo old pending shell")
    h.submit()
    await h.waiting()
    await h.ready()
    await h.setup.waitFor(() => original.isDestroyed && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    expect(h.textarea().plainText).toBe("plugin preset draft")
    expect(h.textarea().traits?.status).not.toBe("SHELL")
    expect(h.creates).toHaveLength(0)
    expect(h.shells).toHaveLength(0)
    expect(h.sends).toHaveLength(0)
    h.submit()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0].body).toMatchObject({ parts: [{ text: "plugin preset draft" }] })
    expect(h.creates).toHaveLength(1)
    expect(h.shells).toHaveLength(0)
  } finally { await h.close() }
})

// TC-012/013: dropping the old owner must not bypass the new owner's config.
test("a new workspace submission still waits for its own configuration after the old owner is cancelled", async () => {
  const old = Promise.withResolvers<Response>()
  const current = Promise.withResolvers<Response>()
  const requested = Promise.withResolvers<void>()
  const nextRequested = Promise.withResolvers<void>()
  const h = await start({ cached: true, auto: false, get: (url) => {
    if (["/session/ses_old", "/session/ses_new"].includes(url.pathname)) {
      const id = url.pathname.split("/")[2]
      return json({ ...session(id), workspaceID: id === "ses_old" ? "old_workspace" : "new_workspace" })
    }
    if (url.pathname === "/experimental/workspace") return json([
      { id: "old_workspace", type: "worktree", directory: "/obsolete" },
      { id: "new_workspace", type: "worktree", directory: "/current" },
    ])
    if (url.pathname === "/experimental/workspace/status") return json([
      { workspaceID: "old_workspace", status: "connected" },
      { workspaceID: "new_workspace", status: "connected" },
    ])
    const workspace = url.searchParams.get("workspace")
    if (url.pathname === "/path" && workspace) return json({
      home: "", state: "", config: "", worktree: "/", directory: workspace === "old_workspace" ? "/obsolete" : "/current",
    })
    if (url.pathname !== "/config") return
    if (workspace === "old_workspace") { requested.resolve(); return old.promise }
    if (workspace === "new_workspace") { nextRequested.resolve(); return current.promise }
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_old" })
    await requested.promise
    h.api!.route.navigate("session", { sessionID: "ses_new" })
    await nextRequested.promise
    await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("wait for current workspace")
    h.submit()
    await h.waiting()
    expect(h.sends).toHaveLength(0)
    old.resolve(json({ auto_approve: true, username: "obsolete" }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    await h.setup.renderOnce()
    expect(h.sends).toHaveLength(0)
    expect(h.api!.state.config.auto_approve).toBe(false)
    expect(hasText(h.setup.renderer.root, "Waiting for startup")).toBe(true)
    current.resolve(json({ auto_approve: true, username: "current" }))
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0]).toMatchObject({ path: "/session/ses_new/message", auto: true })
    expect(h.api!.state.config.username).toBe("current")
    expect(h.api!.state.path.directory).toBe("/current")
    expect(h.creates).toHaveLength(0)
    expect(h.shells).toHaveLength(0)
  } finally { old.resolve(json({})); current.resolve(json({})); await h.close() }
})

// Only the HTTP boundary is controlled: all context commits, barriers, keyboard
// handling and request construction below run through the real TUI.
function workspaceResponse(url: URL) {
  if (url.pathname === "/experimental/workspace/adapter") return json([])
  if (url.pathname === "/experimental/workspace/sync-list") return json({})
  const id = url.pathname.split("/")[2]
  if (/^\/session\/ses_[ABC]$/.test(url.pathname)) {
    const workspaceID = id.slice(4)
    return json({ ...session(id), workspaceID, directory: `/workspace-${workspaceID}` })
  }
  if (url.pathname === "/experimental/workspace") return json(
    ["A", "B", "C"].map((id) => ({ id, name: id, type: "worktree", directory: `/workspace-${id}` })),
  )
  if (url.pathname === "/experimental/workspace/status") return json(
    ["A", "B", "C"].map((workspaceID) => ({ workspaceID, status: "connected" })),
  )
  const workspace = url.searchParams.get("workspace")
  if (url.pathname === "/config") return json({ username: workspace ?? "OLD", auto_approve: !workspace })
  if (url.pathname === "/path" && workspace) return json({
    home: "", state: "", config: "", worktree: `/workspace-${workspace}`, directory: `/workspace-${workspace}`,
  })
}

function instanceDisposed(h: Awaited<ReturnType<typeof start>>, workspace?: string, location = workspace ? `/workspace-${workspace}` : directory, id = "evt_instance_disposed") {
  h.events.emit({ directory: location, workspace, payload: {
    id, type: "server.instance.disposed", properties: { directory: location },
  } })
}

for (const mode of ["message", "shell"] as const) {
  test(`instance disposed old local cannot steal pending C ${mode}`, async () => {
    const config = Promise.withResolvers<Response>()
    const h = await start({ cached: true, get: (url) => {
      if (url.pathname === "/config" && url.searchParams.get("workspace") === "C") return config.promise
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "C"))
      await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      if (mode === "shell") await h.shell("echo C survives refresh")
      if (mode === "message") h.textarea().setText("C survives refresh")
      h.submit()
      await h.waiting()
      for (const repeat of [1, 2, 3]) instanceDisposed(h)
      await Bun.sleep(40)
      expect(h.requests.filter((url) => url.pathname === "/config").map((url) => url.searchParams.get("workspace"))).toEqual([null, "C"])
      expect(h.executions).toHaveLength(0)
      config.resolve(json({ username: "C", auto_approve: false }))
      await h.setup.waitFor(() => h.sends.length + h.shells.length === 1)
      expect(h.executions[0]).toMatchObject({ username: "C", directory: "/workspace-C", auto: false })
      expect(h.executions[0].url.pathname).toBe(`/session/ses_C/${mode}`)
      expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
      expect(h.requests.filter((url) => url.pathname === "/config")).toHaveLength(2)
    } finally { config.resolve(json({})); await h.close() }
  })
}

for (const outcome of ["success", "failure", "navigate"] as const) {
  test(`instance disposed pending C refresh keeps one lifecycle: ${outcome}`, async () => {
    const old = Promise.withResolvers<Response>()
    const fresh = Promise.withResolvers<Response>()
    let configs = 0
    const h = await start({ cached: true, get: (url) => {
      if (url.pathname === "/config" && url.searchParams.get("workspace") === "C") return ++configs === 1 ? old.promise : fresh.promise
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => configs === 1)
      await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      h.textarea().setText("latest C only")
      h.submit()
      await h.waiting()
      instanceDisposed(h, "C")
      await h.setup.waitFor(() => configs === 2)
      instanceDisposed(h, "C")
      instanceDisposed(h, "C")
      await Bun.sleep(40)
      expect(configs).toBe(2)
      expect(h.executions).toHaveLength(0)
      expect(h.api!.state.config.username).toBe("OLD")
      if (outcome === "navigate") {
        h.api!.route.navigate("session", { sessionID: "ses_A" })
        await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
      }
      fresh.resolve(outcome === "failure" ? json({ message: "refresh unavailable" }, { status: 500 }) : json({ username: "C-new", auto_approve: false }))
      if (outcome === "success") {
        // The superseded read remains pending; it must not hold hydration hostage.
        await h.setup.waitFor(() => h.sends.length === 1)
        expect(h.executions[0]).toMatchObject({ username: "C-new", directory: "/workspace-C", auto: false })
      }
      if (outcome === "failure") {
        await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
        for (const repeat of [1, 2]) { h.submit(); await h.setup.renderOnce() }
        expect(h.textarea().plainText).toBe("latest C only")
      }
      old.resolve(json({ username: "C-obsolete", auto_approve: true }))
      await Bun.sleep(40)
      await h.setup.renderOnce()
      expect(configs).toBe(2)
      expect(h.api!.state.config.username).toBe(outcome === "success" ? "C-new" : outcome === "navigate" ? "A" : "OLD")
      expect(h.sends).toHaveLength(outcome === "success" ? 1 : 0)
      expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(outcome === "failure")
    } finally { old.resolve(json({})); fresh.resolve(json({})); await h.close() }
  })
}

test("instance disposed ready C refresh merges duplicates and waits for complete latest configuration", async () => {
  const config = Promise.withResolvers<Response>()
  const commands = Promise.withResolvers<Response>()
  let configs = 0
  const h = await start({ cached: true, get: (url) => {
    if (url.searchParams.get("workspace") === "C") {
      if (url.pathname === "/session") return json([{ ...session("ses_C"), workspaceID: "C", directory: "/workspace-C" }])
      if (url.pathname === "/config" && ++configs > 1) return config.promise
      if (url.pathname === "/command" && configs > 1) return commands.promise
    }
    return workspaceResponse(url)
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_C" })
    await h.setup.waitFor(() => h.api!.state.config.username === "C" && h.api!.state.session.get("ses_C") !== undefined)
    instanceDisposed(h, "C", "/other-directory")
    instanceDisposed(h, "A")
    await Bun.sleep(40)
    expect(configs).toBe(1)
    instanceDisposed(h, "C")
    await h.setup.waitFor(() => configs === 2)
    instanceDisposed(h, "C")
    instanceDisposed(h, "C")
    await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await h.shell("echo complete refresh")
    h.submit()
    await h.waiting()
    config.resolve(json({ username: "C-new", auto_approve: true }))
    await Bun.sleep(40)
    expect(h.api!.state.config.username).toBe("C")
    expect(h.executions).toHaveLength(0)
    commands.resolve(json([]))
    await h.setup.waitFor(() => h.shells.length === 1)
    expect(configs).toBe(2)
    expect(h.executions[0]).toMatchObject({ username: "C-new", directory: "/workspace-C", auto: true })
    expect(h.shells[0].path).toBe("/session/ses_C/shell")
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
  } finally { config.resolve(json({})); commands.resolve(json([])); await h.close() }
})

for (const outcome of ["success", "failure"] as const) {
  test(`instance disposed retained local refresh after candidate cancellation: ${outcome}`, async () => {
    const candidate = Promise.withResolvers<Response>()
    const local = Promise.withResolvers<Response>()
    let locals = 0
    const h = await start({ cached: true, get: (url) => {
      if (url.pathname === "/config") {
        if (url.searchParams.get("workspace") === "C") return candidate.promise
        if (!url.searchParams.has("workspace") && ++locals > 1) return local.promise
      }
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "C"))
      instanceDisposed(h)
      instanceDisposed(h)
      await Bun.sleep(40)
      expect(locals).toBe(1)
      h.api!.route.navigate("home")
      await h.setup.waitFor(() => locals === 2 && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      if (h.textarea().traits?.status === "SHELL") { h.setup.mockInput.pressEscape(); await h.setup.waitFor(() => h.textarea().traits?.status !== "SHELL") }
      h.textarea().setText("fallback needs fresh local")
      h.submit()
      await h.waiting()
      expect(h.executions).toHaveLength(0)
      local.resolve(outcome === "failure" ? json({ message: "local refresh unavailable" }, { status: 500 }) : json({ username: "LOCAL-new", auto_approve: false }))
      if (outcome === "success") {
        await h.setup.waitFor(() => h.sends.length === 1)
        expect(h.executions[0]).toMatchObject({ username: "LOCAL-new", directory, auto: false })
        expect(h.executions[0].url.searchParams.get("workspace")).toBeNull()
      }
      if (outcome === "failure") {
        await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
        h.submit(); await h.setup.renderOnce(); h.submit(); await h.setup.renderOnce()
        expect(h.executions).toHaveLength(0)
      }
      candidate.resolve(json({ username: "C-late", auto_approve: true }))
      await Bun.sleep(40)
      expect(locals).toBe(2)
      expect(h.api!.state.config.username).toBe(outcome === "success" ? "LOCAL-new" : "OLD")
    } finally { candidate.resolve(json({})); local.resolve(json({})); await h.close() }
  })
}

test("instance disposed old local does not erase failed C and refreshes on leaving", async () => {
  let locals = 0
  const h = await start({ cached: true, get: (url) => {
    if (url.pathname === "/config") {
      if (url.searchParams.get("workspace") === "C") return json({ message: "C unavailable" }, { status: 500 })
      locals++
      return json({ username: locals === 1 ? "OLD" : "LOCAL-new" })
    }
    return workspaceResponse(url)
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_C" })
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
    instanceDisposed(h)
    instanceDisposed(h)
    await Bun.sleep(40)
    expect(locals).toBe(1)
    expect(h.api!.state.config.username).toBe("OLD")
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(true)
    expect(h.executions).toHaveLength(0)
    h.api!.route.navigate("home")
    await h.setup.waitFor(() => h.api!.state.config.username === "LOCAL-new")
    expect(locals).toBe(2)
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
  } finally { await h.close() }
})

for (const outcome of ["success", "failure"] as const) {
  test(`instance disposed during initial sync uses latest result without internal cancellation failure: ${outcome}`, async () => {
    const old = Promise.withResolvers<Response>()
    const fresh = Promise.withResolvers<Response>()
    let configs = 0
    const h = await start({ get: (url) => {
      if (url.pathname === "/config") return ++configs === 1 ? old.promise : fresh.promise
    } })
    try {
      h.plugins.resolve()
      h.textarea().setText("initial refreshed draft")
      h.submit()
      await h.waiting()
      instanceDisposed(h, undefined, "/other-local")
      await Bun.sleep(40)
      expect(configs).toBe(1)
      instanceDisposed(h)
      await h.setup.waitFor(() => configs === 2)
      instanceDisposed(h)
      fresh.resolve(outcome === "success" ? json({ username: "INITIAL-new", auto_approve: false }) : json({ message: "initial refresh failed" }, { status: 500 }))
      if (outcome === "success") await h.setup.waitFor(() => h.sends.length === 1)
      if (outcome === "failure") await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
      old.resolve(json({ username: "INITIAL-old", auto_approve: true }))
      await Bun.sleep(40)
      await h.setup.renderOnce()
      expect(configs).toBe(2)
      expect(h.sends).toHaveLength(outcome === "success" ? 1 : 0)
      expect(h.api?.state.config.username).toBe(outcome === "success" ? "INITIAL-new" : undefined)
      expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(outcome === "failure")
    } finally { old.resolve(json({})); fresh.resolve(json({})); await h.close() }
  })
}

test("instance disposed new invalidation during refresh is not mistaken for a duplicate", async () => {
  const first = Promise.withResolvers<Response>()
  const latest = Promise.withResolvers<Response>()
  let configs = 0
  const h = await start({ cached: true, get: (url) => {
    if (url.pathname === "/config" && ++configs > 1) return configs === 2 ? first.promise : latest.promise
  } })
  try {
    await h.ready()
    instanceDisposed(h)
    await h.setup.waitFor(() => configs === 2)
    h.textarea().setText("new invalidation wins")
    h.submit()
    await h.waiting()
    instanceDisposed(h, undefined, directory, "evt_second_disposal")
    await h.setup.waitFor(() => configs === 3)
    instanceDisposed(h)
    instanceDisposed(h, undefined, directory, "evt_second_disposal")
    first.resolve(json({ username: "OBSOLETE" }))
    await Bun.sleep(40)
    expect(h.executions).toHaveLength(0)
    expect(h.api!.state.config.username).toBeUndefined()
    latest.resolve(json({ username: "LATEST" }))
    await h.setup.waitFor(() => h.sends.length === 1)
    instanceDisposed(h, undefined, directory, "evt_second_disposal")
    await Bun.sleep(40)
    expect(configs).toBe(3)
    expect(h.executions[0].username).toBe("LATEST")
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
  } finally { first.resolve(json({})); latest.resolve(json({})); await h.close() }
})

test("instance disposed Home candidate Escape retains shell intent and refreshes dirty fallback", async () => {
  const candidate = Promise.withResolvers<Response>()
  const local = Promise.withResolvers<Response>()
  let locals = 0
  const h = await start({ cached: true, workspaces: true, get: (url) => {
    if (url.pathname === "/config") {
      if (url.searchParams.get("workspace") === "A") return candidate.promise
      if (!url.searchParams.has("workspace") && ++locals > 1) return local.promise
    }
    return workspaceResponse(url)
  } })
  try {
    await h.ready()
    await selectHomeWorkspace(h)
    await h.shell("echo retained shell intent")
    h.submit()
    await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "A"))
    instanceDisposed(h)
    await Bun.sleep(40)
    h.setup.mockInput.pressEscape()
    await h.setup.waitFor(() => locals === 2 && !hasText(h.setup.renderer.root, "Waiting for startup"))
    expect(h.textarea().traits?.status).toBe("SHELL")
    expect(h.textarea().plainText).toBe("echo retained shell intent")
    local.resolve(json({ username: "LOCAL-new", auto_approve: false }))
    await h.setup.waitFor(() => h.api!.state.config.username === "LOCAL-new")
    candidate.resolve(json({ username: "A-late", auto_approve: true }))
    await Bun.sleep(40)
    expect(h.executions).toHaveLength(0)
    expect(h.textarea().traits?.status).toBe("SHELL")
    expect(h.api!.state.config.username).toBe("LOCAL-new")
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
  } finally { candidate.resolve(json({})); local.resolve(json({})); await h.close() }
})

for (const method of ["api", "code", "auto"] as const) {
  for (const stage of ["auth", "dispose", "config"] as const) {
    for (const leave of ["close", "replace", "route", "none"] as const) {
      for (const failure of [false, true]) {
        test(`provider lifecycle ${method} ${stage} ${leave} ${failure ? "failure" : "success"}`, async () => {
          const gate = Promise.withResolvers<Response>()
          let configs = 0
          const auth = method === "api" ? "/auth/test" : "/provider/test/oauth/callback"
          const h = await start({ cached: true, get: (url) => {
            if (url.pathname === "/provider") return json({ all: [{ id: "test", name: "Test", models: {} }], default: {}, connected: ["test"] })
            if (url.pathname === "/provider/auth") return json({ test: [{ type: method === "api" ? "api" : "oauth", label: "Fixture auth" }] })
            if (url.pathname === "/config" && ++configs > 1 && stage === "config") return gate.promise
            if (url.pathname === auth) return stage === "auth" ? gate.promise : json(true)
          }, post: (url) => {
            if (url.pathname === "/provider/test/oauth/authorize") return json({ method, url: "https://example.test", instructions: "Fixture authorization" })
            if (url.pathname === auth) return stage === "auth" ? gate.promise : json(true)
            if (url.pathname === "/instance/dispose") return stage === "dispose" ? gate.promise : json(true)
          } })
          try {
            await h.ready()
            await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/provider/auth"))
            h.api!.keymap.dispatchCommand("provider.connect")
            await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Connect a provider"))
            h.setup.mockInput.pressEnter()
            if (method !== "auto") {
              await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Fixture auth") && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
              h.textarea().setText("fixture-only-credential")
              h.setup.mockInput.pressEnter()
              h.setup.mockInput.pressEnter()
            }
            await h.setup.waitFor(() => stage === "config" ? configs === 2 : h.requests.some((url) => url.pathname === (stage === "auth" ? auth : "/instance/dispose")))
            if (leave === "close") {
              h.setup.mockInput.pressEscape()
              await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Fixture auth"))
            }
            if (leave === "route") h.api!.route.navigate("home")
            if (leave === "replace" || leave === "close") {
              h.api!.keymap.dispatchCommand("session.list")
              await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Sessions"))
            }
            gate.resolve(failure ? json({ message: "fixture auth failure" }, { status: 500 }) : json(stage === "config" ? { username: "AUTH_REFRESH" } : true))
            if (!failure) await h.setup.waitFor(() => configs === 2)
            await Bun.sleep(80)
            await h.setup.renderOnce()
            expect(h.requests.filter((url) => url.pathname === auth)).toHaveLength(1)
            expect(h.requests.filter((url) => url.pathname === "/instance/dispose")).toHaveLength(stage === "auth" && failure ? 0 : 1)
            expect(h.executions).toHaveLength(0)
            if (leave === "close" || leave === "replace") expect(hasText(h.setup.renderer.root, "Sessions")).toBe(true)
            if (leave === "route") expect(hasText(h.setup.renderer.root, "Fixture auth")).toBe(true)
            if (leave !== "none") {
              expect(hasText(h.setup.renderer.root, "Invalid code")).toBe(false)
              expect(hasText(h.setup.renderer.root, "OAuth authorization failed")).toBe(false)
            }
            if (leave === "none" && !failure) await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Fixture auth"))
            if (leave === "none" && failure && stage === "auth" && method === "code") expect(hasText(h.setup.renderer.root, "Invalid code")).toBe(true)
          } finally { gate.resolve(json(true)); await h.close() }
        })
      }
    }
  }
}

for (const failure of [false, true]) {
  for (const leave of ["close", "replace", "route"] as const) {
    test(`provider lifecycle authorize ${leave} ${failure}`, async () => {
      const gate = Promise.withResolvers<Response>()
      const h = await start({ cached: true, get: (url) => {
        if (url.pathname === "/provider") return json({ all: [{ id: "test", name: "Test", models: {} }], default: {}, connected: ["test"] })
        if (url.pathname === "/provider/auth") return json({ test: [{ type: "oauth", label: "Fixture auth" }] })
      }, post: (url) => {
        if (url.pathname === "/provider/test/oauth/authorize") return gate.promise
      } })
      try {
        await h.ready()
        h.api!.keymap.dispatchCommand("provider.connect")
        await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Connect a provider"))
        h.setup.mockInput.pressEnter()
        await h.setup.waitFor(() => h.requests.some((url) => url.pathname.endsWith("/authorize")))
        if (leave === "route") h.api!.route.navigate("home")
        if (leave === "close") { h.setup.mockInput.pressEscape(); await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Connect a provider")) }
        if (leave !== "route") { h.api!.keymap.dispatchCommand("session.list"); await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Sessions")) }
        gate.resolve(failure ? json({ message: "late authorize failure" }, { status: 500 }) : json({ method: "auto", url: "https://example.test", instructions: "Fixture authorization" }))
        await Bun.sleep(80)
        await h.setup.renderOnce()
        expect(h.requests.filter((url) => url.pathname.endsWith("/callback"))).toHaveLength(0)
        expect(hasText(h.setup.renderer.root, leave === "route" ? "Connect a provider" : "Sessions")).toBe(true)
        expect(hasText(h.setup.renderer.root, "late authorize failure")).toBe(false)
      } finally { gate.resolve(json({})); await h.close() }
    })
  }
}

for (const disabled of [false, true]) {
  for (const choice of ["absent", "true", "false", "toggle"] as const) {
    test(`paste summary late config ${disabled} choice ${choice}`, async () => {
      const config = Promise.withResolvers<Response>()
      const refresh = Promise.withResolvers<Response>()
      let configs = 0
      const h = await start({ cached: true, get: (url) => {
        if (url.pathname === "/config") return ++configs === 1 ? config.promise : refresh.promise
      } })
      try {
        config.resolve(json({ experimental: { disable_paste_summary: disabled } }))
        await h.ready()
        const title = () => h.api!.keymap.getCommands({ visibility: "registered" }).find((x) => x.name === "app.toggle.paste_summary")!.title
        const kv = h.api!.kv
        kv.set("paste_summary_enabled", undefined)
        expect(title()).toBe(disabled ? "Enable paste summary" : "Disable paste summary")
        expect(kv.get("paste_summary_enabled")).toBeUndefined()
        instanceDisposed(h)
        await h.setup.waitFor(() => configs === 2)
        if (choice === "true" || choice === "false") kv.set("paste_summary_enabled", choice === "true")
        if (choice === "toggle") h.api!.keymap.dispatchCommand("app.toggle.paste_summary")
        refresh.resolve(json({ username: "PASTE_REFRESH", experimental: { disable_paste_summary: !disabled } }))
        await h.setup.waitFor(() => h.api!.state.config.username === "PASTE_REFRESH")
        const expected = choice === "absent" ? disabled : choice === "toggle" ? disabled : choice === "true"
        expect(title()).toBe(expected ? "Disable paste summary" : "Enable paste summary")
        h.api!.keymap.dispatchCommand("app.toggle.paste_summary")
        expect(kv.get<boolean>("paste_summary_enabled")).toBe(!expected)
        expect(title()).toBe(!expected ? "Disable paste summary" : "Enable paste summary")
        kv.set("paste_summary_enabled", undefined)
      } finally { config.resolve(json({})); refresh.resolve(json({})); await h.close() }
    })
  }
}

test("instance disposed provider confirmation joins event refresh without repeating auth or dispose", async () => {
  const config = Promise.withResolvers<Response>()
  const dispose = Promise.withResolvers<Response>()
  let configs = 0
  const h = await start({ cached: true, get: (url) => {
    if (url.pathname === "/config" && ++configs > 1) return config.promise
    if (url.pathname === "/provider") return json({ all: [{ id: "test", name: "Test", models: {} }], default: {}, connected: ["test"] })
    if (url.pathname === "/auth/test") return json(true)
  }, post: (url) => {
    if (url.pathname === "/instance/dispose") return dispose.promise
  } })
  try {
    await h.ready()
    h.api!.keymap.dispatchCommand("provider.connect")
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Connect a provider"))
    h.setup.mockInput.pressEnter()
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "API key") && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("fixture-only-not-a-real-credential")
    h.setup.mockInput.pressEnter()
    await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/instance/dispose"))
    instanceDisposed(h)
    await h.setup.waitFor(() => configs === 2)
    dispose.resolve(json(true))
    await Bun.sleep(40)
    expect(configs).toBe(2)
    config.resolve(json({ username: "CONNECTED" }))
    await h.setup.waitFor(() => h.api!.state.config.username === "CONNECTED" && !hasText(h.setup.renderer.root, "API key"))
    expect(h.requests.filter((url) => url.pathname === "/auth/test")).toHaveLength(1)
    expect(h.requests.filter((url) => url.pathname === "/instance/dispose")).toHaveLength(1)
    expect(configs).toBe(2)
    expect(h.executions).toHaveLength(0)
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
  } finally { config.resolve(json({})); dispose.resolve(json(true)); await h.close() }
})

// TC-034/035: distinct notifications in one delivery batch invalidate one read;
// an obsolete failure must not poison the still-pending replacement.
for (const failure of ["http", "transport"] as const) {
  test(`instance disposed batched IDs ignore obsolete ${failure} failure while fresh C is pending`, async () => {
    const old = Promise.withResolvers<Response>()
    const fresh = Promise.withResolvers<Response>()
    let configs = 0
    const h = await start({ cached: true, get: (url) => {
      if (url.pathname === "/config" && url.searchParams.get("workspace") === "C") return ++configs === 1 ? old.promise : fresh.promise
      if (url.pathname === "/session" && url.searchParams.get("workspace") === "C") return json([{ ...session("ses_C"), workspaceID: "C", directory: "/workspace-C" }])
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => configs === 1 && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      if (h.textarea().traits?.status === "SHELL") { h.setup.mockInput.pressEscape(); await h.setup.waitFor(() => h.textarea().traits?.status !== "SHELL") }
      h.textarea().setText("obsolete failure must not release C")
      h.submit()
      await h.waiting()
      // SDK delivers the first event immediately, then batches arrivals for 16ms.
      // Prime that window with an unrelated instance so these three share a flush.
      instanceDisposed(h, "A", "/workspace-A", "evt_batch_seed")
      for (const id of ["evt_batch_1", "evt_batch_2", "evt_batch_3"]) instanceDisposed(h, "C", "/workspace-C", id)
      await h.setup.waitFor(() => configs === 2)
      if (failure === "http") old.resolve(json({ message: "obsolete config unavailable" }, { status: 500 }))
      if (failure === "transport") old.reject(new Error("obsolete config transport failed"))
      await Bun.sleep(40)
      await h.setup.renderOnce()
      expect(configs).toBe(2)
      expect(h.executions).toHaveLength(0)
      expect(h.api!.state.config.username).toBe("OLD")
      expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
      expect(hasText(h.setup.renderer.root, "Waiting for startup")).toBe(true)
      fresh.resolve(json({ username: "C-after-failure", auto_approve: false }))
      await h.setup.waitFor(() => h.sends.length === 1)
      expect(h.executions).toHaveLength(1)
      expect(h.executions[0]).toMatchObject({ username: "C-after-failure", directory: "/workspace-C", auto: false })
      expect(h.sends[0].path).toBe("/session/ses_C/message")
      for (const id of ["evt_batch_1", "evt_batch_2", "evt_batch_3"]) instanceDisposed(h, "C", "/workspace-C", id)
      await Bun.sleep(40)
      expect(configs).toBe(2)
      expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
    } finally { old.resolve(json({})); fresh.resolve(json({})); await h.close() }
  })
}

test("instance disposed shutdown with dirty fallback never starts another refresh or sends", async () => {
  const candidate = Promise.withResolvers<Response>()
  const h = await start({ cached: true, get: (url) => {
    if (url.pathname === "/config" && url.searchParams.get("workspace") === "C") return candidate.promise
    return workspaceResponse(url)
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_C" })
    await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "C"))
    await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("never send after shutdown")
    h.submit()
    await h.waiting()
    instanceDisposed(h)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await h.close()
    // Finish teardown while C is still unresolved: cleanup cannot wait for old IO.
    expect(h.setup.renderer.isDestroyed).toBe(true)
    candidate.resolve(json({ username: "C-after-exit", auto_approve: true }))
    instanceDisposed(h, undefined, directory, "evt_after_exit")
    await Bun.sleep(40)
    expect(h.requests.filter((url) => url.pathname === "/config").map((url) => url.searchParams.get("workspace"))).toEqual([null, "C"])
    expect(h.executions).toHaveLength(0)
    expect(h.disposes).toBe(1)
  } finally { candidate.resolve(json({})); await h.close() }
})

// TC-015 adjacent boundary: project.current is mandatory just like path/config.
for (const endpoint of ["/config", "/config/providers", "/provider", "/agent", "/command", "/path", "/project/current"] as const) {
  for (const mode of ["message", "shell"] as const) {
    test(`workspace mandatory ${endpoint} failure persistently blocks ${mode} and home recovers`, async () => {
      const failed = Promise.withResolvers<Response>()
      const requested = Promise.withResolvers<void>()
      const h = await start({ cached: true, get: (url) => {
        if (url.searchParams.get("workspace") === "A" && url.pathname === endpoint) {
          requested.resolve()
          return failed.promise
        }
        return workspaceResponse(url)
      } })
      try {
        await h.ready()
        h.api!.route.navigate("session", { sessionID: "ses_A" })
        await requested.promise
        await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
        if (mode === "shell") await h.shell("echo retain workspace draft")
        if (mode === "message") h.textarea().setText("retain workspace draft")
        const draft = h.textarea().plainText
        h.submit()
        await h.waiting()
        failed.resolve(json({ message: `required ${endpoint} unavailable` }, { status: 500 }))
        await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
        await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
        for (const attempt of [1, 2]) {
          h.submit()
          await h.setup.renderOnce()
          expect(h.textarea().plainText).toBe(draft)
          expect(h.executions).toHaveLength(0)
          expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(true)
        }
        expect(h.api!.route.current).toMatchObject({ name: "session", params: { sessionID: "ses_A" } })
        expect(h.api!.state.config.username).toBe("OLD")
        expect(h.api!.state.path.directory).toBe(directory)
        h.api!.route.navigate("home")
        await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
        h.textarea().setText("home after workspace failure")
        h.submit()
        await h.setup.waitFor(() => h.sends.length + h.shells.length === 1)
        expect(h.creates).toHaveLength(1)
        expect(h.executions[0]).toMatchObject({ directory, username: "OLD", auto: true })
        expect(h.executions[0].url.searchParams.get("directory")).toBe(directory)
        expect(h.executions[0].url.searchParams.get("workspace")).toBeNull()
        expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
      } finally { failed.resolve(json({})); await h.close() }
    })
  }
}

for (const outcome of ["success", "failure"] as const) {
  for (const choice of ["configured", "manual", "cli"] as const) {
    test(`cancel after candidate path arrives retains complete home context: ${outcome}, ${choice}`, async () => {
      const config = Promise.withResolvers<Response>()
      const h = await start({ cached: true, args: choice === "cli" ? { auto: false } : {}, get: (url) => {
        if (url.pathname === "/config" && url.searchParams.get("workspace") === "A") return config.promise
        return workspaceResponse(url)
      } })
      try {
        await h.ready()
        h.api!.route.navigate("session", { sessionID: "ses_A" })
        await h.setup.waitFor(() => h.requests.some((url) => url.pathname.endsWith("/directories") && url.searchParams.get("workspace") === "A"))
        if (choice === "manual") h.setup.mockInput.pressKey("o", { ctrl: true })
        await h.setup.renderOnce()
        expect(h.api!.state.path.directory).toBe(directory)
        expect(h.api!.state.config.username).toBe("OLD")
        h.api!.route.navigate("home")
        await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
        h.textarea().setText("home while abandoned config is pending")
        h.submit()
        await h.setup.waitFor(() => h.sends.length === 1)
        expect(h.executions[0]).toMatchObject({ directory, username: "OLD", auto: choice === "configured" })
        expect(h.executions[0].url.searchParams.get("directory")).toBe(directory)
        expect(h.executions[0].url.searchParams.get("workspace")).toBeNull()
        if (outcome === "success") config.resolve(json({ username: "A", auto_approve: true }))
        if (outcome === "failure") config.reject(new Error("abandoned A configuration failed"))
        await new Promise<void>((resolve) => setImmediate(resolve))
        await h.setup.renderOnce()
        expect(h.api!.state.config.username).toBe("OLD")
        expect(h.api!.state.path.directory).toBe(directory)
        expect(h.auto()).toBe(choice === "configured")
        expect(h.sends).toHaveLength(1)
        expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
      } finally { config.resolve(json({})); await h.close() }
    })
  }
}

for (const order of ["old-first", "new-first"] as const) {
  test(`A to B to C commits only C with ${order} configuration responses`, async () => {
    const b = Promise.withResolvers<Response>()
    const c = Promise.withResolvers<Response>()
    const h = await start({ cached: true, get: (url) => {
      if (url.pathname === "/config" && url.searchParams.get("workspace") === "B") return b.promise
      if (url.pathname === "/config" && url.searchParams.get("workspace") === "C") return c.promise
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.api!.state.config.username === "A")
      h.api!.route.navigate("session", { sessionID: "ses_B" })
      await h.setup.waitFor(() => h.requests.some((url) => url.pathname.endsWith("/directories") && url.searchParams.get("workspace") === "B"))
      expect(h.api!.state.path.directory).toBe("/workspace-A")
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "C"))
      await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      h.textarea().setText("C only")
      h.submit()
      await h.waiting()
      if (order === "old-first") {
        b.resolve(json({ username: "B", auto_approve: true }))
        await new Promise<void>((resolve) => setImmediate(resolve))
        await h.setup.renderOnce()
        expect(h.executions).toHaveLength(0)
        expect(h.api!.state.config.username).toBe("A")
      }
      c.resolve(json({ username: "C", auto_approve: false }))
      await h.setup.waitFor(() => h.sends.length === 1)
      b.resolve(json({ username: "B", auto_approve: true }))
      await new Promise<void>((resolve) => setImmediate(resolve))
      await h.setup.renderOnce()
      expect(h.sends[0]).toMatchObject({ path: "/session/ses_C/message", auto: false })
      expect(h.executions[0]).toMatchObject({ directory: "/workspace-C", username: "C", auto: false })
      expect(h.api!.state.config.username).toBe("C")
      expect(h.api!.state.path.directory).toBe("/workspace-C")
      expect(h.sends).toHaveLength(1)
      h.api!.route.navigate("home")
      await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      h.textarea().setText("new session in committed C")
      h.submit()
      await h.setup.waitFor(() => h.creates.length === 1 && h.sends.length === 2)
      expect(h.executions[1].url.searchParams.get("workspace")).toBe("C")
      expect(h.executions[1].url.searchParams.get("directory")).toBe("/workspace-C")
      expect(h.executions[1]).toMatchObject({ directory: "/workspace-C", username: "C", auto: false })
    } finally { b.resolve(json({})); c.resolve(json({})); await h.close() }
  })
}

for (const choice of ["configured", "manual", "cli"] as const) {
  test(`successful workspace switch and return to local keep ${choice} permissions consistent`, async () => {
    const config = Promise.withResolvers<Response>()
    const h = await start({ cached: true, args: choice === "cli" ? { auto: false } : {}, get: (url) => {
      if (url.pathname === "/config" && url.searchParams.get("workspace") === "A") return config.promise
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "A"))
      await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      if (choice === "manual") h.setup.mockInput.pressKey("o", { ctrl: true })
      await h.shell("echo successful switch")
      h.submit()
      await h.waiting()
      config.resolve(json({ username: "A", auto_approve: true }))
      await h.setup.waitFor(() => h.shells.length === 1)
      expect(h.executions[0]).toMatchObject({ directory: "/workspace-A", username: "A", auto: choice === "configured" })
      expect(h.shells[0].path).toBe("/session/ses_A/shell")
      h.api!.route.navigate("session", { sessionID: "ses_existing" })
      await h.setup.waitFor(() => h.api!.state.config.username === "OLD" && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      h.textarea().setText("back to local")
      h.submit()
      await h.setup.waitFor(() => h.sends.length === 1)
      expect(h.executions[1]).toMatchObject({ directory, username: "OLD", auto: choice === "configured" })
      expect(h.sends[0].path).toBe("/session/ses_existing/message")
    } finally { config.resolve(json({})); await h.close() }
  })
}

test("unprepared workspace permission requests cannot inherit old auto approval and manual reply targets their session", async () => {
  const config = Promise.withResolvers<Response>()
  const h = await start({ cached: true, get: (url) => {
    if (url.pathname === "/config" && url.searchParams.get("workspace") === "A") return config.promise
    return workspaceResponse(url)
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_A" })
    await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "A"))
    config.resolve(json({ message: "workspace A unavailable" }, { status: 500 }))
    await h.setup.waitFor(() => h.api!.state.session.get("ses_A") !== undefined)
    expect(h.auto()).toBe(true)
    h.events.emit({ directory: "/workspace-A", project: "project", workspace: "A", payload: {
      id: "evt_permission_A", type: "permission.asked", properties: {
        id: "per_A", sessionID: "ses_A", permission: "bash", patterns: ["echo test"], always: [], metadata: {},
      },
    } })
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Permission required"))
    expect(h.replies).toHaveLength(0)
    h.setup.mockInput.pressEnter()
    await h.setup.waitFor(() => h.replies.length === 1)
    expect(h.replies[0].url.searchParams.get("workspace")).toBe("A")
    expect(h.replies[0].url.searchParams.get("directory")).toBe("/workspace-A")
    expect(h.replies[0].body).toMatchObject({ reply: "once" })
    expect(h.api!.state.path.directory).toBe(directory)
    expect(h.executions).toHaveLength(0)
  } finally { config.resolve(json({})); await h.close() }
})

test("reopening the same workspace after a failed configuration prepares it afresh", async () => {
  let configurations = 0
  const h = await start({ cached: true, get: (url) => {
    if (url.pathname === "/config" && url.searchParams.get("workspace") === "A" && ++configurations === 1) {
      return json({ message: "first visit failed" }, { status: 500 })
    }
    return workspaceResponse(url)
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_A" })
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed") && h.api!.state.session.get("ses_A") !== undefined)
    h.api!.route.navigate("home")
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Startup failed"))
    h.api!.route.navigate("session", { sessionID: "ses_A" })
    await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("retry prepared workspace")
    h.submit()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(configurations).toBe(2)
    expect(h.executions[0]).toMatchObject({ directory: "/workspace-A", username: "A", auto: false })
    expect(h.sends[0].path).toBe("/session/ses_A/message")
    expect(h.creates).toHaveLength(0)
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
  } finally { await h.close() }
})

// DEC-008: directory discovery is optional metadata, not a mandatory config gate.
test("optional workspace directories failure still commits the candidate and sends once", async () => {
  const metadata = Promise.withResolvers<Response>()
  const h = await start({ cached: true, get: (url) => {
    if (url.pathname.endsWith("/directories") && url.searchParams.get("workspace") === "A") return metadata.promise
    return workspaceResponse(url)
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_A" })
    await h.setup.waitFor(() => h.requests.some((url) => url.pathname.endsWith("/directories") && url.searchParams.get("workspace") === "A"))
    await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("send without directory metadata")
    h.submit()
    await h.waiting()
    expect(h.executions).toHaveLength(0)
    expect(h.api!.state.path.directory).toBe(directory)
    expect(h.api!.state.config.username).toBe("OLD")
    metadata.resolve(json({ message: "optional directory metadata unavailable" }, { status: 500 }))
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0]).toMatchObject({ path: "/session/ses_A/message", auto: false })
    expect(h.executions[0]).toMatchObject({ directory: "/workspace-A", username: "A", auto: false })
    expect(h.creates).toHaveLength(0)
    expect(h.shells).toHaveLength(0)
    expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
  } finally { metadata.resolve(json([])); await h.close() }
})

async function selectHomeWorkspace(h: Awaited<ReturnType<typeof start>>) {
  h.api!.keymap.dispatchCommand("workspace.set")
  await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Choose workspace"))
  h.setup.mockInput.pressArrow("down") // None -> A, using the real selection dialog.
  h.setup.mockInput.pressEnter()
  await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
}

for (const mode of ["message", "shell"] as const) {
  for (const destination of ["home", "local"] as const) {
    test(`Home selected workspace failure blocks retry, leaves for ${destination}, reenters: ${mode}`, async () => {
      let configurations = 0
      const h = await start({ cached: true, workspaces: true, get: (url) => {
        if (url.pathname === "/config" && url.searchParams.get("workspace") === "A" && ++configurations === 1) {
          return json({ message: "selected workspace failed" }, { status: 500 })
        }
        return workspaceResponse(url)
      } })
      try {
        await h.ready()
        await selectHomeWorkspace(h)
        if (mode === "shell") await h.shell("echo home candidate")
        if (mode === "message") h.textarea().setText("home candidate")
        const draft = h.textarea().plainText
        h.submit()
        await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed") && !hasText(h.setup.renderer.root, "Waiting for startup"))
        for (const attempt of [1, 2]) {
          h.submit()
          await h.setup.renderOnce()
          expect(h.textarea().plainText).toBe(draft)
          expect(h.executions).toHaveLength(0)
          expect(configurations).toBe(1)
          expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(true)
        }
        h.api!.route.navigate("session", { sessionID: "ses_existing" })
        await h.setup.waitFor(() => h.api!.state.session.get("ses_existing") !== undefined && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
        if (destination === "home") {
          h.api!.route.navigate("home")
          await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
        }
        if (h.textarea().traits?.status === "SHELL") {
          h.setup.mockInput.pressEscape()
          await h.setup.waitFor(() => h.textarea().traits?.status !== "SHELL")
        }
        h.textarea().setText("unrelated local submission")
        h.submit()
        await h.setup.waitFor(() => h.sends.length === 1)
        expect(h.executions[0]).toMatchObject({ directory, username: "OLD", auto: true })
        expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
        h.api!.route.navigate("home")
        await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
        await selectHomeWorkspace(h)
        h.textarea().setText("reenter selected A")
        h.submit()
        await h.setup.waitFor(() => h.sends.length === 2)
        expect(configurations).toBe(2)
        const create = h.executions.findLast((item) => item.url.pathname === "/session")!
        expect(create.url.searchParams.get("workspace")).toBe("A")
        expect(create.url.searchParams.get("directory")).toBe("/workspace-A")
        expect(create).toMatchObject({ username: "A", auto: false })
        expect(h.shells).toHaveLength(0)
      } finally { await h.close() }
    })
  }
}

for (const cancel of ["escape", "navigate", "exit"] as const) {
  test(`Home selected workspace pending preparation is cancelled by ${cancel}`, async () => {
    const config = Promise.withResolvers<Response>()
    const h = await start({ cached: true, workspaces: true, get: (url) => {
      if (url.pathname === "/config" && url.searchParams.get("workspace") === "A") return config.promise
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      await selectHomeWorkspace(h)
      if (cancel === "escape") await h.shell("echo cancelled candidate")
      if (cancel !== "escape") h.textarea().setText("cancelled candidate")
      h.submit()
      await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "A"))
      if (cancel === "escape") {
        h.setup.mockInput.pressEscape()
        await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Waiting for startup"))
      }
      if (cancel === "navigate") h.api!.route.navigate("session", { sessionID: "ses_existing" })
      if (cancel === "exit") h.setup.renderer.destroy()
      config.resolve(json({ username: "A", auto_approve: false }))
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (cancel !== "exit") {
        await h.setup.renderOnce()
        expect(h.api!.state.config.username).toBe("OLD")
        if (cancel === "escape") {
          expect(h.textarea().plainText).toBe("echo cancelled candidate")
          expect(h.textarea().traits?.status).toBe("SHELL")
          h.setup.mockInput.pressEscape()
          await h.setup.waitFor(() => h.textarea().traits?.status !== "SHELL")
        }
      }
      expect(h.executions).toHaveLength(0)
    } finally { config.resolve(json({})); await h.close() }
  })
}

async function deleteWorkspace(h: Awaited<ReturnType<typeof start>>, entry: "list" | "recovery") {
  if (entry === "recovery") {
    h.events.emit({ directory: "/workspace-A", project: "project", payload: {
      id: "evt_disconnected_A", type: "workspace.status", properties: { workspaceID: "A", status: "disconnected" },
    } })
  }
  h.api!.keymap.dispatchCommand(entry === "list" ? "workspace.list" : "session.list")
  await h.setup.waitFor(() => hasText(h.setup.renderer.root, entry === "list" ? "Workspaces" : "Sessions"))
  h.api!.keymap.dispatchCommand("session.delete")
  await h.setup.renderOnce()
  h.api!.keymap.dispatchCommand("session.delete")
  if (entry === "recovery") {
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Failed to Delete Session"))
    h.setup.mockInput.pressEnter()
    h.setup.mockInput.pressEnter() // Recovery confirmation must not duplicate DELETE.
  }
  await h.setup.waitFor(() => h.deletions.some((url) => url.pathname === "/experimental/workspace/A"))
}

for (const entry of ["list", "recovery"] as const) {
  for (const outcome of ["success", "http-failure", "rejection"] as const) {
    for (const next of ["C-pending", "C-ready", "local"] as const) {
      test(`late workspace DELETE ${entry} ${outcome} cannot replace ${next}`, async () => {
        const deleted = Promise.withResolvers<Response>()
        const config = Promise.withResolvers<Response>()
        const h = await start({ cached: true, remove: (url) => {
          if (url.pathname.startsWith("/session/")) return json({ message: "disconnected" }, { status: 500 })
          return deleted.promise
        }, get: (url) => {
          if (url.pathname === "/config" && url.searchParams.get("workspace") === "C") return config.promise
          return workspaceResponse(url)
        } })
        try {
          await h.ready()
          if (entry === "recovery") {
            h.api!.route.navigate("session", { sessionID: "ses_A" })
            await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
          }
          await deleteWorkspace(h, entry)
          h.setup.mockInput.pressEscape()
          await h.setup.waitFor(() => !hasText(h.setup.renderer.root, entry === "list" ? "Workspaces" : "Failed to Delete Session"))
          h.api!.route.navigate("session", { sessionID: next === "local" ? "ses_existing" : "ses_C" })
          if (next !== "local") await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "C"))
          if (next === "local") await h.setup.waitFor(() => h.api!.state.config.username === "OLD" && h.api!.state.session.get("ses_existing") !== undefined)
          await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
          h.textarea().setText("new route must survive old deletion")
          h.submit()
          if (next !== "local") await h.waiting()
          if (next === "C-ready") config.resolve(json({ username: "C", auto_approve: false }))
          if (next !== "C-pending") await h.setup.waitFor(() => h.sends.length === 1)
          const localConfigs = h.requests.filter((url) => url.pathname === "/config" && !url.searchParams.has("workspace")).length
          if (outcome === "success") deleted.resolve(json(true))
          if (outcome === "http-failure") deleted.resolve(json({ message: "old delete failed" }, { status: 500 }))
          if (outcome === "rejection") deleted.reject(new Error("old DELETE transport failed"))
          await new Promise<void>((resolve) => setImmediate(resolve))
          await h.setup.renderOnce()
          if (next === "C-pending") {
            expect(h.executions).toHaveLength(0)
            expect(hasText(h.setup.renderer.root, "Waiting for startup")).toBe(true)
            config.resolve(json({ username: "C", auto_approve: false }))
          }
          await h.setup.waitFor(() => h.sends.length === 1)
          expect(h.api!.route.current).toMatchObject({ name: "session", params: { sessionID: next === "local" ? "ses_existing" : "ses_C" } })
          expect(h.executions[0]).toMatchObject({ directory: next === "local" ? directory : "/workspace-C", username: next === "local" ? "OLD" : "C" })
          expect(h.requests.filter((url) => url.pathname === "/config" && !url.searchParams.has("workspace"))).toHaveLength(localConfigs)
          if (next !== "local") expect(h.requests.filter((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "C")).toHaveLength(1)
          expect(h.deletions.filter((url) => url.pathname === "/experimental/workspace/A")).toHaveLength(1)
          expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
          expect(hasText(h.setup.renderer.root, "Failed to delete workspace")).toBe(false)
          expect(hasText(h.setup.renderer.root, "Sessions")).toBe(false)
          expect(h.creates).toHaveLength(0)
          expect(h.shells).toHaveLength(0)
        } finally { deleted.resolve(json(true)); config.resolve(json({})); await h.close() }
      })
    }
  }
}

for (const entry of ["list", "recovery"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`current workspace DELETE ${entry} restores complete local context: ${outcome}`, async () => {
      const local = Promise.withResolvers<Response>()
      let removed = false
      const h = await start({ cached: true, remove: (url) => {
        if (url.pathname.startsWith("/session/")) return json({ message: "disconnected" }, { status: 500 })
        removed = true
        return json(true)
      }, get: (url) => {
        if (removed && url.pathname === "/config" && !url.searchParams.has("workspace")) return local.promise
        if (removed && url.pathname === "/experimental/workspace") return json([{ id: "C", name: "C", type: "worktree", directory: "/workspace-C" }])
        if (removed && url.pathname === "/experimental/workspace/status") return json([{ workspaceID: "C", status: "connected" }])
        return workspaceResponse(url)
      } })
      try {
        await h.ready()
        h.api!.route.navigate("session", { sessionID: "ses_A" })
        await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
        await deleteWorkspace(h, entry)
        await h.setup.waitFor(() => h.api!.route.current.name === "home" && h.requests.filter((url) => url.pathname === "/config" && !url.searchParams.has("workspace")).length === 2)
        h.setup.mockInput.pressEscape()
        await h.setup.waitFor(() => !hasText(h.setup.renderer.root, entry === "list" ? "Workspaces" : "Failed to Delete Session"))
        await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
        h.textarea().setText("local after deleting A")
        h.submit()
        await h.waiting()
        expect(h.executions).toHaveLength(0)
        expect(h.api!.state.config.username).toBe("A")
        expect(h.api!.state.path.directory).toBe("/workspace-A")
        local.resolve(outcome === "success" ? json({ username: "LOCAL", auto_approve: true }) : json({ message: "local unavailable" }, { status: 500 }))
        if (outcome === "success") {
          await h.setup.waitFor(() => h.sends.length === 1)
          expect(h.executions[0]).toMatchObject({ directory, username: "LOCAL", auto: true })
          expect(h.executions[0].url.searchParams.get("workspace")).toBeNull()
          expect(h.executions[0].url.searchParams.get("directory")).toBe(directory)
          expect(h.creates).toHaveLength(1)
        }
        if (outcome === "failure") {
          await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed") && !hasText(h.setup.renderer.root, "Waiting for startup"))
          for (const attempt of [1, 2]) {
            h.submit()
            await h.setup.renderOnce()
            expect(h.textarea().plainText).toBe("local after deleting A")
            expect(h.executions).toHaveLength(0)
            expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(true)
          }
          h.api!.route.navigate("session", { sessionID: "ses_C" })
          await h.setup.waitFor(() => h.api!.state.config.username === "C" && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
          h.textarea().setText("leave failed local recovery")
          h.submit()
          await h.setup.waitFor(() => h.sends.length === 1)
          expect(h.sends[0].path).toBe("/session/ses_C/message")
        }
        expect(h.deletions.filter((url) => url.pathname === "/experimental/workspace/A")).toHaveLength(1)
        expect(hasText(h.setup.renderer.root, "Sessions")).toBe(false)
        expect(h.shells).toHaveLength(0)
      } finally { local.resolve(json({})); await h.close() }
    })
  }
}

for (const choice of ["configured", "manual", "cli"] as const) {
  test(`recovery confirmation returns Sessions only after local preparation with ${choice} permissions`, async () => {
    const config = Promise.withResolvers<Response>()
    let removed = false
    const h = await start({ cached: true, args: choice === "cli" ? { auto: false } : {}, remove: (url) => {
      if (url.pathname.startsWith("/session/")) return json({ message: "disconnected" }, { status: 500 })
      removed = true
      return json(true)
    }, get: (url) => {
      if (removed && url.pathname === "/config" && !url.searchParams.has("workspace")) return config.promise
      if (removed && ["/experimental/workspace", "/experimental/workspace/status"].includes(url.pathname)) return json([])
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
      if (choice === "manual") {
        h.setup.mockInput.pressKey("o", { ctrl: true })
        h.setup.mockInput.pressKey("o", { ctrl: true })
        await h.setup.renderOnce()
        expect(h.auto()).toBe(false)
      }
      await deleteWorkspace(h, "recovery")
      await h.setup.waitFor(() => h.api!.route.current.name === "home")
      expect(hasText(h.setup.renderer.root, "Failed to Delete Session")).toBe(true)
      expect(hasText(h.setup.renderer.root, "Sessions")).toBe(false)
      expect(h.api!.state.config.username).toBe("A")
      config.resolve(json({ username: "LOCAL", auto_approve: true }))
      await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Sessions"))
      expect(h.api!.state.config.username).toBe("LOCAL")
      expect(h.auto()).toBe(choice === "configured")
      h.setup.mockInput.pressEscape()
      await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Sessions") && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      h.textarea().setText("confirmed local recovery")
      h.submit()
      await h.setup.waitFor(() => h.sends.length === 1)
      expect(h.executions[0]).toMatchObject({ directory, username: "LOCAL", auto: choice === "configured" })
      expect(h.executions[0].url.searchParams.get("workspace")).toBeNull()
      expect(h.executions[0].url.searchParams.get("directory")).toBe(directory)
      expect(h.deletions.filter((url) => url.pathname === "/experimental/workspace/A")).toHaveLength(1)
    } finally { config.resolve(json({})); await h.close() }
  })
}

for (const entry of ["list", "recovery"] as const) {
  for (const outcome of ["http-failure", "rejection"] as const) {
    test(`current workspace DELETE ${entry} reports ${outcome} without switching context`, async () => {
      const deleted = Promise.withResolvers<Response>()
      const h = await start({ cached: true, remove: (url) => {
        if (url.pathname.startsWith("/session/")) return json({ message: "disconnected" }, { status: 500 })
        return deleted.promise
      }, get: workspaceResponse })
      try {
        await h.ready()
        h.api!.route.navigate("session", { sessionID: "ses_A" })
        await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
        await deleteWorkspace(h, entry)
        if (outcome === "http-failure") deleted.resolve(json({ message: "delete denied" }, { status: 500 }))
        if (outcome === "rejection") deleted.reject(new Error("delete connection lost"))
        await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Failed to delete workspace"))
        expect(h.api!.route.current).toMatchObject({ name: "session", params: { sessionID: "ses_A" } })
        expect(h.api!.state.config.username).toBe("A")
        expect(h.api!.state.path.directory).toBe("/workspace-A")
        expect(h.requests.filter((url) => url.pathname === "/config" && !url.searchParams.has("workspace"))).toHaveLength(1)
        expect(h.executions).toHaveLength(0)
      } finally { deleted.resolve(json(true)); await h.close() }
    })
  }
}

for (const outcome of ["http-failure", "rejection"] as const) {
  test(`late session DELETE ${outcome} cannot open recovery on a new route`, async () => {
    const deleted = Promise.withResolvers<Response>()
    const h = await start({ cached: true, remove: () => deleted.promise, get: workspaceResponse })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
      h.api!.keymap.dispatchCommand("session.list")
      await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Sessions"))
      h.api!.keymap.dispatchCommand("session.delete")
      await h.setup.renderOnce()
      h.api!.keymap.dispatchCommand("session.delete")
      await h.setup.waitFor(() => h.deletions.length === 1)
      h.setup.mockInput.pressEscape()
      await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Sessions"))
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => h.api!.state.config.username === "C" && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      if (outcome === "http-failure") deleted.resolve(json({ message: "old session failed" }, { status: 500 }))
      if (outcome === "rejection") deleted.reject(new Error("old session DELETE disconnected"))
      await new Promise<void>((resolve) => setImmediate(resolve))
      await h.setup.renderOnce()
      expect(hasText(h.setup.renderer.root, "Failed to Delete Session")).toBe(false)
      h.textarea().setText("no late recovery window")
      h.submit()
      await h.setup.waitFor(() => h.sends.length === 1)
      expect(h.sends[0].path).toBe("/session/ses_C/message")
      expect(h.deletions).toHaveLength(1)
      expect(h.executions[0]).toMatchObject({ directory: "/workspace-C", username: "C" })
    } finally { deleted.resolve(json(true)); await h.close() }
  })
}

// TC-027 adjacent boundary: closing the dialog does not abort the route owner.
for (const outcome of ["http-failure", "rejection"] as const) {
  test(`late session DELETE ${outcome} cannot revive a closed dialog on the same route`, async () => {
    const deleted = Promise.withResolvers<Response>()
    const h = await start({ cached: true, remove: () => deleted.promise, get: workspaceResponse })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
      h.api!.keymap.dispatchCommand("session.list")
      await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Sessions"))
      h.api!.keymap.dispatchCommand("session.delete")
      await h.setup.renderOnce()
      h.api!.keymap.dispatchCommand("session.delete")
      await h.setup.waitFor(() => h.deletions.length === 1)
      h.setup.mockInput.pressEscape()
      await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Sessions") && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      if (outcome === "http-failure") deleted.resolve(json({ message: "closed dialog session failed" }, { status: 500 }))
      if (outcome === "rejection") deleted.reject(new Error("closed dialog DELETE disconnected"))
      await new Promise<void>((resolve) => setImmediate(resolve))
      await h.setup.renderOnce()
      expect(hasText(h.setup.renderer.root, "Failed to Delete Session")).toBe(false)
      expect(h.api!.route.current).toMatchObject({ name: "session", params: { sessionID: "ses_A" } })
      h.textarea().setText("same route remains usable")
      h.submit()
      await h.setup.waitFor(() => h.sends.length === 1)
      expect(h.sends[0].path).toBe("/session/ses_A/message")
      expect(h.deletions).toHaveLength(1)
      expect(h.deletions[0].pathname).toBe("/session/ses_A")
      expect(h.executions[0]).toMatchObject({ directory: "/workspace-A", username: "A", auto: false })
      expect(h.creates).toHaveLength(0)
      expect(h.shells).toHaveLength(0)
      expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
    } finally { deleted.resolve(json(true)); await h.close() }
  })
}

for (const entry of ["list", "recovery"] as const) {
  for (const mode of ["normal", "shell", "automatic"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      test(`deleted context ${entry} survives repeated Home navigation: ${mode} ${outcome}`, async () => {
        const local = Promise.withResolvers<Response>()
        let removed = false
        const h = await start({ cached: true, replacePrompt: mode === "automatic", remove: (url) => {
          if (url.pathname.startsWith("/session/")) return json({ message: "disconnected" }, { status: 500 })
          removed = true
          return json(true)
        }, get: (url) => {
          if (removed && url.pathname === "/config" && !url.searchParams.has("workspace")) return local.promise.then((response) => response.clone())
          return workspaceResponse(url)
        } })
        try {
          await h.ready()
          h.api!.route.navigate("session", { sessionID: "ses_A" })
          await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
          await deleteWorkspace(h, entry)
          await h.setup.waitFor(() => h.api!.route.current.name === "home")
          h.setup.mockInput.pressEscape()
          await h.setup.waitFor(() => !hasText(h.setup.renderer.root, entry === "list" ? "Workspaces" : "Failed to Delete Session"))
          for (const attempt of [1, 2]) {
            h.api!.keymap.dispatchCommand("session.new")
            await h.setup.renderOnce()
          }
          await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
          if (mode === "shell") await h.shell("pwd")
          if (mode === "normal") h.textarea().setText("never use deleted A")
          if (mode === "automatic") {
            h.prompt!.set({ input: "automatic after deletion", parts: [], mode: "normal" })
            h.prompt!.submit()
          } else h.submit()
          await h.waiting()
          expect(h.executions).toHaveLength(0)
          expect(h.api!.state.config.username).toBe("A")
          local.resolve(outcome === "success" ? json({ username: "LOCAL", auto_approve: true }) : json({ message: "local unavailable" }, { status: 500 }))
          if (outcome === "success") {
            await h.setup.waitFor(() => mode === "shell" ? h.shells.length === 1 : h.sends.length === 1)
            expect(h.creates).toHaveLength(1)
            expect(h.executions[0]).toMatchObject({ directory, username: "LOCAL", auto: true })
            expect(h.executions[0].url.searchParams.get("workspace")).toBeNull()
          }
          if (outcome === "failure") {
            await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed") && !hasText(h.setup.renderer.root, "Waiting for startup"))
            for (const attempt of [1, 2]) {
              h.submit()
              await h.setup.renderOnce()
              expect(h.executions).toHaveLength(0)
              expect(h.textarea().plainText).not.toBe("")
            }
            h.api!.keymap.dispatchCommand("session.new")
            await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
            h.textarea().setText("failure still cannot be bypassed")
            h.submit()
            await h.setup.renderOnce()
            expect(h.executions).toHaveLength(0)
            h.api!.route.navigate("session", { sessionID: "ses_C" })
            await h.setup.waitFor(() => h.api!.state.config.username === "C" && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
            await h.shell("pwd")
            h.submit()
            await h.setup.waitFor(() => h.shells.length === 1)
            expect(h.shells[0].path).toBe("/session/ses_C/shell")
            expect(h.executions[0]).toMatchObject({ directory: "/workspace-C", username: "C" })
          }
          expect(h.executions.every((item) => item.username !== "A" && item.url.searchParams.get("workspace") !== "A")).toBe(true)
        } finally { local.resolve(json({})); await h.close() }
      })
    }
  }

  test(`deleted context ${entry} rejects stale session hydration and permission replies`, async () => {
    const local = Promise.withResolvers<Response>()
    let removed = false
    const h = await start({ cached: true, remove: (url) => {
      if (url.pathname.startsWith("/session/")) return json({ message: "disconnected" }, { status: 500 })
      removed = true
      return json(true)
    }, get: (url) => {
      if (removed && url.pathname === "/config" && !url.searchParams.has("workspace")) return local.promise.then((response) => response.clone())
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
      await deleteWorkspace(h, entry)
      await h.setup.waitFor(() => h.api!.route.current.name === "home")
      h.setup.mockInput.pressEscape()
      await h.setup.waitFor(() => !hasText(h.setup.renderer.root, entry === "list" ? "Workspaces" : "Failed to Delete Session"))
      // A stale server can still return the deleted Session and connected status.
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Startup failed"))
      await h.setup.waitFor(() => h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      await h.shell("pwd")
      h.submit()
      await h.setup.renderOnce()
      expect(h.executions).toHaveLength(0)
      h.api!.keymap.dispatchCommand("permission.mode")
      h.events.emit({ directory: "/workspace-A", workspace: "A", project: "project", payload: {
        id: "evt_deleted_permission", type: "permission.asked", properties: {
          id: "per_deleted", sessionID: "ses_A", permission: "bash", patterns: ["pwd"], always: ["*"], metadata: {},
        },
      } })
      await h.setup.renderOnce()
      h.submit()
      await h.setup.renderOnce()
      expect(h.replies).toHaveLength(0)
      expect(h.executions).toHaveLength(0)
      expect(h.requests.filter((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "A")).toHaveLength(1)
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => h.api!.state.config.username === "C")
      local.resolve(json({ username: "OBSOLETE" }))
      await h.setup.renderOnce()
      expect(h.api!.state.config.username).toBe("C")
    } finally { local.resolve(json({})); await h.close() }
  })

  test(`deleted context ${entry} late success invalidates retained A without cancelling C`, async () => {
    const deleted = Promise.withResolvers<Response>()
    const local = Promise.withResolvers<Response>()
    const c = Promise.withResolvers<Response>()
    let removed = false
    const h = await start({ cached: true, remove: (url) => {
      if (url.pathname.startsWith("/session/")) return json({ message: "disconnected" }, { status: 500 })
      return deleted.promise.then((response) => { removed = true; return response })
    }, get: (url) => {
      if (removed && url.pathname === "/config" && !url.searchParams.has("workspace")) return local.promise.then((response) => response.clone())
      if (url.pathname === "/config" && url.searchParams.get("workspace") === "C") return c.promise
      return workspaceResponse(url)
    } })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
      await deleteWorkspace(h, entry)
      h.setup.mockInput.pressEscape()
      await h.setup.waitFor(() => !hasText(h.setup.renderer.root, entry === "list" ? "Workspaces" : "Failed to Delete Session"))
      h.api!.keymap.dispatchCommand("session.new")
      deleted.resolve(json(true))
      await h.setup.waitFor(() => h.requests.filter((url) => url.pathname === "/config" && !url.searchParams.has("workspace")).length === 2)
      h.textarea().setText("late deletion also revokes home")
      h.submit()
      await h.waiting()
      expect(h.executions).toHaveLength(0)
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => h.requests.some((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "C"))
      c.resolve(json({ username: "C", auto_approve: false }))
      await h.setup.waitFor(() => h.api!.state.config.username === "C" && h.api!.state.session.get("ses_C") !== undefined && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
      // The preceding stale-session scenario preserves a shell draft for C.
      // Select normal mode explicitly rather than treating that intent as a message.
      if (h.textarea().traits?.status === "SHELL") {
        h.setup.mockInput.pressEscape()
        await h.setup.waitFor(() => h.textarea().traits?.status !== "SHELL")
      }
      h.textarea().setText("C need not wait for abandoned local recovery")
      h.submit()
      await h.setup.waitFor(() => h.sends.length === 1)
      expect(h.sends[0].path).toBe("/session/ses_C/message")
      expect(h.requests.filter((url) => url.pathname === "/config" && url.searchParams.get("workspace") === "C")).toHaveLength(1)
    } finally { deleted.resolve(json(true)); local.resolve(json({})); c.resolve(json({})); await h.close() }
  })
}

async function selectWarp(h: Awaited<ReturnType<typeof start>>, entry: "restore" | "prompt") {
  if (entry === "prompt") h.api!.keymap.dispatchCommand("workspace.set")
  if (entry === "restore") {
    h.api!.keymap.dispatchCommand("session.list")
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Sessions"))
    h.api!.keymap.dispatchCommand("session.delete")
    await h.setup.renderOnce()
    h.api!.keymap.dispatchCommand("session.delete")
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Failed to Delete Session"))
    h.setup.mockInput.pressArrow("right")
    h.setup.mockInput.pressEnter()
  }
  await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Choose workspace"))
  h.setup.mockInput.pressEnter() // None/local
}

for (const entry of ["restore", "prompt"] as const) {
  for (const stage of ["warp", "reminder", "session-get"] as const) {
    for (const outcome of ["success", "failure"] as const) {
      for (const leave of ["close", "navigate"] as const) {
        test(`warp lifecycle ${entry} ${stage} late ${outcome} after ${leave}`, async () => {
          const pending = Promise.withResolvers<Response>()
          let warped = false
          let refreshing = false
          let reached = false
          const h = await start({ cached: true, workspaces: true,
            remove: () => json({ message: "disconnected" }, { status: 500 }),
            post: (url) => {
              if (url.pathname === "/experimental/workspace/warp") {
                if (stage === "warp") { reached = true; return pending.promise }
                warped = true
                return json(true)
              }
              if (url.pathname.endsWith("/prompt_async")) {
                if (stage === "reminder") { reached = true; return pending.promise }
                refreshing = true
                return json({})
              }
            }, get: (url) => {
              if (url.pathname === "/vcs/status") return json([])
              if (url.pathname === "/session/ses_A" && warped) {
                if (stage === "session-get" && refreshing) { reached = true; return pending.promise }
                return json(session("ses_A"))
              }
              return workspaceResponse(url)
            },
          })
          try {
            await h.ready()
            h.api!.route.navigate("session", { sessionID: "ses_A" })
            await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
            await selectWarp(h, entry)
            await h.setup.waitFor(() => reached)
            h.setup.mockInput.pressEnter()
            await h.setup.renderOnce()
            expect(h.requests.filter((url) => url.pathname === "/experimental/workspace/warp")).toHaveLength(1)
            h.setup.mockInput.pressEscape()
            await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Choose workspace"))
            if (leave === "navigate") {
              h.api!.route.navigate("session", { sessionID: "ses_C" })
              await h.setup.waitFor(() => h.api!.state.config.username === "C")
            }
            // Also verify preserving a new window, independently of close-only.
            if (leave === "navigate") {
              h.api!.keymap.dispatchCommand("workspace.list")
              await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Workspaces"))
            }
            const before = h.requests.length
            const sessions = ["ses_A", "ses_C"].map((id) => JSON.stringify(h.api!.state.session.get(id)))
            if (outcome === "failure" && stage === "warp" && entry === "restore") pending.resolve(json({ name: "VcsApplyError", message: "obsolete conflict" }, { status: 500 }))
            if (outcome === "failure" && !(stage === "warp" && entry === "restore")) pending.reject(new Error("obsolete warp operation failed"))
            if (outcome === "success") pending.resolve(json(stage === "session-get" ? session("ses_A") : true))
            await new Promise<void>((resolve) => setImmediate(resolve))
            await h.setup.renderOnce()
            expect(hasText(h.setup.renderer.root, "Workspaces")).toBe(leave === "navigate")
            expect(hasText(h.setup.renderer.root, "Sessions")).toBe(false)
            expect(hasText(h.setup.renderer.root, "Failed to warp session")).toBe(false)
            expect(hasText(h.setup.renderer.root, "Workspace refresh failed")).toBe(false)
            expect(hasText(h.setup.renderer.root, "Unable to Warp Session")).toBe(false)
            expect(["ses_A", "ses_C"].map((id) => JSON.stringify(h.api!.state.session.get(id)))).toEqual(sessions)
            expect(h.requests.slice(before).filter((url) => url.pathname.endsWith("/prompt_async"))).toHaveLength(0)
            expect(h.executions).toHaveLength(0)
            if (leave === "navigate") expect(h.api!.state.config.username).toBe("C")
            if (stage === "warp" && leave === "close") expect(h.api!.state.config.username).toBe("A")
          } finally { pending.resolve(json(true)); await h.close() }
        })
      }
    }
  }

  test(`warp lifecycle ${entry} completes normally through final session refresh`, async () => {
    let warped = false
    const h = await start({ cached: true, workspaces: true,
      remove: () => json({ message: "disconnected" }, { status: 500 }),
      post: (url) => {
        if (url.pathname === "/experimental/workspace/warp") { warped = true; return json(true) }
        if (url.pathname.endsWith("/prompt_async")) return json({})
      }, get: (url) => {
        if (url.pathname === "/vcs/status") return json([])
        if (warped && url.pathname === "/session/ses_A") return json(session("ses_A"))
        return workspaceResponse(url)
      },
    })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
      await selectWarp(h, entry)
      await h.setup.waitFor(() => h.api!.state.session.get("ses_A")?.workspaceID === undefined && h.api!.state.config.username === "OLD")
      await h.setup.waitFor(() => entry === "restore" ? hasText(h.setup.renderer.root, "Sessions") : !hasText(h.setup.renderer.root, "Choose workspace"))
      expect(h.requests.filter((url) => url.pathname.endsWith("/prompt_async"))).toHaveLength(1)
      expect(h.requests.filter((url) => url.pathname === "/experimental/workspace/warp")).toHaveLength(1)
      expect(hasText(h.setup.renderer.root, "Startup failed")).toBe(false)
    } finally { await h.close() }
  })
}

test("deleted context removing another workspace preserves ready C", async () => {
  const h = await start({ cached: true, workspaces: true, remove: () => json(true), get: workspaceResponse })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_C" })
    await h.setup.waitFor(() => h.api!.state.config.username === "C" && h.api!.state.session.get("ses_C") !== undefined)
    await deleteWorkspace(h, "list") // sorted list selects A, not C
    h.setup.mockInput.pressEscape()
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Workspaces") && h.setup.renderer.currentFocusedEditor instanceof TextareaRenderable)
    h.textarea().setText("C remains valid after deleting A")
    h.submit()
    await h.setup.waitFor(() => h.sends.length === 1)
    expect(h.sends[0].path).toBe("/session/ses_C/message")
    expect(h.executions[0]).toMatchObject({ username: "C", directory: "/workspace-C" })
    expect(h.requests.filter((url) => url.pathname === "/config" && !url.searchParams.has("workspace"))).toHaveLength(1)
  } finally { await h.close() }
})

test("deleted context cannot manually approve a permission queued before deletion", async () => {
  const deleted = Promise.withResolvers<Response>()
  const local = Promise.withResolvers<Response>()
  let removed = false
  const h = await start({ cached: true, remove: () => deleted.promise.then((response) => { removed = true; return response }), get: (url) => {
    if (removed && url.pathname === "/config" && !url.searchParams.has("workspace")) return local.promise
    return workspaceResponse(url)
  } })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_A" })
    await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
    await deleteWorkspace(h, "list")
    h.events.emit({ directory: "/workspace-A", workspace: "A", project: "project", payload: {
      id: "evt_queued_permission", type: "permission.asked", properties: {
        id: "per_queued", sessionID: "ses_A", permission: "bash", patterns: ["pwd"], always: ["*"], metadata: {},
      },
    } })
    deleted.resolve(json(true))
    await h.setup.waitFor(() => h.api!.route.current.name === "home")
    h.setup.mockInput.pressEscape()
    await h.setup.waitFor(() => !hasText(h.setup.renderer.root, "Workspaces"))
    h.api!.route.navigate("session", { sessionID: "ses_A" })
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Permission required") && hasText(h.setup.renderer.root, "Startup failed"))
    h.submit()
    await h.setup.renderOnce()
    expect(h.replies).toHaveLength(0)
    expect(h.executions).toHaveLength(0)
    expect(hasText(h.setup.renderer.root, "Permission required")).toBe(true)
  } finally { deleted.resolve(json(true)); local.resolve(json({})); await h.close() }
})

for (const entry of ["restore", "prompt"] as const) {
  test(`warp lifecycle ${entry} route-only navigation cancels reminder completion`, async () => {
    const reminder = Promise.withResolvers<Response>()
    const h = await start({ cached: true, workspaces: true,
      remove: () => json({ message: "disconnected" }, { status: 500 }),
      post: (url) => {
        if (url.pathname === "/experimental/workspace/warp") return json(true)
        if (url.pathname.endsWith("/prompt_async")) return reminder.promise
      }, get: (url) => url.pathname === "/vcs/status" ? json([]) : workspaceResponse(url),
    })
    try {
      await h.ready()
      h.api!.route.navigate("session", { sessionID: "ses_A" })
      await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
      await selectWarp(h, entry)
      await h.setup.waitFor(() => h.requests.some((url) => url.pathname.endsWith("/prompt_async")))
      h.api!.route.navigate("session", { sessionID: "ses_C" })
      await h.setup.waitFor(() => h.api!.state.config.username === "C")
      const before = h.requests.length
      reminder.resolve(json({}))
      await new Promise<void>((resolve) => setImmediate(resolve))
      await h.setup.renderOnce()
      expect(hasText(h.setup.renderer.root, "Choose workspace")).toBe(true)
      expect(hasText(h.setup.renderer.root, "Sessions")).toBe(false)
      expect(h.api!.state.config.username).toBe("C")
      expect(h.requests.slice(before).some((url) => url.pathname === "/session/ses_A")).toBe(false)
    } finally { reminder.resolve(json({})); await h.close() }
  })
}

test("warp lifecycle file changes confirmation hands off to the current dialog generation", async () => {
  let warped = false
  const h = await start({ cached: true, workspaces: true,
    post: (url) => {
      if (url.pathname === "/experimental/workspace/warp") { warped = true; return json(true) }
      if (url.pathname.endsWith("/prompt_async")) return json({})
    }, get: (url) => {
      if (url.pathname === "/vcs/status") return json([{ file: "README.md", status: "modified", additions: 1, deletions: 0 }])
      if (warped && url.pathname === "/session/ses_A") return json(session("ses_A"))
      return workspaceResponse(url)
    },
  })
  try {
    await h.ready()
    h.api!.route.navigate("session", { sessionID: "ses_A" })
    await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
    await selectWarp(h, "prompt")
    await h.setup.waitFor(() => hasText(h.setup.renderer.root, "File Changes Found"))
    h.setup.mockInput.pressEnter()
    await h.setup.waitFor(() => h.api!.state.session.get("ses_A")?.workspaceID === undefined && h.api!.state.config.username === "OLD")
    expect(h.requests.filter((url) => url.pathname.endsWith("/prompt_async"))).toHaveLength(1)
    expect(h.requests.filter((url) => url.pathname === "/experimental/workspace/warp")).toHaveLength(1)
  } finally { await h.close() }
})

// TC-031 adjacent: replace alone must revoke the operation, without Escape or
// route cancellation masking a missing dialog generation guard.
for (const entry of ["restore", "prompt"] as const) {
  for (const stage of ["reminder", "session-list"] as const) {
    test(`warp lifecycle ${entry} direct replacement during ${stage} preserves the new window and sessions`, async () => {
      const pending = Promise.withResolvers<Response>()
      let refreshing = false
      let reached = false
      const h = await start({ cached: true, workspaces: true,
        remove: () => json({ message: "disconnected" }, { status: 500 }),
        post: (url) => {
          if (url.pathname === "/experimental/workspace/warp") return json(true)
          if (url.pathname.endsWith("/prompt_async")) {
            if (stage === "reminder") { reached = true; return pending.promise }
            refreshing = true
            return json({})
          }
        }, get: (url) => {
          if (url.pathname === "/vcs/status") return json([])
          if (refreshing && url.pathname === "/session") { reached = true; return pending.promise }
          return workspaceResponse(url)
        },
      })
      try {
        await h.ready()
        h.api!.route.navigate("session", { sessionID: "ses_A" })
        await h.setup.waitFor(() => h.api!.state.config.username === "A" && h.api!.state.session.get("ses_A") !== undefined)
        await selectWarp(h, entry)
        await h.setup.waitFor(() => reached)
        h.api!.keymap.dispatchCommand("workspace.list")
        await h.setup.waitFor(() => hasText(h.setup.renderer.root, "Workspaces") && !hasText(h.setup.renderer.root, "Choose workspace"))
        const before = h.requests.length
        const sessions = ["ses_A", "ses_existing"].map((id) => JSON.stringify(h.api!.state.session.get(id)))
        pending.resolve(json(stage === "session-list" ? [session("ses_obsolete_refresh")] : {}))
        await new Promise<void>((resolve) => setImmediate(resolve))
        await h.setup.renderOnce()
        expect(h.api!.route.current).toMatchObject({ name: "session", params: { sessionID: "ses_A" } })
        expect(hasText(h.setup.renderer.root, "Workspaces")).toBe(true)
        expect(hasText(h.setup.renderer.root, "Sessions")).toBe(false)
        expect(hasText(h.setup.renderer.root, "Workspace refresh failed")).toBe(false)
        expect(h.api!.state.session.get("ses_obsolete_refresh")).toBeUndefined()
        expect(["ses_A", "ses_existing"].map((id) => JSON.stringify(h.api!.state.session.get(id)))).toEqual(sessions)
        expect(h.requests.slice(before).filter((url) => url.pathname === "/session" || url.pathname === "/session/ses_A")).toHaveLength(0)
        expect(h.requests.filter((url) => url.pathname === "/experimental/workspace/warp")).toHaveLength(1)
        expect(h.requests.filter((url) => url.pathname.endsWith("/prompt_async"))).toHaveLength(1)
        expect(h.executions).toHaveLength(0)
      } finally { pending.resolve(json([])); await h.close() }
    })
  }
}
