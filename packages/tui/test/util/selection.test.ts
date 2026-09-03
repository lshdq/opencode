import { expect, test } from "bun:test"
import { Selection } from "../../src/util/selection"

test("cuts the focused editable selection", async () => {
  const writes: string[] = []
  const notifications: string[] = []
  let deleted = 0
  const target = {
    hasSelection: () => true,
    getSelectedText: () => "[Pasted ~3 lines]",
    getClipboardText: () => "first\nsecond\nthird",
    deleteSelection: () => {
      deleted++
      return true
    },
  }
  const renderer = {
    getSelection: () => ({ getSelectedText: () => "[Pasted ~3 lines]", selectedRenderables: [target] }),
    clearSelection: () => {},
    currentFocusedRenderable: target,
  }

  expect(
    Selection.cut(
      renderer,
      {
        show: (input) => notifications.push(input.message),
        error: () => {},
      },
      {
        write: async (text) => {
          writes.push(text)
        },
      },
    ),
  ).toBe(true)
  expect(deleted).toBe(1)
  expect(writes).toEqual(["first\nsecond\nthird"])
  await Promise.resolve()
  expect(notifications).toEqual(["Cut to clipboard"])
})

test("does not cut without an editable focused selection", () => {
  let writes = 0
  let deleted = 0
  const selected = { hasSelection: () => true }
  const focus = {
    hasSelection: () => false,
    getSelectedText: () => "selected",
    deleteSelection: () => {
      deleted++
      return true
    },
  }

  expect(
    Selection.cut(
      {
        getSelection: () => ({ getSelectedText: () => "selected", selectedRenderables: [selected] }),
        clearSelection: () => {},
        currentFocusedRenderable: focus,
      },
      { show: () => {}, error: () => {} },
      {
        write: async () => {
          writes++
        },
      },
    ),
  ).toBe(false)
  expect(writes).toBe(0)
  expect(deleted).toBe(0)
})

test("does not cut a selection spanning multiple renderables", () => {
  let writes = 0
  let deleted = 0
  const output = { hasSelection: () => true }
  const target = {
    hasSelection: () => true,
    getSelectedText: () => "input fragment",
    deleteSelection: () => {
      deleted++
      return true
    },
  }

  expect(
    Selection.cut(
      {
        getSelection: () => ({
          getSelectedText: () => "output fragment\ninput fragment",
          selectedRenderables: [output, target],
        }),
        clearSelection: () => {},
        currentFocusedRenderable: target,
      },
      { show: () => {}, error: () => {} },
      {
        write: async () => {
          writes++
        },
      },
    ),
  ).toBe(false)
  expect(writes).toBe(0)
  expect(deleted).toBe(0)
})

test("does not delete when clipboard writing is unavailable", () => {
  let deleted = 0
  const target = {
    hasSelection: () => true,
    getSelectedText: () => "selected",
    deleteSelection: () => {
      deleted++
      return true
    },
  }

  expect(
    Selection.cut(
      {
        getSelection: () => ({ getSelectedText: () => "selected", selectedRenderables: [target] }),
        clearSelection: () => {},
        currentFocusedRenderable: target,
      },
      { show: () => {}, error: () => {} },
      {},
    ),
  ).toBe(false)
  expect(deleted).toBe(0)
})

test("does not cut a disabled editable target", () => {
  let writes = 0
  let deleted = 0
  const target = {
    hasSelection: () => true,
    canCut: () => false,
    getSelectedText: () => "selected",
    deleteSelection: () => {
      deleted++
      return true
    },
  }

  expect(
    Selection.cut(
      {
        getSelection: () => ({ getSelectedText: () => "selected", selectedRenderables: [target] }),
        clearSelection: () => {},
        currentFocusedRenderable: target,
      },
      { show: () => {}, error: () => {} },
      {
        write: async () => {
          writes++
        },
      },
    ),
  ).toBe(false)
  expect(writes).toBe(0)
  expect(deleted).toBe(0)
})

