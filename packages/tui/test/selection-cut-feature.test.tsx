/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { ConfigProvider, resolve } from "../src/config"
import { Keymap } from "../src/context/keymap"
import { Selection } from "../src/util/selection"

async function setup(write: (text: string) => Promise<void>, singleLine = false) {
  let input!: TextareaRenderable
  let leader = () => false
  let editable = true
  const errors: unknown[] = []
  const values: string[] = []
  function Harness() {
    const renderer = useRenderer()
    const keymap = Keymap.use()
    leader = Keymap.useLeaderActive()
    Keymap.createLayer(() => ({ commands: [{ id: "app.exit", run() {} }] }))
    onCleanup(keymap.intercept("key", ({ event }) => {
      Selection.handleSelectionKey(renderer, { show() {}, error: (error) => errors.push(error) }, event, { write, read: async () => undefined }, false)
    }, { priority: 101 }))
    const ref = (value: TextareaRenderable) => {
      input = value
      Object.assign(value, { canCut: () => editable })
      value.focus()
    }
    if (singleLine) return <input value="alpha beta" onInput={(value) => values.push(value)} ref={ref} />
    return <textarea initialValue="alpha beta" ref={ref} />
  }
  const app = await testRender(() => (
    <ConfigProvider config={resolve({}, { terminalSuspend: false })}>
      <Keymap.Provider><Harness /></Keymap.Provider>
    </ConfigProvider>
  ), { kittyKeyboard: true })
  await app.renderOnce()
  return { ...app, input, leader, errors, values, disable: () => { editable = false } }
}

test("cutting a single-line input notifies its form/filter state", async () => {
  const app = await setup(async () => {}, true)
  try {
    app.input.setSelection(6, 10)
    await app.renderOnce()
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitFor(() => app.input.plainText === "alpha ")
    expect(app.values.at(-1)).toBe("alpha ")
  } finally { app.renderer.destroy() }
})

test("Ctrl+X cuts only a focused editable selection and preserves undo and leader fallback", async () => {
  const writes: string[] = []
  const app = await setup(async (text) => { writes.push(text) })
  try {
    app.input.setSelection(6, 10)
    await app.renderOnce()
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitFor(() => app.input.plainText === "alpha ")
    expect(writes).toEqual(["beta"])
    expect(app.leader()).toBe(false)
    app.mockInput.pressKey("z", { ctrl: true })
    await app.waitFor(() => app.input.plainText === "alpha beta")
    app.input.clearSelection()
    app.mockInput.pressKey("x", { ctrl: true })
    expect(app.leader()).toBe(true)
  } finally { app.renderer.destroy() }
})

test.each(["failure", "edit", "edit-and-restore", "selection", "blur", "disabled"])("pending cut does not delete after %s", async (change) => {
  const pending = Promise.withResolvers<void>()
  const writes: string[] = []
  const app = await setup(async (text) => { writes.push(text); await pending.promise })
  try {
    app.input.setSelection(6, 10)
    await app.renderOnce()
    app.mockInput.pressKey("x", { ctrl: true })
    await app.waitFor(() => writes.length === 1)
    expect(app.input.plainText).toBe("alpha beta")
    if (change === "edit") app.input.setText("new draft")
    if (change === "edit-and-restore") {
      app.input.setText("temporary edit")
      app.input.setText("alpha beta")
      app.input.setSelection(6, 10)
      await app.renderOnce()
    }
    if (change === "selection") app.input.setSelection(0, 5)
    if (change === "blur") app.input.blur()
    if (change === "disabled") app.disable()
    if (change === "failure") pending.reject(new Error("clipboard unavailable"))
    else pending.resolve()
    await app.renderOnce()
    await Bun.sleep(10)
    expect(app.input.plainText).toBe(change === "edit" ? "new draft" : "alpha beta")
    expect(app.errors.length).toBe(change === "failure" ? 1 : 0)
  } finally { pending.resolve(); app.renderer.destroy() }
})

test("Ctrl+Shift+X is not a cut and non-editor/multi-renderable selections cannot be cut", async () => {
  const writes: string[] = []
  const app = await setup(async (text) => { writes.push(text) })
  try {
    app.input.selectAll()
    await app.renderOnce()
    app.mockInput.pressKey("x", { ctrl: true, shift: true })
    await app.renderOnce()
    expect(writes).toEqual([])
    const other = { hasSelection: () => true }
    const clipboard = { write: async (text: string) => { writes.push(text) }, read: async () => undefined }
    const toast = { show() {}, error() {} }
    const renderer = {
      currentFocusedEditor: app.input,
      getSelection: () => ({ selectedRenderables: [app.input, other], getSelectedText: () => "alpha beta", isStart: false, behavior: "cell" as const }),
      clearSelection() {},
    }
    expect(Selection.cut(renderer, toast, clipboard)).toBe(false)
    expect(Selection.cut({ ...renderer, currentFocusedEditor: other }, toast, clipboard)).toBe(false)
    expect(writes).toEqual([])
  } finally { app.renderer.destroy() }
})

test("disabled selected input retains Ctrl+X leader fallback", async () => {
  const writes: string[] = []
  const app = await setup(async (text) => { writes.push(text) })
  try {
    app.input.selectAll()
    app.disable()
    app.mockInput.pressKey("x", { ctrl: true })
    await app.renderOnce()
    expect(app.leader()).toBe(true)
    expect(writes).toEqual([])
    expect(app.input.plainText).toBe("alpha beta")
  } finally { app.renderer.destroy() }
})
