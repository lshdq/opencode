import {
  BoxRenderable,
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
} from "@opentui/core"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match, For } from "solid-js"
import path from "path"
import { useLocal } from "../../context/local"
import { useTheme, useThemes } from "../../context/theme"
import { tint } from "../../theme/color"
import { createAnimatable, tween } from "../../ui/animation"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment, useTuiLifecycle } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { Spinner } from "../spinner"
import { useClient } from "../../context/client"
import { useRoute } from "../../context/route"
import { useEvent } from "../../context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
import { normalizePromptContent, openEditor } from "../../editor"
import { useExit } from "../../context/exit"
import { promptOffsetWidth } from "../../prompt/display"
import { expandPromptInputPastedText, realignPromptInputMentions } from "../../prompt/mention"
import { parseSlashHead } from "../../prompt/parse"
import { stringWidth } from "../../util/string-width"
import { createStore, produce, unwrap } from "solid-js/store"
import { emptyPrompt, usePromptHistory, type PromptInfo, type PromptPartRef } from "../../prompt/history"
import { saveDraft, takeDraft } from "./draft-stash"
import { Skill } from "@opencode/schema/skill"
import { computePromptTraits } from "../../prompt/traits"
import { expandTrackedPastedText } from "../../prompt/part"
import { usePromptStash } from "../../prompt/stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteOption, type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import { createColors, createFrames } from "../../ui/spinner"
import { useDialog } from "../../ui/dialog"
import { DialogIntegration } from "../dialog-integration"
import { useConnected } from "../use-connected"
import { useToast } from "../../ui/toast"
import { createFadeIn } from "../../util/signal"
import { DialogSkill } from "../dialog-skill"
import { useConfig } from "../../config"
import { usePromptMove } from "./move"
import { resolvePastedAttachments } from "./local-attachment"
import { locationKey, useData } from "../../context/data"
import { useLocation } from "../../context/location"
import { Keymap, type KeymapCommand } from "../../context/keymap"
import { useInteractivity } from "../../context/interactivity"
import { abbreviateHome } from "../../runtime"
import { Slot } from "../../plugin/render"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import {
  deduplicatePromptImages,
  preserveMentionlessPromptAttachments,
  promptAttachmentLabel,
} from "../../prompt/attachment"
import { DialogImagePreview } from "../dialog-image-preview"
import { useDirectoryRecents } from "../../prompt/directory-recents"
import { directoryRecentValue } from "../../prompt/directory-completion"
import { useWorkingDirectoryActions } from "../../ui/working-directory-actions"
import { truncateFilePath } from "../../ui/file-path"
import { PromptMetadataRow } from "./metadata"
import { bindPromptUndo } from "./undo"

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  muted?: boolean
  onSubmit?: () => void
  onEmptySubmit?: () => boolean | Promise<boolean>
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const DRAFT_RETENTION_MIN_CHARS = 20
const revealedPromptMetadata = new WeakSet<object>()

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