test("reports asynchronous clipboard failures", async () => {
  const failure = new Error("clipboard failed")
  const errors: unknown[] = []
  let deleted = 0
  const target = {
    hasSelection: () => true,
    getSelectedText: () => "selected",
    deleteSelection: () => {
      deleted++
      return true
    },
  }

  expect(
    Selection.cut(
      {
        getSelection: () => ({ getSelectedText: () => "selected", selectedRenderables: [target] }),
        clearSelection: () => {},
        currentFocusedRenderable: target,
      },
      { show: () => {}, error: (error) => errors.push(error) },
      { write: () => Promise.reject(failure) },
    ),
  ).toBe(true)
  expect(deleted).toBe(1)
  await Bun.sleep(0)
  expect(errors).toEqual([failure])
})

test("ctrl+x consumes only editable selections", () => {
  let deleted = 0
  let prevented = 0
  let stopped = 0
  const target = {
    hasSelection: () => true,
    getSelectedText: () => "selected",
    deleteSelection: () => {
      deleted++
      return true
    },
  }
  const event = {
    ctrl: true,
    name: "x",
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  }

  Selection.handleSelectionKey(
    {
      getSelection: () => ({ getSelectedText: () => "selected", selectedRenderables: [target] }),
      clearSelection: () => {},
      currentFocusedRenderable: target,
    },
    { show: () => {}, error: () => {} },
    event,
    { write: async () => {} },
  )

  expect(deleted).toBe(1)
  expect(prevented).toBe(1)
  expect(stopped).toBe(1)
})

test("ctrl+x falls through without a selection", () => {
  let prevented = 0
  let stopped = 0

  Selection.handleSelectionKey(
    {
      getSelection: () => null,
      clearSelection: () => {},
      currentFocusedRenderable: null,
    },
    { show: () => {}, error: () => {} },
    {
      ctrl: true,
      name: "x",
      preventDefault: () => prevented++,
      stopPropagation: () => stopped++,
    },
    { write: async () => {} },
  )

  expect(prevented).toBe(0)
  expect(stopped).toBe(0)
})

test("ctrl+c and escape consume explicit selection events", () => {
  const writes: string[] = []
  let cleared = 0
  let prevented = 0
  let stopped = 0
  const target = { hasSelection: () => false }
  const renderer = {
    getSelection: () => ({ getSelectedText: () => "selected", selectedRenderables: [target] }),
    clearSelection: () => cleared++,
    currentFocusedRenderable: target,
  }
  const toast = { show: () => {}, error: () => {} }
  const clipboard = {
    write: async (text: string) => {
      writes.push(text)
    },
  }
  const event = (name: string) => ({
    ctrl: name === "c",
    name,
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  })

  Selection.handleSelectionKey(renderer, toast, event("c"), clipboard)
  expect(writes).toEqual(["selected"])
  expect(cleared).toBe(1)
  expect(prevented).toBe(1)
  expect(stopped).toBe(1)

  Selection.handleSelectionKey(renderer, toast, event("escape"), clipboard)
  expect(cleared).toBe(2)
  expect(prevented).toBe(2)
  expect(stopped).toBe(2)
})

test("recognizes ctrl+x from the base keyboard layout", () => {
  expect(Selection.isCutKey({ ctrl: true, name: "x" })).toBe(true)
  expect(Selection.isCutKey({ ctrl: true, name: "ч", baseCode: 120 })).toBe(true)
  expect(Selection.isCutKey({ ctrl: false, name: "x", baseCode: 120 })).toBe(false)
  expect(Selection.isCutKey({ ctrl: true, name: "ч", baseCode: 99 })).toBe(false)
  expect(Selection.isCutKey({ ctrl: true, shift: true, name: "x", baseCode: 120 })).toBe(false)
  expect(Selection.isCutKey({ ctrl: true, meta: true, name: "x", baseCode: 120 })).toBe(false)
  expect(Selection.isCutKey({ ctrl: true, option: true, name: "x", baseCode: 120 })).toBe(false)
  expect(Selection.isCutKey({ ctrl: true, super: true, name: "x", baseCode: 120 })).toBe(false)
  expect(Selection.isCutKey({ ctrl: true, hyper: true, name: "x", baseCode: 120 })).toBe(false)
})
