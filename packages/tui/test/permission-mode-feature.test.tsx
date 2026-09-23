/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal, Show } from "solid-js"
import { ConfigProvider, resolve } from "../src/config"
import { ArgsProvider } from "../src/context/args"
import { Keymap } from "../src/context/keymap"
import { PermissionProvider, usePermission } from "../src/context/permission"

test.each([
  { auto: false, permissions: "prompt" as const, initial: "prompt" },
  { auto: false, permissions: "autoaccept" as const, initial: "autoaccept" },
  { auto: true, permissions: "prompt" as const, initial: "autoaccept" },
])("permission shortcut overrides initial mode $initial (auto=$auto) across tab scopes", async (input) => {
  let writes = 0
  let keymap!: Keymap
  const [tab, setTab] = createSignal(false)
  function Tab(props: { name: string }) {
    const permission = usePermission()
    return <text>{props.name}: {permission.mode}</text>
  }
  function Tabs() {
    keymap = Keymap.use()
    return <Show when={tab()} fallback={<Tab name="first" />}><Tab name="second" /></Show>
  }
  const app = await testRender(() => (
    <ArgsProvider auto={input.auto}>
      <ConfigProvider
        config={resolve({ session: { permissions: input.permissions } }, { terminalSuspend: true })}
        service={{ get: async () => ({}), update: async () => { writes++; return {} } }}
      >
        <Keymap.Provider><PermissionProvider><Tabs /></PermissionProvider></Keymap.Provider>
      </ConfigProvider>
    </ArgsProvider>
  ), { kittyKeyboard: true })
  try {
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`first: ${input.initial}`)
    const pop = keymap.mode.push("permission")
    app.mockInput.pressKey("F4")
    await app.renderOnce()
    const changed = input.initial === "prompt" ? "autoaccept" : "prompt"
    expect(app.captureCharFrame()).toContain(`first: ${changed}`)
    setTab(true)
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`second: ${changed}`)
    app.mockInput.pressKey("F4")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(`second: ${input.initial}`)
    expect(writes).toBe(0)
    pop()
  } finally {
    app.renderer.destroy()
  }
})
