/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createBindingLookup } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { TuiKeybind } from "../../src/config/keybind"
import { LEADER_TOKEN, registerOpencodeKeymap } from "../../src/keymap"
import { Selection } from "../../src/util/selection"

async function mount(copyOnSelectDisabled: boolean) {
  const writes: string[] = []
  let changes = 0
  let textarea: TextareaRenderable | undefined
  let activeKeymap: ReturnType<typeof createDefaultOpenTuiKeymap> | undefined

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    activeKeymap = keymap
    const keybinds = TuiKeybind.parse({})
    const config = {
      keybinds: createBindingLookup(TuiKeybind.toBindingConfig(keybinds), {
        commandMap: TuiKeybind.CommandMap,
        bindingDefaults: TuiKeybind.bindingDefaults(),
      }),
      leader_timeout: 2000,
    }
    const offKeymap = registerOpencodeKeymap(keymap, renderer, config)
    const offLeaderBinding = keymap.registerLayer({
      commands: [{ name: "session.new", run() {} }],
      bindings: config.keybinds.gather("test", ["session.new"]),
    })
    const offSelection = Selection.registerKeyHandler(
      keymap,
      renderer,
      { show: () => {}, error: () => {} },
      {
        write: async (text) => {
          writes.push(text)
        },
      },
      copyOnSelectDisabled,
    )
    onCleanup(() => {
      offSelection()
      offLeaderBinding()
      offKeymap()
    })

    return (
      <textarea
        initialValue="draft"
        ref={(renderable: TextareaRenderable) => {
          textarea = renderable
        }}
        onContentChange={() => changes++}
      />
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  if (!textarea || !activeKeymap) {
    app.renderer.destroy()
    throw new Error("expected textarea and keymap")
  }
  await app.renderOnce()
  textarea.focus()

  return {
    app,
    keymap: activeKeymap,
    textarea,
    writes,
    changes: () => changes,
  }
}

function selectLastCharacter(textarea: TextareaRenderable) {
  textarea.cursorOffset = textarea.plainText.length
  return textarea.moveCursorLeft({ select: true })
}

test("cuts an OpenTUI textarea selection and preserves leader fallback", async () => {
  const harness = await mount(false)
  try {
    expect(selectLastCharacter(harness.textarea)).toBe(true)
    expect(harness.textarea.getSelectedText()).toBe("t")
    expect(harness.app.renderer.currentFocusedRenderable).toBe(harness.textarea)
    expect(harness.app.renderer.getSelection()?.selectedRenderables).toEqual([harness.textarea])

    harness.app.mockInput.pressKey("x", { ctrl: true })
    expect(harness.writes).toEqual(["t"])
    expect(harness.textarea.plainText).toBe("draf")
    expect(harness.textarea.hasSelection()).toBe(false)
    expect(harness.app.renderer.getSelection()).toBeNull()
    expect(harness.changes()).toBe(1)

    expect(harness.textarea.undo()).toBe(true)
    expect(harness.textarea.plainText).toBe("draft")
    harness.textarea.clearSelection()

    harness.app.mockInput.pressKey("x", { ctrl: true })
    expect(harness.keymap.getPendingSequence()[0]?.tokenName).toBe(LEADER_TOKEN)
    expect(harness.textarea.plainText).toBe("draft")

    expect(selectLastCharacter(harness.textarea)).toBe(true)
    harness.app.mockInput.pressKey("x", { ctrl: true })
    expect(harness.writes).toEqual(["t", "t"])
    expect(harness.textarea.plainText).toBe("draf")
    expect(harness.keymap.getPendingSequence()).toEqual([])
  } finally {
    harness.app.renderer.destroy()
  }
})

test("explicit copy mode preserves ctrl+c and escape selection behavior", async () => {
  const harness = await mount(true)
  try {
    harness.app.mockInput.pressKey("x", { ctrl: true })
    expect(harness.keymap.getPendingSequence()[0]?.tokenName).toBe(LEADER_TOKEN)

    expect(selectLastCharacter(harness.textarea)).toBe(true)
    harness.app.mockInput.pressKey("c", { ctrl: true })
    expect(harness.writes).toEqual(["t"])
    expect(harness.textarea.plainText).toBe("draft")
    expect(harness.textarea.hasSelection()).toBe(false)
    expect(harness.app.renderer.getSelection()).toBeNull()
    expect(harness.keymap.getPendingSequence()).toEqual([])

    harness.app.mockInput.pressKey("x", { ctrl: true })
    expect(harness.keymap.getPendingSequence()[0]?.tokenName).toBe(LEADER_TOKEN)

    expect(selectLastCharacter(harness.textarea)).toBe(true)
    harness.app.mockInput.pressEscape()
    expect(harness.writes).toEqual(["t"])
    expect(harness.textarea.plainText).toBe("draft")
    expect(harness.textarea.hasSelection()).toBe(false)
    expect(harness.app.renderer.getSelection()).toBeNull()
    expect(harness.keymap.getPendingSequence()).toEqual([])
  } finally {
    harness.app.renderer.destroy()
  }
})
