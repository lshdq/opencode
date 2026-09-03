import type { ClipboardService } from "../context/clipboard"
import type { OpenTuiKeymap } from "../keymap"

type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

type FocusableSelectionTarget = {
  hasSelection: () => boolean
  canCut?: () => boolean
  getSelectedText?: () => string
  deleteSelection?: () => boolean
  getClipboardText?: (text: string) => string
}

type Renderer = {
  getSelection: () => { getSelectedText: () => string; selectedRenderables: FocusableSelectionTarget[] } | null
  clearSelection: () => void
  currentFocusedRenderable?: FocusableSelectionTarget | null
}

type SelectionKeyEvent = {
  baseCode?: number
  ctrl?: boolean
  hyper?: boolean
  meta?: boolean
  name: string
  option?: boolean
  preventDefault: () => void
  shift?: boolean
  stopPropagation: () => void
  super?: boolean
}

export function isCutKey(
  event: Pick<SelectionKeyEvent, "baseCode" | "ctrl" | "hyper" | "meta" | "name" | "option" | "shift" | "super">,
) {
  if (!event.ctrl || event.shift || event.meta || event.option || event.super || event.hyper) return false
  return event.name === "x" || event.baseCode === 120
}

export function registerKeyHandler(
  keymap: OpenTuiKeymap,
  renderer: Renderer,
  toast: Toast,
  clipboard: ClipboardService,
  copyOnSelectDisabled: boolean,
) {
  return keymap.intercept(
    "key",
    ({ event }) => {
      if (!copyOnSelectDisabled && !isCutKey(event)) return
      if (handleSelectionKey(renderer, toast, event, clipboard)) keymap.clearPendingSequence()
    },
    { priority: 1 },
  )
}

export function copy(renderer: Renderer, toast: Toast, clipboard: ClipboardService): boolean {
  const selection = renderer.getSelection()
  if (!selection) return false

  const text = selection.getSelectedText()
  if (!text) return false

  const focus = renderer.currentFocusedRenderable
  const clipboardText =
    focus?.getClipboardText && selection.selectedRenderables.includes(focus) ? focus.getClipboardText(text) : text

  clipboard
    ?.write?.(clipboardText)
    .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
    .catch(toast.error)

  renderer.clearSelection()
  return true
}

export function cut(renderer: Renderer, toast: Toast, clipboard: ClipboardService): boolean {
  const selection = renderer.getSelection()
  const focus = renderer.currentFocusedRenderable
  if (!selection || selection.selectedRenderables.length !== 1 || selection.selectedRenderables[0] !== focus) return false
  if (!focus.hasSelection()) return false
  if (focus.canCut && !focus.canCut()) return false
  if (!focus.getSelectedText || !focus.deleteSelection || !clipboard.write) return false

  const text = focus.getSelectedText()
  if (!text) return false

  const clipboardText = focus.getClipboardText ? focus.getClipboardText(text) : text
  clipboard.write(clipboardText).then(() => toast.show({ message: "Cut to clipboard", variant: "info" })).catch(toast.error)
  focus.deleteSelection()
  return true
}

export function handleSelectionKey(
  renderer: Renderer,
  toast: Toast,
  event: SelectionKeyEvent,
  clipboard: ClipboardService,
) {
  const selection = renderer.getSelection()
  if (!selection) return false

  if (event.ctrl && event.name === "c") {
    if (!copy(renderer, toast, clipboard)) {
      renderer.clearSelection()
      return false
    }

    event.preventDefault()
    event.stopPropagation()
    return true
  }

  if (isCutKey(event) && cut(renderer, toast, clipboard)) {
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  if (event.name === "escape") {
    renderer.clearSelection()
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  const focus = renderer.currentFocusedRenderable
  if (focus?.hasSelection() && selection.selectedRenderables.includes(focus)) return false

  renderer.clearSelection()
  return false
}

export * as Selection from "./selection"
