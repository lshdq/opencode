/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Show } from "solid-js"
import { RGBA } from "@opentui/core"
import { ConfigProvider, resolve, useConfig, type Info, type Interface } from "../src/config"
import { ThemeProvider, useTheme } from "../src/context/theme"
import { Keymap } from "../src/context/keymap"
import { PromptMetadataRow } from "../src/component/prompt/metadata"
import { DialogConfig } from "../src/component/dialog-config"
import { DialogProvider, useDialog } from "../src/ui/dialog"
import { ToastProvider } from "../src/ui/toast"
import { AssistantTimestamp } from "../src/routes/session"
import { Locale } from "../src/util/locale"
import { emptyThemeSource } from "./fixture/fixture"
import { TestTuiContexts } from "./fixture/tui-environment"

test("creation timestamps distinguish today, previous day and previous year", () => {
  const now = new Date(2026, 8, 22, 0, 1).getTime()
  expect(Locale.messageTime(new Date(2026, 8, 22, 0, 0, 59).getTime(), now)).toBe("00:00:59")
  expect(Locale.messageTime(new Date(2026, 8, 21, 23, 59, 59).getTime(), now)).toBe("2026-09-21 23:59:59")
  expect(Locale.messageTime(new Date(2026, 8, 21, 23, 59, 59).getTime(), now, true)).toBe("09-21 23:59")
  expect(Locale.messageTime(new Date(2025, 8, 21, 23, 59, 59).getTime(), now, true)).toBe("2025-09-21 23:59")
})

test.each([20, 80])("real assistant timestamp renders creation time at width %s", async (width) => {
  const created = new Date(2025, 1, 3, 4, 5, 6).getTime()
  const app = await testRender(() => (
    <ConfigProvider config={resolve({}, { terminalSuspend: true })}>
      <ThemeProvider mode="dark" source={emptyThemeSource}>
        <AssistantTimestamp created={created} />
      </ThemeProvider>
    </ConfigProvider>
  ), { width, height: 2 })
  try {
    await app.waitForFrame((frame) => frame.includes("2025-02-03"))
    expect(app.captureCharFrame()).toContain(width < 26 ? "2025-02-03 04:05" : "2025-02-03 04:05:06")
  } finally { app.renderer.destroy() }
})

test.each(["dark", "light"] as const)("auto metadata renders the semantic token in %s without changing muted text", async (mode) => {
  let expected = RGBA.fromHex("#000000")
  let muted = expected
  function Metadata() {
    const theme = useTheme()
    expected = theme.text.permission.autoaccept
    muted = theme.text.muted
    return <PromptMetadataRow mode="normal" agent="Build" auto model="Model" provider="Provider" muted={false}
      highlight={theme.text.base} agentAlpha={1} modelAlpha={1} variantAlpha={1} />
  }
  const app = await testRender(() => (
    <ConfigProvider config={resolve({ theme: { mode } }, { terminalSuspend: true })}>
      <ThemeProvider mode={mode} source={emptyThemeSource}><Metadata /></ThemeProvider>
    </ConfigProvider>
  ), { width: 100, height: 2 })
  try {
    await app.waitForFrame((frame) => frame.includes("auto"))
    const spans = app.renderer.currentRenderBuffer.getSpanLines().flatMap((line) => line.spans)
    expect(spans.find((span) => span.text.includes("auto"))?.fg.toInts()).toEqual(expected.toInts())
    expect(spans.find((span) => span.text.includes("Provider"))?.fg.toInts()).toEqual(muted.toInts())
    expect(expected.toInts()).not.toEqual(muted.toInts())
  } finally { app.renderer.destroy() }
})

test("Settings key presses save the timestamp preference and a remount uses it", async () => {
  const persisted: { value: Info; writes: number } = { value: {}, writes: 0 }
  const service: Interface = {
    get: async () => persisted.value,
    update: async (change) => {
      const draft = structuredClone(persisted.value)
      change(draft)
      persisted.value = draft
      persisted.writes++
      return draft
    },
  }
  const created = new Date(2025, 1, 3, 4, 5, 6).getTime()
  let enabled = () => false
  function Harness() {
    const config = useConfig()
    const dialog = useDialog()
    enabled = () => !!config.data.session.timestamps
    Keymap.createLayer(() => ({ commands: [{ bind: "f9", run: () => dialog.replace(() => <DialogConfig current="session.timestamps" />) }] }))
    return <box><text>Ready</text><Show when={config.data.session.timestamps}><AssistantTimestamp created={created} /></Show></box>
  }
  const mount = () => testRender(() => (
    <ConfigProvider config={resolve(persisted.value, { terminalSuspend: true })} service={service}>
      <Keymap.Provider><ThemeProvider mode="dark" source={emptyThemeSource}>
        <TestTuiContexts><ToastProvider><DialogProvider><Harness /></DialogProvider></ToastProvider></TestTuiContexts>
      </ThemeProvider></Keymap.Provider>
    </ConfigProvider>
  ), { width: 90, height: 30 })
  const first = await mount()
  try {
    await first.waitForFrame((frame) => frame.includes("Ready"))
    expect(first.captureCharFrame()).not.toContain("2025-02-03")
    first.mockInput.pressKey("F9")
    await first.waitForFrame((frame) => frame.includes("Assistant timestamps"))
    first.mockInput.pressEnter()
    await first.waitFor(() => enabled())
    expect(persisted.value.session?.timestamps).toBe(true)
    expect(persisted.writes).toBe(1)
  } finally { first.renderer.destroy() }
  const second = await mount()
  try {
    await second.waitForFrame((frame) => frame.includes("2025-02-03"))
    expect(second.captureCharFrame()).toContain("2025-02-03 04:05:06")
    second.mockInput.pressKey("F9")
    await second.waitForFrame((frame) => frame.includes("Assistant timestamps"))
    second.mockInput.pressEnter()
    await second.waitFor(() => !enabled())
    expect(persisted.value.session?.timestamps).toBe(false)
  } finally { second.renderer.destroy() }
})
