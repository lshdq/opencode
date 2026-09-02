import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { TextRenderable, type Renderable } from "@opentui/core"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("permission_mode keybind toggles auto-approve permissions", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const agents = [
    {
      name: "build",
      mode: "primary",
      permission: [],
      options: {},
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/agent") return json(agents)
    if (url.pathname === "/api/agent")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: agents })
  })
  let api: TuiPluginApi | undefined
  let disposeSlots: (() => void) | undefined
  let task: Promise<unknown> | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({
          plugin_enabled: {},
          keybinds: { permission_mode: "ctrl+o" },
        }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            setTimeout(started, 0)
          },
          async dispose() {
            disposeSlots?.()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    const plugin = api
    if (!plugin) throw new Error("expected plugin API")
    const keymap = plugin.keymap
    await setup.waitFor(
      () =>
        keymap.getCommandBindings({ visibility: "registered", commands: ["permission.mode"] }).get("permission.mode")
          ?.length === 1,
    ).catch(() => {
      throw new Error("permission.mode binding was not registered")
    })
    await setup.waitFor(() => plugin.state.ready).catch(() => {
      throw new Error("TUI state did not become ready")
    })
    plugin.ui.dialog.clear()
    await setup.waitFor(() => plugin.mode.current() === "base").catch(() => {
      throw new Error(`expected base mode, received ${plugin.mode.current()}`)
    })
    expect(
      keymap.getCommandBindings({ visibility: "active", commands: ["permission.mode"] }).get("permission.mode"),
    ).toHaveLength(1)
    await setup.waitFor(() => hasText(setup.renderer.root, "Build")).catch(() => {
      throw new Error("prompt agent label was not rendered")
    })
    expect(hasText(setup.renderer.root, "auto")).toBe(false)
    expect(
      keymap.getCommands({ visibility: "registered" }).find((command) => command.name === "permission.mode")?.title,
    ).toBe("Enable auto-approve permissions")
    setup.mockInput.pressKey("o", { ctrl: true })
    await setup.waitFor(() => hasText(setup.renderer.root, "auto")).catch(() => {
      throw new Error("auto mode label was not rendered")
    })
    expect(
      keymap.getCommands({ visibility: "registered" }).find((command) => command.name === "permission.mode")?.title,
    ).toBe("Disable auto-approve permissions")
    setup.mockInput.pressKey("o", { ctrl: true })
    await setup.waitFor(() => !hasText(setup.renderer.root, "auto")).catch(() => {
      throw new Error("auto mode label was not removed")
    })
    expect(
      keymap.getCommands({ visibility: "registered" }).find((command) => command.name === "permission.mode")?.title,
    ).toBe("Enable auto-approve permissions")

    keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await task?.catch(() => {})
    mock.restore()
  }
})

function hasText(root: Renderable, text: string): boolean {
  if (root instanceof TextRenderable && root.plainText.includes(text)) return true
  return root.getChildren().some((child) => hasText(child, text))
}
