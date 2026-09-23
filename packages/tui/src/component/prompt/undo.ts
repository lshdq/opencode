import { resolveRenderLib, type ExtmarksController, type TextareaRenderable } from "@opentui/core"

export const PROMPT_UNDO_LIMIT = 256
export const PROMPT_UNDO_BYTES = 16 * 1024 * 1024

/** Application-owned history. Native checkpoints are never read or consumed. */
export function bindPromptUndo<T>(input: TextareaRenderable, capture: () => T, restore: (snapshot: T) => void) {
  const extmarks = input.extmarks as ExtmarksController
  const buffer = input.editBuffer
  const view = input.editorView
  const lib = resolveRenderLib()
  const native = {
    insertChar: buffer.insertChar.bind(buffer),
    insertText: buffer.insertText.bind(buffer),
    deleteChar: buffer.deleteChar.bind(buffer),
    deleteCharBackward: buffer.deleteCharBackward.bind(buffer),
    deleteRange: buffer.deleteRange.bind(buffer),
    deleteLine: buffer.deleteLine.bind(buffer),
    newLine: buffer.newLine.bind(buffer),
    replaceText: buffer.replaceText.bind(buffer),
    replaceTextOwned: buffer.replaceTextOwned.bind(buffer),
    setText: buffer.setText.bind(buffer),
    setTextOwned: buffer.setTextOwned.bind(buffer),
    clear: buffer.clear.bind(buffer),
    clearHistory: buffer.clearHistory.bind(buffer),
    undo: buffer.undo.bind(buffer),
    redo: buffer.redo.bind(buffer),
    canUndo: buffer.canUndo.bind(buffer),
    canRedo: buffer.canRedo.bind(buffer),
    moveCursorUp: buffer.moveCursorUp.bind(buffer),
    moveCursorDown: buffer.moveCursorDown.bind(buffer),
  }
  const cursorMethods = {
    moveCursorLeft: buffer.moveCursorLeft.bind(buffer),
    moveCursorRight: buffer.moveCursorRight.bind(buffer),
    gotoLine: buffer.gotoLine.bind(buffer),
    setCursor: buffer.setCursor.bind(buffer),
    setCursorToLineCol: buffer.setCursorToLineCol.bind(buffer),
    setCursorByOffset: buffer.setCursorByOffset.bind(buffer),
  }
  const editor = {
    deleteSelectedText: view.deleteSelectedText.bind(view),
    moveUpVisual: view.moveUpVisual.bind(view),
    moveDownVisual: view.moveDownVisual.bind(view),
  }
  const viewCursorMethods = {
    setCursorByOffset: view.setCursorByOffset.bind(view),
    gotoVisualLineEnd: view.gotoVisualLineEnd.bind(view),
    setLocalSelection: view.setLocalSelection.bind(view),
    updateLocalSelection: view.updateLocalSelection.bind(view),
  }
  // OpenTUI 0.5.10 has no public extmark-history reset. This is the sole
  // version-pinned TS adapter (not a native ABI/rope dependency); see 契约.md.
  const saveMarks = extmarks["saveSnapshot"]
  extmarks["history"].clear()
  extmarks["saveSnapshot"] = () => {}
  native.clearHistory()

  type Cursor = ReturnType<typeof buffer.getCursorPosition>
  type Navigation = { anchor: Cursor; delta: number; visual: boolean; last: Cursor }
  type State = { text: string; cursor: Cursor; metadata: T; navigation?: Navigation }
  type Entry = { before: State; textAfter: string; after?: State }
  const undo: Entry[] = []
  const redo: Entry[] = []
  const strings = new Map<string, string>()
  let navigation: Navigation | undefined
  let navigationRevision = 0

  // Capture/restore use plain metadata records. Canonicalize the actual string
  // references too: counting equal text once without sharing it would let
  // repeated A/B replacements retain 256 separately allocated large strings.
  function share<V>(value: V): V {
    if (typeof value === "string") {
      const existing = strings.get(value)
      if (existing !== undefined) return existing as V
      strings.set(value, value)
      return value
    }
    if (Array.isArray(value)) return value.map(share) as V
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, share(part)])) as V
    }
    return value
  }

  function text() {
    // EditBuffer.getText() has a 1 MiB output cap. History must not silently
    // truncate a larger draft when restoring it.
    const size = lib.textBufferGetByteSize(lib.editBufferGetTextBuffer(buffer.ptr))
    return share(lib.decoder.decode(lib.editBufferGetText(buffer.ptr, size + 1) ?? new Uint8Array()))
  }

  function state(): State {
    const cursor = buffer.getCursorPosition()
    return {
      text: text(), cursor, metadata: share(capture()),
      navigation: navigation && sameCursor(cursor, navigation.last) ? { ...navigation } : undefined,
    }
  }

  function trim() {
    // Count shared immutable strings once, including hidden paste/data URLs.
    // This is a logical retention budget, not a JS/native heap measurement.
    let retained = retention([...undo, ...redo])
    while (undo.length + redo.length > PROMPT_UNDO_LIMIT || retained.bytes > PROMPT_UNDO_BYTES) {
      if (undo.length) undo.shift()
      else if (redo.length) redo.shift()
      else break
      retained = retention([...undo, ...redo])
    }
    for (const value of strings.keys()) if (!retained.strings.has(value)) strings.delete(value)
  }

  function record<A extends unknown[]>(action: (...args: A) => void, force = false, replace = false) {
    return (...args: A) => {
      const before = state()
      action(...args)
      native.clearHistory()
      if (replace) extmarks.clear()
      const after = text()
      const cursor = buffer.getCursorPosition()
      if (!force && before.text === after && sameCursor(before.cursor, cursor)) {
        // Some native no-ops still adjust TS marks (e.g. invalid ranges).
        // They must not silently invalidate payloads or discard a redo branch.
        restore(before.metadata)
        trim()
        return
      }
      navigation = undefined
      redo.length = 0
      undo.push({ before, textAfter: after })
      trim()
    }
  }

  function reset<A extends unknown[]>(action: (...args: A) => void, marks = true) {
    return (...args: A) => {
      action(...args)
      native.clearHistory()
      undo.length = 0
      redo.length = 0
      if (marks) navigation = undefined
      strings.clear()
      extmarks["history"].clear()
      if (marks) extmarks.clear()
    }
  }

  function apply(snapshot: State) {
    input.clearSelection()
    native.setText(snapshot.text)
    extmarks.clear()
    restore(snapshot.metadata)
    // setCursor uses logical display columns, not JS UTF-16 indices, and does
    // not snap through virtual marks like setCursorByOffset does.
    buffer.setCursor(snapshot.cursor.row, snapshot.cursor.col)
    if (snapshot.navigation) {
      const path = snapshot.navigation
      buffer.setCursor(path.anchor.row, path.anchor.col)
      const move = path.visual
        ? path.delta < 0 ? editor.moveUpVisual : editor.moveDownVisual
        : path.delta < 0 ? native.moveCursorUp : native.moveCursorDown
      for (let index = 0; index < Math.abs(path.delta); index++) move()
      if (!sameCursor(buffer.getCursorPosition(), snapshot.cursor)) buffer.setCursor(snapshot.cursor.row, snapshot.cursor.col)
    }
    navigation = snapshot.navigation
    input.requestRender()
  }

  function step(backwards: boolean) {
    const from = backwards ? undo : redo
    const to = backwards ? redo : undo
    const entry = from.at(-1)
    if (!entry) return null
    // Metadata can be attached after the native insertion, or intentionally
    // removed without a text edit. Capture the departing state at this boundary.
    const current = state()
    const target = backwards ? entry.before : entry.after!
    if (backwards) entry.after = current
    else entry.before = current
    apply(target)
    from.pop()
    to.push(entry)
    trim()
    return `cursor:${target.cursor.row}:${target.cursor.col}:${target.cursor.col}`
  }

  function vertical(action: () => void, visual: boolean) {
    return () => {
      const before = buffer.getCursorPosition()
      const row = visual ? view.getVisualCursor().visualRow + view.getViewport().offsetY : before.row
      const previous = navigation?.visual === visual && sameCursor(before, navigation.last) ? navigation : undefined
      const revision = navigationRevision
      action()
      // Extmarks may explicitly reposition inside a vertical move, resetting
      // native desired-column. Do not resurrect the pre-snap anchor; the next
      // vertical move must start a new chain at the actual snapped position.
      if (navigationRevision !== revision) return
      const last = buffer.getCursorPosition()
      const next = visual ? view.getVisualCursor().visualRow + view.getViewport().offsetY : last.row
      navigation = { anchor: previous?.anchor ?? before, delta: (previous?.delta ?? 0) + next - row, visual, last }
    }
  }

  function navigate<A extends unknown[], R>(action: (...args: A) => R) {
    return (...args: A) => {
      navigationRevision++
      navigation = undefined
      return action(...args)
    }
  }

  Object.assign(buffer, {
    moveCursorLeft: navigate(cursorMethods.moveCursorLeft),
    moveCursorRight: navigate(cursorMethods.moveCursorRight),
    gotoLine: navigate(cursorMethods.gotoLine),
    setCursor: navigate(cursorMethods.setCursor),
    setCursorToLineCol: navigate(cursorMethods.setCursorToLineCol),
    setCursorByOffset: navigate(cursorMethods.setCursorByOffset),
  })
  Object.assign(view, {
    setCursorByOffset: navigate(viewCursorMethods.setCursorByOffset),
    gotoVisualLineEnd: navigate(viewCursorMethods.gotoVisualLineEnd),
    setLocalSelection: navigate(viewCursorMethods.setLocalSelection),
    updateLocalSelection: navigate(viewCursorMethods.updateLocalSelection),
  })

  Object.assign(buffer, {
    insertChar: record(native.insertChar),
    insertText: record(native.insertText),
    // Delete is an explicit logical intent even at EOF. Undo consumes that
    // intent, not the preceding paste. Other true no-ops leave history alone.
    deleteChar: record(native.deleteChar, true),
    deleteCharBackward: record(native.deleteCharBackward),
    deleteRange: record(native.deleteRange),
    deleteLine: record(native.deleteLine),
    newLine: record(native.newLine),
    // We own history, so avoid replaceText's unbounded TS _textBytes storage.
    replaceText: record(native.setText, true, true),
    replaceTextOwned: record(native.setText, true, true),
    setText: reset(native.setText),
    setTextOwned: reset(native.setText),
    clear: reset(() => native.setText("")),
    clearHistory: reset(native.clearHistory, false),
    undo: () => step(true),
    redo: () => step(false),
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
    moveCursorUp: vertical(native.moveCursorUp, false),
    moveCursorDown: vertical(native.moveCursorDown, false),
  })
  Object.assign(view, {
    deleteSelectedText: record(editor.deleteSelectedText),
    moveUpVisual: vertical(editor.moveUpVisual, true),
    moveDownVisual: vertical(editor.moveDownVisual, true),
  })

  return () => {
    undo.length = 0
    redo.length = 0
    navigation = undefined
    strings.clear()
    if (!input.isDestroyed) native.clearHistory()
    extmarks["history"].clear()
    extmarks["saveSnapshot"] = saveMarks
    Object.assign(buffer, native)
    Object.assign(buffer, cursorMethods)
    Object.assign(view, editor)
    Object.assign(view, viewCursorMethods)
  }
}

function sameCursor(a: { row: number; col: number }, b: { row: number; col: number }) {
  return a.row === b.row && a.col === b.col
}

function retention(value: unknown) {
  const strings = new Set<string>()
  const objects = new Set<object>()
  function size(item: unknown): number {
    if (typeof item === "string") {
      if (strings.has(item)) return 0
      strings.add(item)
      return item.length * 2
    }
    if (!item || typeof item !== "object" || objects.has(item)) return 8
    objects.add(item)
    return 64 + Object.values(item).reduce<number>((sum, part) => sum + size(part), 0)
  }
  return { bytes: size(value), strings }
}
