import { isEditBufferRenderable, type SelectionBehavior } from "@opentui/core"
import type { ClipboardService } from "../context/clipboard"

type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

type FocusableSelectionTarget = {
  hasSelection: () => boolean
  getClipboardText?: (text: string) => string
  canCut?: () => boolean
  cutSelection?: () => boolean
}

type Renderer = {
  getSelection: () => {
    getSelectedText: () => string
    selectedRenderables: FocusableSelectionTarget[]
    isStart: boolean
    behavior: SelectionBehavior
  } | null
  clearSelection: () => void
  currentFocusedRenderable?: FocusableSelectionTarget | null
  currentFocusedEditor?: FocusableSelectionTarget | null
}

type SelectionKeyEvent = {
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  option?: boolean
  super?: boolean
  hyper?: boolean
  baseCode?: number
  name: string
  preventDefault: () => void
  stopPropagation: () => void
}

export function copyOnSelectRelease(
  event: { isDragging?: boolean },
  renderer: Renderer,
  toast: Toast,
  clipboard: ClipboardService,
): boolean {
  if (!event.isDragging) return false
  return copy(renderer, toast, clipboard)
}

export function copy(renderer: Renderer, toast: Toast, clipboard: ClipboardService): boolean {
  const selection = renderer.getSelection()
  if (!selection) return false
  if (selection.isStart && selection.behavior === "cell") return false

  const text = selection.getSelectedText()
  if (!text) return false

  const focus = renderer.currentFocusedRenderable
  const clipboardText =
    focus?.getClipboardText && selection.selectedRenderables.includes(focus) ? focus.getClipboardText(text) : text

  clipboard
    .write(clipboardText)
    .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
    .catch(toast.error)

  // Copy never clears selection, including empty releases: clearing also resets multi-click history.
  return true
}

export function handleSelectionKey(
  renderer: Renderer,
  toast: Toast,
  event: SelectionKeyEvent,
  clipboard: ClipboardService,
  copyOnSelect: boolean,
) {
  if (
    event.ctrl &&
    !event.shift &&
    !event.meta &&
    !event.option &&
    !event.super &&
    !event.hyper &&
    (event.name === "x" || event.baseCode === 120 || event.baseCode === 88) &&
    cut(renderer, toast, clipboard)
  ) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  const selection = renderer.getSelection()
  if (!selection) return
  const focus = renderer.currentFocusedEditor
  const editing = focus?.hasSelection() && selection.selectedRenderables.includes(focus)

  // Kitty can report a non-Latin key name with a Latin base-layout C.
  if (event.ctrl && (event.name === "c" || event.baseCode === 99 || event.baseCode === 67)) {
    if ((copyOnSelect && !editing) || !copy(renderer, toast, clipboard)) {
      renderer.clearSelection()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    return
  }

  if (event.name === "escape") {
    const text = selection.isStart && selection.behavior === "cell" ? "" : selection.getSelectedText()
    renderer.clearSelection()
    if (!text) return
    event.preventDefault()
    event.stopPropagation()
    return
  }

  if (editing) return

  renderer.clearSelection()
}

export function cut(renderer: Renderer, toast: Toast, clipboard: ClipboardService): boolean {
  const hooks = renderer.currentFocusedEditor
  if (!hooks) return false
  const focus = hooks
  if (!isEditBufferRenderable(focus) || focus.isDestroyed || !focus.focused || hooks.canCut?.() === false) return false
  const selection = renderer.getSelection()
  if (selection && (selection.selectedRenderables.length !== 1 || selection.selectedRenderables[0] !== focus))
    return false
  if (selection?.isStart && selection.behavior === "cell") return false
  const range = focus.getSelection()
  if (!range || range.start === range.end) return false
  const text = focus.getSelectedText()
  if (!text) return false
  const before = { text: focus.plainText, start: range.start, end: range.end }
  const clipboardText = hooks.getClipboardText?.(text) ?? text
  let changed = false
  const invalidate = () => {
    changed = true
  }
  focus.editBuffer.on("content-changed", invalidate)
  focus.editBuffer.on("cursor-changed", invalidate)
  focus.on("blurred", invalidate)
  // Claim the key immediately, but only mutate after a successful clipboard write.
  void Promise.resolve()
    .then(() => clipboard.write(clipboardText))
    .then(() => {
      if (
        focus.isDestroyed ||
        renderer.currentFocusedEditor !== focus ||
        !focus.focused ||
        hooks.canCut?.() === false ||
        focus.plainText !== before.text ||
        changed
      )
        return
      const current = focus.getSelection()
      if (current?.start !== before.start || current.end !== before.end) return
      // The normal delete action also emits InputRenderable's input notification.
      if (hooks.cutSelection ? hooks.cutSelection() : focus.deleteChar())
        toast.show({ message: "Cut to clipboard", variant: "info" })
    })
    .catch(toast.error)
    .finally(() => {
      focus.editBuffer.off("content-changed", invalidate)
      focus.editBuffer.off("cursor-changed", invalidate)
      focus.off("blurred", invalidate)
    })
  return true
}

export * as Selection from "./selection"