export function PromptInterruptStatus(props: {
  armed: boolean
  animations?: boolean
  text: RGBA
  subdued: RGBA
  warning: RGBA
  flash?: RGBA
}) {
  const ignition = createAnimatable(
    { level: 0 },
    { enabled: () => props.animations ?? false, transition: tween({ duration: 0.22 }) },
  )
  createEffect(
    on(
      () => props.armed,
      (armed) => {
        if (!armed || !props.animations) return ignition.jump({ level: 0 })
        ignition.jump({ level: 0.75 })
        ignition.animate({ level: 0 })
      },
      { defer: true },
    ),
  )
  const armedColor = createMemo(() => {
    const level = ignition.value().level
    if (level === 0 || !props.flash) return props.warning
    return tint(props.warning, props.flash, level)
  })

  return (
    <text fg={props.armed ? armedColor() : props.text} wrapMode="none" truncate flexShrink={1}>
      esc{" "}
      <span style={{ fg: props.armed ? armedColor() : props.subdued }}>
        {props.armed ? "again to interrupt" : "interrupt"}
      </span>
    </text>
  )
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

function argumentSlash(input: string, commands: readonly KeymapCommand[]) {
  const head = parseSlashHead(input, /\s/)
  if (!head) return
  const command = commands.find(
    (command) =>
      command.slash?.arguments &&
      (command.slash.name === head.name || command.slash.aliases?.includes(head.name) === true),
  )
  if (!command) return
  return { command, input: head.arguments }
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const enabled = useInteractivity()
  const disabled = () => props.disabled || !enabled()
  const leader = Keymap.useLeaderActive()
  const muted = () => leader() || props.muted
  const local = useLocal()
  const paths = useTuiPaths()
  const lifecycle = useTuiLifecycle()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const client = useClient()
  const editor = useEditorContext()
  const route = useRoute()
  const data = useData()
  const directoryRecents = useDirectoryRecents()
  const keymapCommands = Keymap.useCommands()
  const currentLocation = useLocation()
  const config = useConfig().data
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => data.session.status(props.sessionID ?? ""))
  const childRunning = createMemo(() =>
    status() === "idle" && !!props.sessionID &&
    data.session.family(props.sessionID).some((id) => id !== props.sessionID && data.session.status(id) === "running"),
  )
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = Keymap.use()
  const renderer = useRenderer()
  const exit = useExit()
  const dimensions = useTerminalDimensions()
  const theme = useTheme()
  const { currentSyntax: syntax } = useThemes()
  const animationsEnabled = createMemo(() => config.animations ?? true)
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => config.prompt?.editor ?? true)
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const move = usePromptMove({
    projectID: () =>
      (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ?? data.location.info()?.project.id,
    sessionID: () => props.sessionID,
  })
  const [pendingDirectory, setPendingDirectory] = createSignal<string>()
  let directoryRequest: symbol | undefined
  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: [
      {
        id: "session.cd",
        title: "Change working directory",
        slash: { name: "cd", arguments: true },
        run: async (input) => {
          if (!input?.trim()) {
            toast.show({ message: "Directory is required", variant: "error" })
            return
          }
          const sessionID = props.sessionID
          const session = sessionID ? data.session.get(sessionID) : undefined
          const sourceProjectID = session?.projectID ?? data.location.info()?.project.id
          const value = input.trim()
          const expanded =
            value === "~" ? paths.home : value.startsWith("~/") ? path.join(paths.home, value.slice(2)) : value
          const directory = path.resolve(
            session?.location.directory ?? currentLocation.current?.directory ?? data.location.default().directory,
            expanded,
          )
          if (!sessionID) {
            const revision = composerRevision
            const request = Symbol()
            directoryRequest = request
            setPendingDirectory(directory)
            try {
              const location = await client.api.location.get({ location: { directory } }).catch((error) => {
                if (!disposed && directoryRequest === request && revision === composerRevision)
                  toast.show({ title: "Failed to change directory", message: errorMessage(error), variant: "error" })
                return undefined
              })
              if (!location || disposed || directoryRequest !== request || revision !== composerRevision) return
              if (sourceProjectID) directoryRecents.touch(sourceProjectID, location.directory)
              currentLocation.set(location)
            } finally {
              if (directoryRequest === request) {
                directoryRequest = undefined
                if (!disposed) setPendingDirectory(undefined)
              }
            }
            return
          }
          const error = await client.api.session.move({ sessionID, directory: input }).then(
            () => undefined,
            (error) => error,
          )
          if (error) {
            toast.show({ title: "Failed to change directory", message: errorMessage(error), variant: "error" })
            return
          }
          if (sourceProjectID) directoryRecents.touch(sourceProjectID, directory)
        },
      },
    ],
  }))
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const connected = useConnected()
  const hasRightContent = createMemo(() => Boolean(props.right))

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect an integration to send prompts",
      duration: 3000,
    })
    if (!connected()) {
      dialog.replace(() => <DialogIntegration />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const skillStyleId = syntax().getStyleId("extmark.skill")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on("tui.prompt.append", (evt, { directory }) => {
    if (directory !== (currentLocation.current?.directory ?? data.location.default().directory)) return
    if (!input || input.isDestroyed) return
    input.insertText(evt.data.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.cursorColor = disabled() ? theme.background.raised.base : theme.text.base
    if (config.cursor) input.cursorStyle = config.cursor
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPart: Map<number, PromptPartRef>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: emptyPrompt(),
    mode: "normal",
    extmarkToPart: new Map(),
    interrupt: 0,
  })
  let disposed = false
  let pasteQueue = Promise.resolve()
  type Submission = { controller: AbortController; revision: number; queued: boolean; started: boolean }
  let submission: Submission | undefined
  let composerRevision = 0
  function invalidateSubmission() {
    composerRevision++
    submission?.controller.abort()
    submission = undefined
  }
  onCleanup(lifecycle.add(async () => invalidateSubmission()))
  onCleanup(
    keymap.intercept("key", ({ event, consume }) => {
      if (event.name !== "escape" || !submission || !enabled() || props.visible === false) return
      invalidateSubmission()
      consume()
    }, { priority: 102 }),
  )
  createEffect(
    on([
      () => route.data.type,
      () => route.data.type === "session" ? route.data.sessionID : undefined,
      () => currentLocation.ref?.directory,
      () => props.visible,
      enabled,
    ], invalidateSubmission, { defer: true }),
  )
  createEffect(
    on(() => store.mode, () => {
      if (submission) invalidateSubmission()
    }, { defer: true }),
  )

  function enqueuePaste(run: (changed: () => boolean) => Promise<void>) {
    pasteQueue = pasteQueue
      .then(async () => {
        if (disposed || input.isDestroyed || disabled()) return
        const before = { sessionID: props.sessionID, mode: store.mode, text: input.plainText }
        await run(
          () =>
            disposed ||
            input.isDestroyed ||
            disabled() ||
            props.sessionID !== before.sessionID ||
            store.mode !== before.mode ||
            input.plainText !== before.text,
        )
      })
      .catch((error) => {
        if (!disposed) toast.error(error)
      })
    return pasteQueue
  }

  const imageAttachments = createMemo(() =>
    (deduplicatePromptImages(store.prompt.files) ?? []).filter((file) => file.uri.startsWith("data:image/")),
  )
  const imagePreviewHeight = createMemo(() => Math.max(4, Math.min(8, Math.floor(dimensions().height / 4))))
  const imagePreviewWidth = createMemo(() => imagePreviewHeight() * 2)
  const visibleImageAttachments = createMemo(() => imageAttachments().slice(0, 3))

  function openImagePreview(initial: number) {
    const images = imageAttachments()
    if (images.length === 0) return
    dialog.replace(() => <DialogImagePreview images={images} initial={initial} />)
  }

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        palette: undefined,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        palette: undefined,
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Queue prompt",
        name: "prompt.queue",
        category: "Prompt",
        run: async (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          if (!input.focused) return
          if (auto()?.visible && !auto()?.completeQueueableCommand()) return
          const handled = await submit("queue")
          if (!handled) return
          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        palette: undefined,
        run: (_input: string | undefined, event?: KeyEvent) => {
          event?.preventDefault()
          event?.stopPropagation()
          return enqueuePaste(async (changed) => {
            const content = await clipboard.read()
            if (changed()) return
            if (content?.mime.startsWith("image/")) {
              pasteAttachment({
                filename: "clipboard",
                uri: `data:${content.mime};base64,${content.data}`,
              })
              return
            }
            if (content?.mime === "text/plain") {
              await pasteInputText(content.data, changed)
            }
          })
        },
      },
      {
        title: "View image attachments",
        name: "prompt.images.view",
        category: "Prompt",
        enabled: imageAttachments().length > 0,
        run: () => openImagePreview(0),
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            void client.api.session.interrupt({
              sessionID: props.sessionID,
              resume: true,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Background blocking tools",
        name: "session.background",
        category: "Session",
        palette: undefined,
        enabled: status() === "running",
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          if (!props.sessionID) return

          void client.api.session.background({
            sessionID: props.sessionID,
          })
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slash: { name: "editor" },
        run: async () => {
          dialog.clear()

          const editorPrompt = expandPromptInputPastedText(store.prompt, store.prompt.pasted)
          const value = editorPrompt.text
          const content = await openEditor({
            renderer,
            value,
            cwd:
              (data.location.info()?.project.directory === "/" ? undefined : data.location.info()?.project.directory) ||
              data.location.default().directory ||
              paths.cwd,
          })
          if (!content) return
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          setStore("prompt", {
            ...realignPromptInputMentions(normalized, editorPrompt),
            pasted: [],
          })
          restoreExtmarksFromPrompt(store.prompt)
          input.cursorOffset = stringWidth(normalized)
        },
      },
      {
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slash: { name: "skills" },
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              location={currentLocation.ref}
              onSelect={(skill) => {
                if (store.prompt.skills?.some((item) => item.id === skill)) return
                const text = `@${skill}`
                const start = input.cursorOffset
                input.insertText(text + " ")
                const extmarkId = input.extmarks.create({
                  start,
                  end: start + promptOffsetWidth(text),
                  virtual: true,
                  styleId: skillStyleId,
                  typeId: promptPartTypeId,
                })
                setStore(
                  produce((draft) => {
                    draft.prompt.text = input.plainText
                    const skills = (draft.prompt.skills ??= [])
                    const index = skills.length
                    skills.push({
                      id: Skill.ID.make(skill),
                      mention: { start, end: start + promptOffsetWidth(text), text },
                    })
                    draft.extmarkToPart.set(extmarkId, { type: "skill", index })
                  }),
                )
              }}
            />
          ))
        },
      },
      {
        title: "Manage workspaces",
        desc: "Manage workspaces",
        name: "session.move",
        category: "Session",
        slash: { name: "worktrees" },
        run: () => {
          move.open()
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: promptCommands(),
  }))

  Keymap.createLayer(() => ({
    priority: 1,
    enabled: !disabled(),
    bindings: ["prompt.queue"],
  }))

  Keymap.createLayer(() => ({
    enabled: !disabled(),
    bindings: [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.images.view",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "prompt.skills",
      "session.interrupt",
      "session.background",
      "session.move",
    ],
  }))

  const ref: PromptRef = {
    get focused() {
      return !disabled() && input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      if (disabled()) return
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.text)
      setStore("prompt", prompt)
      restoreExtmarksFromPrompt(prompt)
      input.gotoBufferEnd()
    },
    reset() {
      resetComposer()
    },
    submit() {
      void submit()
    },
  }

  function resetComposer(preserveSubmission = false) {
    if (!preserveSubmission) invalidateSubmission()
    setStore("prompt", emptyPrompt())
    setStore("extmarkToPart", new Map())
    // Native clear owns the text, extmark and undo-history reset together.
    input.clear()
  }

  // Captured once: the session route is keyed by sessionID, so this Prompt
  // instance belongs to exactly one tab. Reading props.sessionID lazily would
  // observe the *next* route during onCleanup and stash under the wrong tab.
  const stashSessionID = props.sessionID

  onMount(() => {
    const saved = takeDraft(stashSessionID)
    if (store.prompt.text) return
    if (saved && saved.prompt.text) {
      input.setText(saved.prompt.text)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromPrompt(saved.prompt)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    invalidateSubmission()
    disposed = true
    if (store.prompt.text) {
      saveDraft(stashSessionID, { prompt: unwrap(store.prompt), cursor: input.cursorOffset })
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || disabled() || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      input.focusable = false
      return
    }

    input.focusable = true
    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromPrompt(prompt: PromptInfo) {
    invalidateSubmission()
    input.extmarks.clear()
    setStore("extmarkToPart", new Map())

    const parts = [
      ...(prompt.files ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "file" as const, index },
        styleId: fileStyleId,
      })),
      ...(prompt.agents ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "agent" as const, index },
        styleId: agentStyleId,
      })),
      ...(prompt.skills ?? []).map((part, index) => ({
        mention: part.mention,
        ref: { type: "skill" as const, index },
        styleId: skillStyleId,
      })),
      ...prompt.pasted.map((part, index) => ({
        mention: part.source,
        ref: { type: "pasted" as const, index },
        styleId: pasteStyleId,
      })),
    ]

    parts.forEach(({ mention, ref, styleId }) => {
      if (mention?.text) {
        const extmarkId = input.extmarks.create({
          start: mention.start,
          end: mention.end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, ref)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, PromptPartRef>()
        const fileExtmarks = new Map<number, NonNullable<PromptInfo["files"]>[number]>()
        const files: NonNullable<PromptInfo["files"]> = []
        const agents: NonNullable<PromptInfo["agents"]> = []
        const skills: NonNullable<PromptInfo["skills"]> = []
        const pasted: PromptInfo["pasted"] = []

        for (const extmark of allExtmarks) {
          const ref = draft.extmarkToPart.get(extmark.id)
          if (!ref) continue
          if (ref.type === "file") {
            const part = draft.prompt.files?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            files.push(part)
            fileExtmarks.set(extmark.id, part)
            continue
          }
          if (ref.type === "agent") {
            const part = draft.prompt.agents?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = agents.length
            agents.push(part)
            newMap.set(extmark.id, { type: "agent", index })
            continue
          }
          if (ref.type === "skill") {
            const part = draft.prompt.skills?.[ref.index]
            if (!part?.mention) continue
            part.mention.start = extmark.start
            part.mention.end = extmark.end
            const index = skills.length
            skills.push(part)
            newMap.set(extmark.id, { type: "skill", index })
            continue
          }
          const part = draft.prompt.pasted[ref.index]
          if (!part) continue
          part.source.start = extmark.start
          part.source.end = extmark.end
          const index = pasted.length
          pasted.push(part)
          newMap.set(extmark.id, { type: "pasted", index })
        }

        const nextFiles = preserveMentionlessPromptAttachments(draft.prompt.files, files)
        const fileIndices = new Map(nextFiles.map((file, index) => [file, index]))
        for (const [extmark, file] of fileExtmarks) {
          const index = fileIndices.get(file)
          if (index !== undefined) newMap.set(extmark, { type: "file", index })
        }

        draft.extmarkToPart = newMap
        if (
          nextFiles.length !== draft.prompt.files?.length ||
          nextFiles.some((file, index) => file !== draft.prompt.files?.[index])
        )
          draft.prompt.files = nextFiles
        draft.prompt.agents = agents
        draft.prompt.skills = skills
        draft.prompt.pasted = pasted
      }),
    )
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.text,
        run: () => {
          if (!store.prompt.text) return
          stash.push({ prompt: store.prompt })
          resetComposer()
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.prompt.text)
            setStore("prompt", entry.prompt)
            restoreExtmarksFromPrompt(entry.prompt)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.prompt.text)
                setStore("prompt", entry.prompt)
                restoreExtmarksFromPrompt(entry.prompt)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map(
      ({ name, category, ...command }) =>
        ({
          id: name,
          group: category,
          bind: false,
          palette: true as const,
          ...command,
        }) satisfies KeymapCommand,
    ),
  )

  Keymap.createLayer(() => ({
    mode: "global",
    enabled: !disabled(),
    commands: stashCommands(),
  }))

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled(),
      bindings: ["prompt.paste"],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled() && store.prompt.text !== "",
      bindings: ["prompt.clear"],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !disabled() &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      commands: [
        {
          bind: "!",
          title: "Shell mode",
          group: "Prompt",
          run: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: inputTarget() !== undefined && !disabled() && store.mode === "shell",
      commands: [
        { bind: "escape", title: "Exit shell mode", group: "Prompt", run: () => setStore("mode", "normal") },
        {
          bind: "ctrl+c",
          title: "Exit shell mode",
          group: "Prompt",
          enabled: () => store.prompt.text === "",
          run: () => setStore("mode", "normal"),
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      commands: [
        { bind: "backspace", title: "Exit shell mode", group: "Prompt", run: () => setStore("mode", "normal") },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.previous",
          title: "Previous prompt history",
          group: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) {
                input.cursorOffset = 0
                return
              }
              input.moveCursorUp()
              return
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = 0
          },
        },
      ],
    }
  })

  Keymap.createLayer(() => {
    return {
      priority: 1,
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !disabled() && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          id: "prompt.history.next",
          title: "Next prompt history",
          group: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              ) {
                input.cursorOffset = input.plainText.length
                return
              }
              input.moveCursorDown()
              return
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.text)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromPrompt(item)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
    }
  })

  async function submit(delivery: SessionInbox.Delivery = "steer") {
    if (disposed || !input || input.isDestroyed || disabled() || props.visible === false || submission) return false
    const pending: Submission = {
      controller: new AbortController(),
      revision: composerRevision,
      queued: false,
      started: false,
    }
    submission = pending
    try {
      return await submitInner(delivery, pending)
    } catch (error) {
      if (!pending.controller.signal.aborted && !disposed)
        toast.show({ title: "Failed to prepare session", message: errorMessage(error), variant: "error" })
      return false
    } finally {
      if (!pending.queued && submission === pending) submission = undefined
      if (!pending.queued && !disposed && !submission && move.progress()) move.finishSubmit()
    }
  }

  async function submitInner(delivery: SessionInbox.Delivery, pending: Submission) {
    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.text) {
      setStore("prompt", "text", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (move.creating()) return false
    if (auto()?.visible) return false
    const trimmed = store.prompt.text.trim()
    if (!trimmed && (!props.sessionID || store.mode === "shell" || delivery === "queue"))
      return delivery === "steer" ? (await props.onEmptySubmit?.()) === true : false
    const exitWord = trimmed === "exit" || trimmed === "quit" || trimmed === ":q"
    const inputText = expandTrackedPastedText(store.prompt.text, pastedRanges())
    const slash = argumentSlash(inputText, keymapCommands())
    if (delivery === "queue" && (store.mode === "shell" || exitWord || slash)) {
      toast.show({ message: "This prompt cannot be queued", variant: "warning" })
      return false
    }
    if (exitWord) {
      void exit()
      return true
    }
    if (slash) {
      clearPrompt()
      await slash.command.run(slash.input)
      return true
    }
    const slashHead = parseSlashHead(inputText, /\s/)
    const commands = data.location.command.list(currentLocation.ref)
    // Undefined is an unread catalog, not a known-empty one. Only unresolved
    // normal-mode slash input needs it; local commands and exit already returned.
    if (store.mode === "normal" && slashHead && commands === undefined) {
      const location = currentLocation.ref ?? data.location.default()
      const error = data.location.command.error(location)
      toast.show({
        title: error ? "Commands unavailable" : "Commands loading",
        message: error ? errorMessage(error) : "The command catalog is not ready. Submit again when it is available.",
        variant: error ? "error" : "info",
        action: error
          ? {
              label: "Retry",
              run: () => {
                void data.location.command.sync(location).catch(toast.error)
              },
            }
          : undefined,
      })
      return false
    }
    const isCommand = slashHead !== undefined && commands?.some((command) => command.name === slashHead.name) === true
    const editorSelection = editorContext()
    const pendingEditorSelection = editorSelection && editor.labelState() === "pending" ? editorSelection : undefined
    if (delivery === "queue" && pendingEditorSelection) {
      toast.show({ message: "Editor context cannot be queued", variant: "warning" })
      return false
    }
    const agent = local.agent.current()
    if (!agent) return false
    const selection = local.model.selection()
    if (!selection) {
      void promptModelWarning()
      return false
    }
    const usesModel = !props.sessionID || store.mode !== "shell"
    if (usesModel && !local.model.available(selection)) {
      toast.show({
        title: "Model unavailable",
        message: `${selection.providerID}/${selection.modelID} is not available in this session's location`,
        variant: "warning",
      })
      return false
    }

    // Keep the editable draft until the last pre-send boundary. Cancellation
    // never needs to overwrite newer input, and unmount stashes the draft normally.
    const currentMode = store.mode
    const entry = structuredClone({ ...unwrap(store.prompt), mode: currentMode })
    const current = () =>
      !disposed &&
      pending.revision === composerRevision &&
      enabled() &&
      props.visible !== false &&
      store.mode === (pending.started && currentMode === "shell" ? "normal" : currentMode)
    const check = () => {
      if (!current() || input.isDestroyed || input.plainText !== entry.text || store.mode !== currentMode)
        pending.controller.abort()
      pending.controller.signal.throwIfAborted()
    }
    const start = () => {
      check()
      // After dispatch, admission may already be durable. Do not abort the HTTP
      // request or let subsequent edits/navigation revoke it.
      pending.started = true
      if (submission === pending) submission = undefined
      if (!trimmed) return
      history.append(entry)
      resetComposer(true)
      props.onSubmit?.()
    }
    const restoreEntry = () => {
      if (!pending.started || !current() || input.isDestroyed || input.plainText !== "") return
      input.setText(entry.text)
      setStore("prompt", entry)
      setStore("mode", entry.mode ?? "normal")
      restoreExtmarksFromPrompt(entry)
      input.cursorOffset = entry.text.length
    }
    const fail = (title: string, error: unknown) => {
      if (pending.controller.signal.aborted || !current()) return
      toast.show({ title, message: errorMessage(error), variant: "error" })
      restoreEntry()
    }

    const variant = selection.variant
    let sessionID = props.sessionID
    let session = sessionID ? data.session.get(sessionID) : undefined
    // New-session sends wait for creation and environment setup.
    let gate: Promise<unknown> | undefined
    if (sessionID == null) {
      const directory = await move.getDirectory(pending.controller.signal)
      check()
      if (move.pending() && !directory) {
        return false
      }
      // The location context is where the next session is created: seeded by the home
      // route (launch cwd, inherited session location, or picked project) and updated
      // by /cd before a session exists.
      const location = currentLocation.ref ?? data.location.default()

      // Keep the official optimistic record, but navigate only after admission
      // succeeds and only if the user has not left or edited the source composer.
      const created = data.session.create({
        location: directory ? { directory } : location,
        agent: agent.id,
        model: {
          providerID: selection.providerID,
          id: selection.modelID,
          variant,
        },
      })
      sessionID = created.id
      session = data.session.get(created.id)
      gate = created.request.then(async () => {
        check()
        if (terminalEnvironment.variables !== undefined) {
          await client.api.session.environment({ sessionID: created.id, variables: terminalEnvironment.variables })
          check()
        }
      })
    }

    const target = sessionID
    const prepareAgent = async () => {
      check()
      if (!session) {
        await data.session.sync(target)
        check()
        session = data.session.get(target)
      }
      if (session?.agent !== agent.id) {
        await client.api.session.switchAgent({ sessionID: target, agent: agent.id })
        check()
      }
    }
    const commitModel = () => {
      check()
      const model = { providerID: selection.providerID, id: selection.modelID, variant }
      const cancelCommit = local.model.trackSessionCommit(target, model, agent.id)
      return client.api.session.switchModel({ sessionID: target, model }).catch((error) => {
        cancelCommit()
        throw new Error(`Failed to switch model: ${errorMessage(error)}`, { cause: error })
      })
    }
    const commitSelection = async () => {
      await prepareAgent()
      check()
      await commitModel()
      check()
    }
    if (!trimmed) {
      // Blank Enter in an existing session commits the composer's agent and
      // model selection, then hands off to the route (queued prompt promotion).
      await commitSelection()
      start()
      return (await props.onEmptySubmit?.()) === true && current()
    }
    const finish = () => {
      if (submission === pending) submission = undefined
      if (!disposed && !submission && move.progress()) move.finishSubmit()
    }
    const admitted = () => {
      if (!current()) return
      if (props.sessionID) return
      if (pendingEditorSelection && editorSelectionKey(editor.selection()) === editorSelectionKey(pendingEditorSelection))
        editor.preserveSelectionFromNewSession()
      route.navigate({ type: "session", sessionID: target })
    }
    if (currentMode === "shell") {
      move.startSubmit()
      const send = () => {
        start()
        setStore("mode", "normal")
        return client.api.session.shell({ sessionID: target, command: inputText })
      }
      pending.queued = true
      void (gate ?? Promise.resolve())
        .then(send)
        .then(admitted)
        .catch((error) => fail("Failed to run shell command", error))
        .finally(finish)
    } else if (slashHead && isCommand) {
      const send = async () => {
        // Commands inherit the composer selection; command-specific overrides
        // remain server-owned and run after this preparation.
        await commitSelection()
        start()
        return client.api.session.command({
          sessionID: target,
          name: slashHead.name,
          text: slashHead.arguments,
          files: entry.files,
          agents: entry.agents,
          skills: entry.skills?.length ? entry.skills : undefined,
          delivery,
        })
      }
      pending.queued = true
      void (gate ?? Promise.resolve())
        .then(send)
        .then(admitted)
        .catch((error) => fail("Failed to run command", error))
        .finally(finish)
    } else {
      move.startSubmit()
      // Every Session-scoped side effect must wait for creation/environment.
      if (gate) await gate
      check()
      await prepareAgent()
      check()
      // Revert must settle before optimistic admission: its committed echo
      // splices every local row at or after the boundary, which would include
      // a freshly admitted prompt.
      if (session?.revert) {
        await client.api.session.revert.commit({ sessionID: target })
        check()
      }
      if (pendingEditorSelection) {
        // Keep editor context hidden while admitting it before the corresponding user prompt.
        await client.api.session.synthetic({
          sessionID: target,
          text: formatEditorContext(pendingEditorSelection),
          resume: false,
        })
        if (
          !disposed && enabled() && props.visible !== false &&
          editorSelectionKey(editor.selection()) === editorSelectionKey(pendingEditorSelection)
        )
          editor.markSelectionSent()
        check()
      }
      // The data layer admits optimistically: the prompt renders immediately
      // and rolls back if the server rejects it, so submission does not wait
      // on the network. On rejection the row is already rolled back; restore
      // the composer unless the user has started typing something new.
      pending.queued = true
      void data.session
        .prompt({
          sessionID: target,
          text: inputText,
          files: entry.files,
          agents: entry.agents,
          skills: entry.skills?.length ? entry.skills : undefined,
          delivery,
          signal: pending.controller.signal,
          // Commit the captured selection after earlier admissions, including
          // compaction setup. Cached state may still precede their SSE echoes;
          // the server makes an unchanged selection a no-op.
          prepare: async () => {
            await commitModel()
            start()
          },
        })
        .then(admitted)
        .catch((error) => fail("Failed to send prompt", error))
        .finally(finish)
    }
    return true
  }

  function pastedRanges() {
    return input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
      const ref = store.extmarkToPart.get(extmark.id)
      if (ref?.type !== "pasted") return []
      const part = store.prompt.pasted[ref.index]
      return part ? [{ start: extmark.start, end: extmark.end, text: part.text }] : []
    })
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const index = draft.prompt.pasted.length
        draft.prompt.pasted.push({
          text,
          source: { start: extmarkStart, end: extmarkEnd, text: virtualText },
        })
        draft.extmarkToPart.set(extmarkId, { type: "pasted", index })
      }),
    )
  }

  function expandPastedText(extmarkId: number) {
    const extmark = input.extmarks.get(extmarkId)
    const ref = store.extmarkToPart.get(extmarkId)
    if (!extmark || ref?.type !== "pasted") return false
    const part = store.prompt.pasted[ref.index]
    if (!part) return false

    // Keep the part/mark alive until the native selection deletion captures it.
    // That edit removes the mark itself; pre-deleting it would make undo capture
    // a literal label instead of the payload-bearing placeholder.
    input.setSelection(extmark.start, extmark.end)
    input.insertText(part.text)
    return true
  }

  async function pasteInputText(text: string, changed: () => boolean) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const attachments = await resolvePastedAttachments(pastedContent, terminalEnvironment.platform)
    if (changed()) return
    if (attachments) {
      attachments.forEach((attachment) => {
        if (attachment.type === "text") {
          pasteText(attachment.content, `[SVG: ${attachment.filename || "image"}]`)
          return
        }
        pasteAttachment(attachment)
      })
      return
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if ((lineCount >= 3 || pastedContent.length > 150) && config.prompt?.paste !== "full") {
      const extmark = input.extmarks.getAllForTypeId(promptPartTypeId).find((extmark) => {
        const ref = store.extmarkToPart.get(extmark.id)
        return (
          (extmark.end === input.cursorOffset || extmark.end + 1 === input.cursorOffset) &&
          ref?.type === "pasted" &&
          store.prompt.pasted[ref.index]?.text === pastedContent
        )
      })
      if (extmark && expandPastedText(extmark.id)) return
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  function pasteAttachment(file: { filename?: string; uri: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const virtualText = promptAttachmentLabel(store.prompt.files, { uri: file.uri, name: file.filename })
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: NonNullable<PromptInfo["files"]>[number] = {
      uri: file.uri,
      name: file.filename,
      mention: {
        start: extmarkStart,
        end: extmarkEnd,
        text: virtualText,
      },
    }
    setStore(
      produce((draft) => {
        const files = (draft.prompt.files ??= [])
        const index = files.length
        files.push(part)
        draft.extmarkToPart.set(extmarkId, { type: "file", index })
      }),
    )
  }

  function clearPrompt() {
    if (
      store.prompt.text.trim().length >= DRAFT_RETENTION_MIN_CHARS ||
      store.prompt.pasted.length > 0 ||
      (store.prompt.files?.length ?? 0) > 0 ||
      (store.prompt.agents?.length ?? 0) > 0
    ) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    resetComposer()
  }

  // Keep the last resolved prompt display visible while destination catalogs load;
  // availability and submission still use the live location-scoped catalog.
  const promptDisplay = createMemo<{
    agentLabel: string | undefined
    agentColor: RGBA | undefined
    modelLabel: string
    providerLabel: string
    variant: string | undefined
  }>(
    (previous) => {
      const location = currentLocation.ref ?? data.location.default()
      const sessionLocation = props.sessionID ? data.session.get(props.sessionID)?.location : location
      if (!sessionLocation || locationKey(sessionLocation) !== locationKey(location)) return previous

      const loading = data.location.agent.list(location) === undefined || !local.model.catalogReady
      const error = currentLocation.error
      const failed = error && locationKey(error.location) === locationKey(location)
      if (loading && !failed) return previous

      const agent = local.agent.current()
      const model = local.model.parsed()
      return {
        agentLabel: agent ? Locale.titlecase(agent.id) : undefined,
        agentColor: agent ? local.agent.color(agent.id) : undefined,
        modelLabel: model.model,
        providerLabel: model.provider,
        variant: local.model.variant.current(),
      }
    },
    {
      agentLabel: undefined,
      agentColor: undefined,
      modelLabel: local.model.parsed().model,
      providerLabel: local.model.parsed().provider,
      variant: undefined,
    },
  )
  const highlight = createMemo(() => {
    if (muted()) return theme.border.base
    if (store.mode === "shell") return theme.text.action.primary.selected
    return promptDisplay().agentColor ?? theme.border.base
  })
  const agentLabel = createMemo(() => (store.mode === "shell" ? "Shell" : promptDisplay().agentLabel))
  const animateMetadata = !revealedPromptMetadata.has(local)
  const metadataAnimationsEnabled = () => animationsEnabled() && animateMetadata
  const agentMetaAlpha = createFadeIn(() => !!agentLabel(), metadataAnimationsEnabled)
  const modelMetaAlpha = createFadeIn(
    () => !!promptDisplay().agentLabel && store.mode === "normal",
    metadataAnimationsEnabled,
  )
  const variantMetaAlpha = createFadeIn(
    () => !!promptDisplay().agentLabel && store.mode === "normal" && !!promptDisplay().variant,
    metadataAnimationsEnabled,
  )
  createEffect(() => {
    if (agentLabel()) revealedPromptMetadata.add(local)
  })
  const borderHighlight = createMemo(() => tint(theme.border.base, highlight(), agentMetaAlpha()))
  const footerInput = () => ({
    sessionID: props.sessionID,
    mode: store.mode,
    showDetails: store.interrupt === 0 || dimensions().width >= 80,
  })

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    const value = (() => {
      if (store.mode === "shell") {
        if (!shell().length) return undefined
        return `Run a command… "${shell()[store.placeholder % shell().length]}"`
      }
      if (!list().length) return undefined
      return `Ask anything… "${list()[store.placeholder % list().length]}"`
    })()
    if (!value) return undefined
    const width = dimensions().width < 44 ? dimensions().width - 5 : Math.min(75, dimensions().width - 4) - 5
    return Locale.takeWidth(value, Math.max(1, width)).trimEnd()
  })
  const footerLocation = createMemo(() => {
    if (!props.sessionID) {
      // No session yet: show where the next session will be created.
      return currentLocation.ref ?? data.location.default()
    }
    if (status() !== "idle") return
    return data.session.get(props.sessionID)?.location
  })
  const locationLabel = createMemo(() => {
    const pending = pendingDirectory()
    const location = pending ? { directory: pending } : footerLocation()
    if (!location) return
    const directory = abbreviateHome(location.directory, paths.home)
    const branch = data.location.vcs.info(location)?.branch.current
    return branch ? `${directory}:${branch}` : directory
  })
  const [locationWidth, setLocationWidth] = createSignal(dimensions().width)
  const locationLabelDisplay = createMemo(() => {
    const label = locationLabel()
    if (!label) return
    return truncateFilePath(label, locationWidth())
  })
  const locationActions = useWorkingDirectoryActions({
    directory: () => footerLocation()?.directory,
    onMove: () => void move.open(),
  })

  const spinnerDef = createMemo(() => {
    const color = promptDisplay().agentColor ?? theme.border.base
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  const maxHeight = createMemo(() => Math.max(6, Math.floor(dimensions().height / 3)))

  const promptBg = createMemo(() => theme.decrease(theme.background.raised.base))

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%">
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={dimensions().width < 44 ? 1 : 2}
            paddingRight={dimensions().width < 44 ? 1 : 2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={promptBg()}
            flexGrow={1}
            width="100%"
          >
            <Show when={config.prompt?.image_preview && visibleImageAttachments().length > 0}>
              <box
                width="100%"
                height={imagePreviewHeight() + 1}
                flexDirection="row"
                flexShrink={0}
                justifyContent="flex-start"
                gap={1}
                paddingBottom={1}
              >
                <For each={visibleImageAttachments()}>
                  {(file, index) => {
                    const [failed, setFailed] = createSignal(false)
                    return (
                      <box
                        width={imagePreviewWidth()}
                        height={imagePreviewHeight()}
                        flexBasis={imagePreviewWidth()}
                        flexShrink={1}
                        onMouseUp={(event: MouseEvent) => {
                          if (event.button !== 0) return
                          event.stopPropagation()
                          openImagePreview(index())
                        }}
                      >
                        <Show
                          when={!failed()}
                          fallback={
                            <box width="100%" height="100%" alignItems="center" justifyContent="center">
                              <text fg={theme.text.muted}>No preview</text>
                            </box>
                          }
                        >
                          <image
                            id={`prompt-image-preview-${index()}`}
                            source={file.uri}
                            fit="cover"
                            protocol="auto"
                            width="100%"
                            height="100%"
                            onError={() => setFailed(true)}
                          />
                        </Show>
                      </box>
                    )
                  }}
                </For>
                <Show when={imageAttachments().length > visibleImageAttachments().length}>
                  <box
                    width={8}
                    height={imagePreviewHeight()}
                    flexBasis={8}
                    flexShrink={1}
                    alignItems="center"
                    justifyContent="center"
                    onMouseUp={(event: MouseEvent) => {
                      if (event.button !== 0) return
                      event.stopPropagation()
                      openImagePreview(visibleImageAttachments().length)
                    }}
                  >
                    <text fg={theme.text.muted} wrapMode="none" truncate>
                      +{imageAttachments().length - visibleImageAttachments().length} more
                    </text>
                  </box>
                </Show>
              </box>
            </Show>
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.text.muted}
              textColor={muted() ? theme.text.muted : theme.text.base}
              focusedTextColor={muted() ? theme.text.muted : theme.text.base}
              minHeight={1}
              maxHeight={maxHeight()}
              cursorStyle={config.cursor}
              onContentChange={() => {
                const value = input.plainText
                if (value !== store.prompt.text) invalidateSubmission()
                setStore("prompt", "text", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => setCursorVersion((value) => value + 1)}
              onKeyDown={(e: { preventDefault(): void }) => {
                if (disabled()) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                // Do not enqueue a native deferred Enter while preparation is
                // already active: Escape could cancel it before the timer fires.
                if (disabled() || submission) return
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={(event: PasteEvent) => {
                if (disabled()) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (event.bytes.byteLength === 0) {
                  keymap.dispatch("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                void enqueuePaste((changed) => pasteInputText(normalizedText, changed))
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                onCleanup(bindPromptUndo(r, () => {
                  syncExtmarksWithPromptParts()
                  const prompt = unwrap(store.prompt)
                  // Copy mutable positions, but share immutable strings (large
                  // pasted payloads/data URLs) across the bounded undo window.
                  return {
                    files: prompt.files?.map((part) => ({ ...part, mention: part.mention && { ...part.mention } })),
                    agents: prompt.agents?.map((part) => ({ ...part, mention: part.mention && { ...part.mention } })),
                    skills: prompt.skills?.map((part) => ({ ...part, mention: part.mention && { ...part.mention } })),
                    pasted: prompt.pasted.map((part) => ({ ...part, source: { ...part.source } })),
                  }
                }, (snapshot) => {
                  // A retained history entry must not become Solid's mutable
                  // store backing object. Share strings, not part positions.
                  const prompt = {
                    text: r.plainText,
                    files: snapshot.files?.map((part) => ({ ...part, mention: part.mention && { ...part.mention } })),
                    agents: snapshot.agents?.map((part) => ({ ...part, mention: part.mention && { ...part.mention } })),
                    skills: snapshot.skills?.map((part) => ({ ...part, mention: part.mention && { ...part.mention } })),
                    pasted: snapshot.pasted.map((part) => ({ ...part, source: { ...part.source } })),
                  }
                  setStore("prompt", prompt)
                  restoreExtmarksFromPrompt(prompt)
                }))
                Object.assign(r, {
                  canCut: () => !disabled() && !disposed && props.visible !== false,
                  cutSelection: () => {
                    invalidateSubmission()
                    setStore("prompt", "text", r.plainText)
                    syncExtmarksWithPromptParts()
                    if (!r.deleteSelection()) return false
                    setStore("prompt", "text", r.plainText)
                    syncExtmarksWithPromptParts()
                    return true
                  },
                  getClipboardText: (text: string) => {
                    const range = r.getSelection()
                    const start = range ? Math.min(range.start, range.end) : 0
                    const end = range ? Math.max(range.start, range.end) : promptOffsetWidth(text)
                    return expandTrackedPastedText(text, pastedRanges()
                      .filter((part) => part.start >= start && part.end <= end)
                      .map((part) => ({ ...part, start: part.start - start, end: part.end - start })))
                  },
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = disabled() ? theme.background.raised.base : theme.text.base
                  if (config.cursor) input.cursorStyle = config.cursor
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => {
                if (disabled()) {
                  r.preventDefault()
                  return
                }
                if (r.button !== 0) return
                r.target?.focus()
                const extmark = input.extmarks
                  .getAtOffset(input.cursorOffset)
                  .find((item) => store.extmarkToPart.get(item.id)?.type === "pasted")
                if (!extmark || !expandPastedText(extmark.id)) return
                r.preventDefault()
                r.stopPropagation()
              }}
              focusedBackgroundColor="transparent"
              cursorColor={disabled() ? theme.background.raised.base : theme.text.base}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <PromptMetadataRow
                mode={store.mode}
                agent={agentLabel()}
                auto={local.permission.mode === "autoaccept"}
                model={promptDisplay().modelLabel}
                provider={promptDisplay().providerLabel}
                variant={promptDisplay().variant}
                muted={!!muted()}
                highlight={highlight()}
                agentAlpha={agentMetaAlpha()}
                modelAlpha={modelMetaAlpha()}
                variantAlpha={variantMetaAlpha()}
              />
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: promptBg().a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={promptBg()}
            customBorderChars={
              promptBg().a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
          <Slot path="prompt.footer" input={footerInput()}>
            <Slot path="prompt.footer.status" input={footerInput()}>
              <box
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                onSizeChange={function (this: BoxRenderable) {
                  const width = this.width
                  queueMicrotask(() => setLocationWidth(width))
                }}
              >
                <Switch>
                  <Match when={status() === "running"}>
                    <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
                      <box marginLeft={1}>
                        <Show when={config.animations ?? true} fallback={<text fg={theme.text.muted}>[⋯]</text>}>
                          <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                        </Show>
                      </box>
                      <PromptInterruptStatus
                        armed={store.interrupt > 0}
                        animations={animationsEnabled()}
                        text={theme.text.base}
                        subdued={theme.text.muted}
                        warning={theme.text.feedback.warning.base}
                        flash={theme.decrease(theme.text.feedback.warning.base, 2)}
                      />
                    </box>
                  </Match>
                  <Match when={move.progress()}>
                    {(progress) => (
                      <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                        <Spinner color={theme.hue.accent[500]}>
                          {progress()}
                          <span style={{ fg: theme.text.muted }}>{".".repeat(move.creatingDots())}</span>
                        </Spinner>
                      </box>
                    )}
                  </Match>
                  <Match when={move.pendingNew()}>
                    <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                      <text fg={theme.hue.accent[500]} wrapMode="none" truncate>
                        (new worktree)
                      </text>
                    </box>
                  </Match>
                  <Match when={childRunning()}>
                    <box flexDirection="row" gap={1} flexGrow={1} minWidth={0} justifyContent="flex-start">
                      <box marginLeft={1}>
                        <Show when={animationsEnabled()} fallback={<text fg={theme.text.muted}>[⋯]</text>}>
                          <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                        </Show>
                      </box>
                      <text fg={theme.text.base} wrapMode="none" truncate flexShrink={1}>Subagent working</text>
                    </box>
                  </Match>
                  <Match when={true}>
                    <Show when={!props.hint && locationLabelDisplay()} fallback={props.hint ?? <text />}>
                      {(location) => (
                        <text
                          id="prompt.footer.location"
                          fg={locationActions.hovered() ? theme.text.base : theme.text.muted}
                          wrapMode="none"
                          truncate
                          flexGrow={1}
                          flexShrink={1}
                          onMouseOver={locationActions.onMouseOver}
                          onMouseOut={locationActions.onMouseOut}
                          onMouseUp={locationActions.onMouseUp}
                        >
                          {location()}
                        </text>
                      )}
                    </Show>
                  </Match>
                </Switch>
              </box>
            </Slot>
            <Slot path="prompt.footer.file" input={footerInput()}>
              <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  <text
                    wrapMode="none"
                    truncate
                    flexShrink={1}
                    fg={editorContextLabelState() === "pending" ? theme.hue.accent[500] : theme.text.muted}
                  >
                    {file()}
                  </text>
                )}
              </Show>
            </Slot>
          </Slot>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        argumentAutocomplete={(command) => (command.id === "session.cd" ? "directory" : undefined)}
        directoryOptions={(query): AutocompleteOption[] => {
          if (query !== "") return []
          const projectID =
            (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ??
            data.location.info()?.project.id
          if (!projectID) return []
          return directoryRecents.list(projectID).map((item) => {
            const value = directoryRecentValue(item.directory, paths.home)
            return {
              display: value,
              value,
              description: "recent",
              isDirectory: true,
              path: value,
              absolute: item.directory,
              destructive: {
                id: item.directory,
                confirm: "Press ctrl+d to confirm",
                run: () => directoryRecents.remove(projectID, item.directory),
              },
            }
          })
        }}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(part, extmarkId) => {
          setStore("extmarkToPart", (map: Map<number, PromptPartRef>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, part)
            return newMap
          })
        }}
        value={store.prompt.text}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        skillStyleId={skillStyleId}
        hasSkill={(id) => store.prompt.skills?.some((skill) => skill.id === id) ?? false}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
