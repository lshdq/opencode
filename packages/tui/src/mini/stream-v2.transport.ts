import type {
  EventSubscribeOutput,
  FormInfo,
  LocationRef,
  OpenCodeClient,
  PermissionRequest,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
  SessionInboxInfo,
} from "@opencode/client/promise"
import { Event } from "@opencode/schema/event"
import { SessionMessage } from "@opencode/schema/session-message"
import { blockerStatus, pickBlockerView } from "./session-data"
import { writeSessionOutput } from "./stream"
import { createFragmentReconciler, fragmentRef, type FragmentReconciler } from "./stream-v2.fragment"
import { toolImageCommits, userImageCommits, type ImageCommit } from "./stream-v2.image"
import { messagePrompt } from "./session.shared"
import { createSubagentTracker, toolCommit, toolFinalPhase } from "./stream-v2.subagent"
import { normalizeTool, toolOutputText } from "./tool"
import { toolDisplayContent } from "../util/tool-display"
import type {
  FooterApi,
  FooterPatch,
  FooterView,
  LocalReplayRow,
  MiniPermissionRequest,
  MiniFormRequest,
  FooterQueuedPrompt,
  RunFilePart,
  RunInput,
  RunDelivery,
  RunPrompt,
  RunPromptPart,
  StreamCommit,
} from "./types"

type Trace = {
  write(type: string, data?: unknown): void
}

type StreamInput = {
  sdk: OpenCodeClient
  reconnect?: (signal: AbortSignal) => Promise<OpenCodeClient>
  onClient?: (sdk: OpenCodeClient) => void
  readTextFile?: (url: string) => Promise<string>
  location?: LocationRef
  sessionID: string
  thinking: boolean
  tools?: boolean
  replay?: boolean
  replayLimit?: number
  footer: FooterApi
  onCommit?: (commit: StreamCommit) => void
  onSessionTitle?: (title: string) => void
  trace?: Trace
  signal?: AbortSignal
  onCatalogRefresh?: (signal?: AbortSignal) => unknown | Promise<unknown>
  contextLimit?: (model: NonNullable<RunInput["model"]>) => number | undefined
}

export type SessionTurnInput = {
  agent: string | undefined
  model: RunInput["model"]
  variant: string | undefined
  prompt: RunPrompt
  files: RunFilePart[]
  includeFiles: boolean
  signal?: AbortSignal
}

export type SessionResizeReplayInput = {
  localRows: () => LocalReplayRow[]
  reset: () => Promise<void>
}

export type SessionTransport = {
  runPromptTurn(input: SessionTurnInput, admitted?: () => void): Promise<void>
  admitPromptTurn(input: SessionTurnInput, delivery: RunDelivery): Promise<void>
  waitForIdle(): Promise<void>
  interruptActiveTurn(): Promise<void>
  selectSubagent(sessionID: string | undefined): void
  replayOnResize(input: SessionResizeReplayInput): Promise<boolean>
  close(): Promise<void>
  settleForm?(sessionID: string, formID: string): void
}

type Wait = {
  messageID: string
  failureMessageID: string
  promoted: boolean
  promotionObserved: boolean
  interrupted: boolean
  failureRendered: boolean
  terminalError?: Error
}

// One active session.shell call. The HTTP response is the completion signal;
// id correlates the live shell events once shell.started is observed, and
// abort cancels the blocking request when the user interrupts the turn.
type ShellWait = {
  eventID: string
  messageID: string
  id?: string
  settled?: boolean
  resolve: () => void
  abort: () => void
}

type RunV2Event = EventSubscribeOutput
type PromptFilePart = Extract<RunPromptPart, { type: "file" }>

type Attempt = {
  client: OpenCodeClient
  signal: AbortSignal
  generation: number
}

type ReplayBuffer = {
  attempt: Attempt
  events: RunV2Event[]
}

type HydrateOptions = {
  render: boolean
  reconnect?: boolean
}

type ToolState = {
  part: SessionMessageAssistantTool
  output: string
  version: number
  started: boolean
}

type PendingPrompt = FooterQueuedPrompt & { files: SessionMessageUser["files"] }

type State = {
  permissions: MiniPermissionRequest[]
  forms: MiniFormRequest[]
  globalForms: MiniFormRequest[]
  view: FooterView
  messageIDs: Set<string>
  // Delivery can arrive before the admission response supplies the user content.
  promotedMessages: Set<string>
  imageIDs: Set<string>
  fragments: FragmentReconciler
  tools: Map<string, ToolState>
  toolSources: Map<string, SessionMessageAssistantTool>
  finishedTools: Set<string>
  toolMessages: Set<string>
  quietText: Map<string, Array<{ partID: string; text: string }>>
  skillMessages: Set<string>
  shellCommands: Map<string, string>
  /** Best-effort origin directory for shell lifecycle reconciliation. */
  shellLocations: Map<string, string>
  shellStarted: Set<string>
  shellEnded: Set<string>
  /** Shell lifecycle facts. Kept separate from transcript rendering state. */
  shellSettled: Set<string>
  /** Shell start commits already present in the current transcript. */
  shellRenderedStarted: Set<string>
  /** Shell terminal commits already present in the current transcript. */
  shellRenderedEnded: Set<string>
  /** Foreground requests can settle before their started event is delivered. */
  shellSettledEvents: Set<string>
  shellActive: Set<string>
  shellWait?: ShellWait
  wait?: Wait
  connected: boolean
  closed: boolean
  initial: boolean
  rootActive: boolean
  /** Bumped on every root execution lifecycle event; guards paints against stale acks. */
  executionEpoch: number
  buffered?: ReplayBuffer
  errors: Set<string>
  pending: Map<string, PendingPrompt>
  admitted: Set<string>
  stepModel: RunInput["model"]
  activeCompaction?: string
}

export function formatUnknownError(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message || error.name
  if (error && typeof error === "object") {
    const message = "message" in error ? error.message : undefined
    if (typeof message === "string" && message.trim()) return message
    const tag = "_tag" in error ? error._tag : undefined
    if (typeof tag === "string" && tag.trim()) return tag
  }
  return "unknown error"
}

function sessionID(event: RunV2Event) {
  if (event.type === "form.created") return event.data.form.sessionID
  return "sessionID" in event.data && typeof event.data.sessionID === "string" ? event.data.sessionID : undefined
}

function sameLocation(left: LocationRef | undefined, right: LocationRef | undefined) {
  return !!left && !!right && left.directory === right.directory
}

function globalForm(form: FormInfo, location: LocationRef): MiniFormRequest {
  return { ...form, location: { directory: location.directory } }
}

function errorMessage(error: { message?: string; _tag?: string }) {
  return error.message || error._tag || "Session execution failed"
}

function pendingPrompt(item: SessionInboxInfo): PendingPrompt | undefined {
  if (item.type !== "user") return undefined
  return {
    messageID: item.id,
    prompt: { messageID: item.id, ...messagePrompt(item.payload) },
    files: item.payload.files,
    delivery: item.delivery,
    ...(item.payload.skills?.length
      ? { skills: item.payload.skills.map((skill) => ({ id: skill.id, name: skill.name })) }
      : {}),
  }
}

function wait(delay: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, delay)
    signal.addEventListener("abort", done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
  })
}

function nextEvent(stream: AsyncIterator<RunV2Event>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Event stream aborted"))
  return new Promise<IteratorResult<RunV2Event>>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason ?? new Error("Event stream aborted"))
    }
    signal.addEventListener("abort", abort, { once: true })
    void stream.next().then(
      (next) => {
        signal.removeEventListener("abort", abort)
        resolve(next)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
  })
}

async function prepareInitialFile(file: RunFilePart, readTextFile?: StreamInput["readTextFile"]) {
  if (file.mime !== "text/plain") return { type: "file" as const, file: { uri: file.url, name: file.filename } }
  const content = file.url.startsWith("data:")
    ? Buffer.from(file.url.slice(file.url.indexOf(",") + 1), "base64").toString("utf8")
    : await (readTextFile?.(file.url) ?? Promise.reject(new Error("Local text file acquisition is unavailable")))
  return { type: "text" as const, text: `<file name="${file.filename}">\n${content}\n</file>` }
}

function promptFileMention(part: PromptFilePart) {
  if (!part.source?.text) return
  return {
    start: part.source.text.start,
    end: part.source.text.end,
    text: part.source.text.value,
  }
}

function promptFiles(next: SessionTurnInput) {
  return next.prompt.parts.flatMap((part) =>
    part.type === "file"
      ? [
          {
            uri: part.url,
            name: part.filename,
            ...(part.description === undefined ? {} : { description: part.description }),
            mention: promptFileMention(part),
          },
        ]
      : [],
  )
}

async function prepareAttachments(
  next: SessionTurnInput,
  mode: "command" | "prompt",
  readTextFile?: StreamInput["readTextFile"],
) {
  const initial = next.includeFiles ? next.files : []
  if (mode === "command") {
    return {
      text: [],
      files: [...initial.map((file) => ({ uri: file.url, name: file.filename })), ...promptFiles(next)],
    }
  }
  const prepared = await Promise.all(initial.map((file) => prepareInitialFile(file, readTextFile)))
  return {
    text: prepared.flatMap((file) => (file.type === "text" ? [file.text] : [])),
    files: [...prepared.flatMap((file) => (file.type === "file" ? [file.file] : [])), ...promptFiles(next)],
  }
}

function promptAgents(next: SessionTurnInput) {
  return next.prompt.parts.flatMap((part) =>
    part.type === "agent"
      ? [
          {
            name: part.name,
            mention: part.source
              ? { start: part.source.start, end: part.source.end, text: part.source.value }
              : undefined,
          },
        ]
      : [],
  )
}

function promptSkills(next: SessionTurnInput) {
  return next.prompt.parts.flatMap((part) =>
    part.type === "skill"
      ? [
          {
            id: part.id,
            mention: part.source
              ? { start: part.source.start, end: part.source.end, text: part.source.value }
              : undefined,
          },
        ]
      : [],
  )
}

function streamPartKey(messageID: string, partID: string) {
  return `${messageID}\u0000${partID}`
}

function permissionSourceKey(messageID: string, id: string) {
  return streamPartKey(messageID, id)
}

function permissionTool(request: PermissionRequest, tools: Map<string, SessionMessageAssistantTool>) {
  if (request.source?.type !== "tool") return request
  const tool = tools.get(permissionSourceKey(request.source.messageID, request.source.id))
  return tool ? { ...request, tool } : request
}

// Direct shell calls use one "start" commit rendering `$ command` and one "progress"
// commit rendering the merged output (see toolEntryBody in tool.ts).
function shellCommit(
  id: string,
  command: string,
  next: Pick<StreamCommit, "text" | "phase" | "toolState" | "toolError">,
): StreamCommit {
  return {
    kind: "tool",
    source: "tool",
    partID: `shell:${id}`,
    tool: "shell",
    shell: { command },
    ...next,
  }
}

function shellTerminal(
  id: string,
  command: string,
  shell: { status: string; exit?: number | string },
  output: { output: string; cursor: number; size: number; truncated: boolean },
) {
  const incomplete = output.truncated || output.cursor < output.size
  const text = `${output.output}${incomplete ? `${output.output.endsWith("\n") || !output.output ? "" : "\n"}[output truncated]` : ""}`
  const error =
    shell.status === "exited" && shell.exit === 0
      ? undefined
      : shell.status === "exited"
        ? `Shell exited with code ${shell.exit ?? "unknown"}`
        : `Shell ${shell.status}`
  if (!error) return [shellCommit(id, command, { text, phase: "progress", toolState: "completed" })]
  return [
    ...(text ? [shellCommit(id, command, { text, phase: "progress", toolState: "running" })] : []),
    shellCommit(id, command, { text: error, phase: "final", toolState: "error", toolError: error }),
  ]
}

function messageIDFromEvent(id: string) {
  return SessionMessage.ID.fromEvent(Event.ID.make(id))
}

function eventIDFromMessage(id: SessionMessage.ID) {
  return Event.ID.make(id.replace(/^msg_/, "evt_"))
}

const catalogEvents = new Set([
  "provider.updated",
  "model.updated",
  "integration.updated",
  "credential.switched",
  "agent.updated",
  "command.updated",
  "skill.updated",
  "reference.updated",
])

// session.shell resolves after the command settled server-side; the matching
// live shell.ended event usually lands within the same tick, but hold the turn
// briefly so the output commit renders inside it.
const SHELL_OUTPUT_GRACE_MS = 1500
const SHELL_TOMBSTONE_LIMIT = 256

function skillCommit(messageID: string, name: string, skillID = messageID): StreamCommit {
  return {
    kind: "system",
    source: "system",
    messageID,
    partID: `skill:${skillID}`,
    text: `→ Skill "${name}"`,
    phase: "start",
  }
}

function skillCommits(messageID: string, skills: FooterQueuedPrompt["skills"] = []) {
  return Array.from(new Map(skills.map((skill) => [skill.id, skill])).values(), (skill) =>
    skillCommit(messageID, skill.name, skill.id),
  )
}

function compactionCommit(messageID: string): StreamCommit {
  return {
    kind: "system",
    source: "system",
    messageID,
    partID: "compaction:header",
    text: "Compaction",
    phase: "start",
    compaction: true,
  }
}

function compactionSummary(messageID: string, text: string, phase: "progress" | "final"): StreamCommit {
  return {
    kind: "assistant",
    source: "assistant",
    messageID,
    partID: "compaction:summary",
    text,
    phase,
  }
}

function compactionError(messageID: string, text: string): StreamCommit {
  return {
    kind: "error",
    source: "system",
    messageID,
    partID: "compaction:error",
    text,
    phase: "start",
  }
}

async function resolveSelectedModel(
  input: StreamInput,
  sdk: OpenCodeClient,
  next: Pick<SessionTurnInput, "model" | "variant" | "signal">,
) {
  if (next.model) return { providerID: next.model.providerID, id: next.model.modelID, variant: next.variant }
  if (!next.variant) return

  const session = await sdk.session
    .get({ sessionID: input.sessionID }, { signal: next.signal })
    .then((response) => response.model)
  if (session) return { ...session, variant: next.variant }

  const fallback = await sdk.model
    .default(
      input.location
        ? {
            location: {
              directory: input.location.directory,
            },
          }
        : undefined,
      { signal: next.signal },
    )
    .then((response) => response.data)
  if (!fallback) return
  return { providerID: fallback.providerID, id: fallback.id, variant: next.variant }
}

export async function createSessionTransport(input: StreamInput): Promise<SessionTransport> {
  const controller = new AbortController()
  let sdk = input.sdk
  let generation = 0
  let activeAttempt: Attempt | undefined
  let settlementClient: OpenCodeClient | undefined
  let deferredCommits: StreamCommit[] | undefined
  input.signal?.addEventListener("abort", () => controller.abort(), { once: true })
  const state: State = {
    permissions: [],
    forms: [],
    globalForms: [],
    view: { type: "prompt" },
    messageIDs: new Set(),
    promotedMessages: new Set(),
    imageIDs: new Set(),
    fragments: createFragmentReconciler(),
    tools: new Map(),
    toolSources: new Map(),
    finishedTools: new Set(),
    toolMessages: new Set(),
    quietText: new Map(),
    skillMessages: new Set(),
    shellCommands: new Map(),
    shellLocations: new Map(),
    shellStarted: new Set(),
    shellEnded: new Set(),
    shellSettled: new Set(),
    shellRenderedStarted: new Set(),
    shellRenderedEnded: new Set(),
    shellSettledEvents: new Set(),
    shellActive: new Set(),
    connected: false,
    closed: false,
    initial: true,
    rootActive: false,
    executionEpoch: 0,
    errors: new Set(),
    pending: new Map(),
    admitted: new Set(),
    stepModel: undefined,
  }
  let shellInventoryLocation = input.location
  let shellInventoryGeneration = 0
  let readyResolve!: () => void
  let readyReject!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const abortReady = () => readyReject(new Error("Mini closed before the event stream connected"))
  controller.signal.addEventListener("abort", abortReady, { once: true })
  const offFooterClose = input.footer.onClose(() => controller.abort())
  const waitUntilConnected = async (signal?: AbortSignal) => {
    const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    while (!state.connected) {
      if (state.closed || controller.signal.aborted || input.footer.isClosed || signal?.aborted)
        throw new Error("Event stream aborted")
      await wait(25, abort)
    }
  }
  const current = (attempt: Attempt) =>
    !state.closed &&
    !controller.signal.aborted &&
    !attempt.signal.aborted &&
    attempt.generation === generation &&
    attempt.client === sdk

  const subagents = createSubagentTracker({
    sessionID: input.sessionID,
    thinking: input.thinking,
    directory: input.location?.directory,
    signal: controller.signal,
    emit: () => {
      if (state.closed || input.footer.isClosed) return
      const snapshot = subagents.snapshot()
      writeSessionOutput(
        { footer: input.footer, trace: input.trace },
        { commits: [], updates: [{ type: "stream.subagent", state: snapshot }] },
      )
      syncBlockers()
    },
  })
  controller.signal.addEventListener("abort", () => subagents.close(), { once: true })

  const hasActiveShells = () => state.shellActive.size > 0

  const rememberBounded = (set: Set<string>, id: string) => {
    set.delete(id)
    set.add(id)
    if (set.size <= SHELL_TOMBSTONE_LIMIT) return
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }

  const rememberShellSettled = (id: string) => rememberBounded(state.shellSettled, id)
  const rememberShellSettledEvent = (id: string) => rememberBounded(state.shellSettledEvents, id)
  const rememberShellRenderedStarted = (id: string) => rememberBounded(state.shellRenderedStarted, id)
  const rememberShellRenderedEnded = (id: string) => rememberBounded(state.shellRenderedEnded, id)
  const rememberShellLocation = (id: string, location: string | undefined) => {
    if (location && !state.shellLocations.has(id)) state.shellLocations.set(id, location)
  }
  const settleShell = (id: string) => {
    rememberShellSettled(id)
    state.shellCommands.delete(id)
    state.shellLocations.delete(id)
  }

  const shellLifecycleSnapshot = () => ({
    active: new Set(state.shellActive),
    commands: new Map(state.shellCommands),
    locations: new Map(state.shellLocations),
    started: new Set(state.shellStarted),
    ended: new Set(state.shellEnded),
    settled: new Set(state.shellSettled),
    settledEvents: new Set(state.shellSettledEvents),
  })
  const restoreShellLifecycle = (snapshot: ReturnType<typeof shellLifecycleSnapshot>) => {
    state.shellActive = new Set(snapshot.active)
    state.shellCommands = new Map(snapshot.commands)
    state.shellLocations = new Map(snapshot.locations)
    state.shellStarted = new Set(snapshot.started)
    state.shellEnded = new Set(snapshot.ended)
    state.shellSettled = new Set(snapshot.settled)
    state.shellSettledEvents = new Set(snapshot.settledEvents)
  }

  const updateShellInventoryLocation = (location: LocationRef | undefined) => {
    if (!location || shellInventoryLocation?.directory === location.directory) return
    shellInventoryLocation = { directory: location.directory }
    shellInventoryGeneration++
  }

  // The one "go idle" transition, shared by settlement, terminal events, and the
  // interrupt ack so the flag and the paint cannot drift apart. A shell can
  // outlive the root execution, so it owns the running state until its ended
  // event arrives.
  const paintIdle = (status: string) => {
    state.rootActive = false
    if (hasActiveShells()) {
      write([], { phase: "running", status: "running shell", activeShells: state.shellActive.size })
      return
    }
    write([], { phase: "idle", status, activeShells: 0 })
  }

  const paintAfterShellSettlement = () => {
    if (hasActiveShells()) {
      write([], { phase: "running", status: "running shell", activeShells: state.shellActive.size })
      return
    }
    if (state.rootActive) {
      write([], {
        phase: "running",
        status: state.view.type === "prompt" ? "assistant responding" : blockerStatus(state.view),
        activeShells: 0,
      })
      return
    }
    if (!state.wait) write([], { phase: "idle", status: "", activeShells: 0 })
  }

  const write = (
    commits: StreamCommit[],
    patch?: Pick<FooterPatch, "activeShells" | "phase" | "status" | "usage">,
  ) => {
    if (state.closed || controller.signal.aborted || input.footer.isClosed) return
    if (deferredCommits) {
      deferredCommits.push(...commits)
      if (!patch) return
      commits = []
    }
    if (!state.initial && state.buffered === undefined)
      commits.forEach((commit) => {
        if (!commit.messageID || !commit.partID || (commit.kind !== "assistant" && commit.kind !== "reasoning")) {
          input.onCommit?.(commit)
          return
        }
        const text = state.fragments.value({ messageID: commit.messageID, partID: commit.partID })
        input.onCommit?.({
          ...commit,
          text: commit.kind === "reasoning" && text ? `Thinking: ${text}` : (text ?? commit.text),
        })
      })
    writeSessionOutput(
      { footer: input.footer, trace: input.trace },
      {
        commits,
        updates: patch
          ? [
              {
                type: "stream.patch",
                patch:
                  hasActiveShells() || "activeShells" in patch
                    ? { ...patch, activeShells: state.shellActive.size }
                    : patch,
              },
            ]
          : undefined,
      },
    )
  }

  let syncedPending: string[] | undefined
  const syncPending = () => {
    const prompts = [...state.pending.values()]
    const ids = prompts.map((item) => `${item.messageID}:${item.delivery}`)
    if (syncedPending?.length === ids.length && syncedPending.every((id, index) => id === ids[index])) return
    syncedPending = ids
    input.trace?.write("ui.patch", { pending: prompts.length })
    input.footer.event({ type: "queued.prompts", prompts })
  }

  const freshImages = (commits: ImageCommit[], render = true) =>
    commits.filter((commit) => {
      const key = streamPartKey(commit.messageID, commit.partID)
      if (state.imageIDs.has(key)) return false
      state.imageIDs.add(key)
      return render
    })

  const renderUser = (
    messageID: string,
    text: string,
    files: SessionMessageUser["files"],
    skills: FooterQueuedPrompt["skills"],
    render = true,
  ) => {
    const visible = state.messageIDs.has(messageID)
    state.messageIDs.add(messageID)
    const images = freshImages(userImageCommits(messageID, files), render)
    if (!render) return
    write([
      ...(!visible && showTools() ? skillCommits(messageID, skills) : []),
      ...(!visible && text.trim()
        ? [{ kind: "user", source: "system", text, phase: "start", messageID } as const]
        : []),
      ...images,
    ])
  }

  const mergePending = (item: SessionInboxInfo) => {
    const prompt = pendingPrompt(item)
    if (!prompt) return
    if (state.promotedMessages.has(prompt.messageID)) {
      renderUser(prompt.messageID, prompt.prompt.text, prompt.files, prompt.skills)
      return
    }
    state.admitted.add(prompt.messageID)
    state.pending.set(prompt.messageID, prompt)
    syncPending()
  }

  const promoteWait = (wait: Wait, observed: boolean, messageID = wait.messageID) => {
    const transition = messageID !== wait.failureMessageID || (observed ? !wait.promotionObserved : !wait.promoted)
    wait.promoted = true
    if (observed) wait.promotionObserved = true
    if (!transition) return
    wait.failureMessageID = messageID
    wait.failureRendered = false
    wait.terminalError = undefined
  }

  const syncBlockers = () => {
    if (state.closed || controller.signal.aborted || input.footer.isClosed) return
    const descendant = subagents.snapshot()
    const next = pickBlockerView({
      permission: state.permissions[0] ?? descendant.permissions[0],
      form: state.forms[0] ?? descendant.forms[0] ?? state.globalForms[0],
    })
    if (next.type === "prompt" && state.view.type === "prompt") return
    if (next.type !== "prompt" && state.view.type === next.type && next.request.id === state.view.request.id) return
    state.view = next
    writeSessionOutput(
      { footer: input.footer, trace: input.trace },
      {
        commits: [],
        updates: [
          {
            type: "stream.patch",
            patch:
              next.type === "prompt"
                ? {
                    ...(hasActiveShells() ? { activeShells: state.shellActive.size } : {}),
                    phase: state.rootActive || hasActiveShells() ? "running" : "idle",
                    status: state.rootActive
                      ? "assistant responding"
                      : hasActiveShells()
                        ? "running shell"
                        : blockerStatus(next),
                  }
                : {
                    ...(hasActiveShells() ? { activeShells: state.shellActive.size } : {}),
                    status: blockerStatus(next),
                  },
          },
          { type: "stream.view", view: next },
        ],
      },
    )
  }

  const sourcePending = (key: string) =>
    state.permissions.some(
      (request) =>
        request.source?.type === "tool" && permissionSourceKey(request.source.messageID, request.source.id) === key,
    )

  const pruneToolSources = () => {
    for (const key of state.toolSources.keys()) {
      if (!state.tools.has(key) && !sourcePending(key)) state.toolSources.delete(key)
    }
  }

  const showTools = () => input.tools !== false

  const rememberToolMessage = (messageID: string) => {
    state.toolMessages.add(messageID)
    state.quietText.delete(messageID)
  }

  const bufferQuietText = (messageID: string, partID: string, text: string, replace: boolean) => {
    if (!text || state.toolMessages.has(messageID)) return
    const parts = state.quietText.get(messageID) ?? []
    const current = parts.find((part) => part.partID === partID)
    if (current) {
      current.text = replace ? text : current.text + text
      return
    }
    parts.push({ partID, text })
    state.quietText.set(messageID, parts)
  }

  const flushQuietText = (messageID: string) => {
    const parts = state.quietText.get(messageID)
    state.quietText.delete(messageID)
    if (!parts || state.toolMessages.has(messageID)) return
    write(
      parts
        .filter((part) => part.text)
        .map((part) => ({
          kind: "assistant" as const,
          source: "assistant" as const,
          text: part.text,
          phase: "progress" as const,
          messageID,
          partID: part.partID,
        })),
    )
  }

  const renderTool = (messageID: string, item: SessionMessageAssistantTool, render = true) => {
    if (!showTools()) {
      rememberToolMessage(messageID)
      render = false
    }
    const part = normalizeTool(item)
    const key = permissionSourceKey(messageID, part.id)
    if (state.finishedTools.has(key)) {
      if (sourcePending(key)) state.toolSources.set(key, part)
      else state.toolSources.delete(key)
      return
    }
    state.toolSources.set(key, part)
    if (part.state.status === "streaming") {
      state.tools.set(key, { part, output: "", version: 0, started: false })
      return
    }
    const current = state.tools.get(key)
    const output = toolOutputText(part.name, toolDisplayContent(part.state))
    const prefix = current ? output.startsWith(current.output) : false
    const version = current && !prefix ? current.version + 1 : (current?.version ?? 0)
    const delta = current && prefix ? output.slice(current.output.length) : output
    if (part.state.status === "running") {
      const started = current?.started === true
      const ready = part.name !== "websearch" || typeof part.state.metadata.provider === "string"
      if (render && !started && ready)
        write([toolCommit(part, messageID, "start", undefined, input.location?.directory, version)], {
          phase: "running",
          status: `running ${part.name}`,
        })
      if (render && delta) write([toolCommit(part, messageID, "progress", delta, input.location?.directory, version)])
      state.tools.set(key, { part, output, version, started: started || (render && ready) })
      return
    }
    if (render && !current?.started)
      write([toolCommit(part, messageID, "start", undefined, input.location?.directory, version)])
    state.finishedTools.add(key)
    state.tools.delete(key)
    if (!sourcePending(key)) state.toolSources.delete(key)
    const images = freshImages(toolImageCommits(part, messageID), render)
    if (!render) return
    const phase = toolFinalPhase(part)
    if (part.state.status === "error" && delta)
      write([toolCommit(part, messageID, "progress", delta, input.location?.directory, version)])
    write([
      toolCommit(part, messageID, phase, phase === "progress" ? delta : undefined, input.location?.directory, version),
      ...images,
    ])
  }

  const renderMessage = (message: SessionMessageInfo, render: boolean, projectedSourceLocation?: string) => {
    if (message.type === "user") {
      const waiting = state.wait?.messageID === message.id
      const admitted = state.admitted.delete(message.id)
      if (state.wait && (admitted || (waiting && state.wait.failureMessageID === message.id)))
        promoteWait(state.wait, false, message.id)
      if (state.pending.delete(message.id)) syncPending()
      state.promotedMessages.add(message.id)
      renderUser(message.id, message.text, message.files, message.skills, render)
      return
    }
    if (message.type === "skill") {
      if (state.wait?.messageID === message.id) promoteWait(state.wait, false)
      if (!render || !showTools() || state.skillMessages.has(message.id)) {
        state.skillMessages.add(message.id)
        return
      }
      state.skillMessages.add(message.id)
      write([skillCommit(message.id, message.name)])
      return
    }
    if (message.type === "location-switched") {
      updateShellInventoryLocation(message.location)
      return
    }
    if (message.type === "shell") {
      if (state.shellWait?.messageID === message.id) state.shellWait.id = message.shellID
      const completed = message.time.completed !== undefined
      const ended = state.shellEnded.has(message.shellID)
      const settled = state.shellSettled.has(message.shellID)
      if (!completed && (ended || settled)) return
      if (completed) {
        state.shellActive.delete(message.shellID)
        rememberBounded(state.shellStarted, message.shellID)
        rememberBounded(state.shellEnded, message.shellID)
        settleShell(message.shellID)
      } else if (!ended) {
        rememberBounded(state.shellStarted, message.shellID)
        // Projected shell messages do not carry their execution Location. Only
        // use a Location supplied by the projected history's move context; an
        // unknown origin must not be attributed to the current inventory.
        rememberShellLocation(message.shellID, projectedSourceLocation)
        state.shellCommands.set(message.shellID, message.command)
        state.shellActive.add(message.shellID)
      }
      if (!render) {
        // Suppressed history updates lifecycle facts only. The rendered sets
        // describe this transcript, so a later live event may fill a missing
        // shell phase without reviving the shell lifecycle.
        return
      }
      const commits: StreamCommit[] = []
      if (!state.shellRenderedStarted.has(message.shellID)) {
        rememberShellRenderedStarted(message.shellID)
        commits.push(
          shellCommit(message.shellID, message.command, {
            text: "running shell",
            phase: "start",
            toolState: "running",
          }),
        )
      }
      if (completed && message.output && !state.shellRenderedEnded.has(message.shellID)) {
        rememberShellRenderedEnded(message.shellID)
        commits.push(...shellTerminal(message.shellID, message.command, message, message.output))
      }
      if (commits.length) {
        write(commits)
      }
      if (completed && state.shellWait?.id === message.shellID) state.shellWait.resolve()
      return
    }
    if (message.type === "compaction") {
      const visible = state.messageIDs.has(message.id)
      state.messageIDs.add(message.id)
      if (message.status === "running") state.activeCompaction = message.id
      if (message.status !== "running" && state.activeCompaction === message.id) state.activeCompaction = undefined
      if (visible) return
      if (message.status === "failed") {
        if (render && message.error.type !== "aborted")
          write([compactionCommit(message.id), compactionError(message.id, message.error.message)])
        return
      }
      const fragment = { messageID: message.id, partID: "compaction:summary" }
      const show = render || message.status === "running"
      state.fragments.project(fragment, message.summary, show)
      if (!show) return
      write([
        compactionCommit(message.id),
        ...(message.summary ? [compactionSummary(message.id, message.summary, "progress")] : []),
        ...(message.status === "completed" ? [compactionSummary(message.id, "", "final")] : []),
      ])
      return
    }
    if (message.type !== "assistant") return
    state.messageIDs.add(message.id)
    const hasTools = message.content.some((item) => item.type === "tool")
    if (hasTools) rememberToolMessage(message.id)
    let textOrdinal = 0
    let reasoningOrdinal = 0
    for (const item of message.content) {
      if (item.type === "text") {
        const fragment = fragmentRef(message.id, "text", textOrdinal++)
        const visible = render && (showTools() || !hasTools)
        const update = state.fragments.project(fragment, item.text, visible)
        if (visible && item.text.length > update.previous.length)
          write([
            {
              kind: "assistant",
              source: "assistant",
              text: item.text.slice(update.previous.length),
              phase: "progress",
              messageID: message.id,
              partID: fragment.partID,
            },
          ])
        continue
      }
      if (item.type === "reasoning") {
        const fragment = fragmentRef(message.id, "reasoning", reasoningOrdinal++)
        const update = state.fragments.project(fragment, item.text, render)
        if (render && input.thinking && item.text.length > update.previous.length)
          write([
            {
              kind: "reasoning",
              source: "reasoning",
              text: update.previous.length === 0 ? `Thinking: ${item.text}` : item.text.slice(update.previous.length),
              phase: "progress",
              messageID: message.id,
              partID: fragment.partID,
            },
          ])
        continue
      }
      renderTool(message.id, item, render)
    }
    if (message.error && !state.errors.has(message.id)) {
      state.errors.add(message.id)
      if (!render) return
      if (state.wait) state.wait.failureRendered = true
      write([
        {
          kind: "error",
          source: "system",
          text: errorMessage(message.error),
          phase: "start",
          messageID: message.id,
        },
      ])
    }
  }

  const projectedMessages = async (client: OpenCodeClient, signal: AbortSignal) =>
    (
      await client.message.list(
        { sessionID: input.sessionID, limit: input.replayLimit ?? 200, order: "desc" },
        { signal },
      )
    ).data.toReversed()

  const renderProjectedMessages = (messages: SessionMessageInfo[], render: boolean) => {
    let sourceLocation: string | undefined
    for (const message of messages) {
      renderMessage(message, render, sourceLocation)
      if (message.type === "location-switched") sourceLocation = message.location.directory
    }
  }

  const shellInventory = async (client: OpenCodeClient, attempt: Attempt) => {
    const requestedLocation = shellInventoryLocation
    const requestedGeneration = shellInventoryGeneration
    const timeout = new AbortController()
    const signal = AbortSignal.any([attempt.signal, timeout.signal])
    const request = Promise.resolve()
      .then(() =>
        client.shell.list(
          requestedLocation ? { location: { directory: requestedLocation.directory } } : undefined,
          { signal },
        ),
      )
      .then(async (response) => {
        // Let a same-tick event delivery populate the replay buffer before
        // accepting the response. Move events are intentionally buffered
        // during resize hydration, but still invalidate this request.
        await wait(0, signal)
        if (requestedGeneration !== shellInventoryGeneration) return undefined
        if (requestedLocation?.directory !== shellInventoryLocation?.directory) return undefined
        if (
          state.buffered?.attempt === attempt &&
          state.buffered.events.some((event) => event.type === "session.moved" && sessionID(event) === input.sessionID)
        )
          return undefined
        if (requestedLocation && response.location.directory !== requestedLocation.directory) return undefined
        return { response, requestedLocation, requestedGeneration }
      })
      .catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        timeout.abort()
        resolve(undefined)
      }, 1000)
    })
    try {
      return await Promise.race([request, bounded])
    } finally {
      if (timer) clearTimeout(timer)
      timeout.abort()
    }
  }

  const settleSession = async (client: OpenCodeClient) => {
    await client.session.wait({ sessionID: input.sessionID }, { signal: controller.signal })
    renderProjectedMessages(await projectedMessages(client, controller.signal), true)
    paintIdle(blockerStatus(state.view))
    await input.footer.idle()
  }

  const resolvePermissionSources = async (
    client: OpenCodeClient,
    permissions: PermissionRequest[],
    attempt: Attempt,
  ) => {
    const pending = new Set(
      permissions.flatMap((request) =>
        request.source?.type === "tool" ? [permissionSourceKey(request.source.messageID, request.source.id)] : [],
      ),
    )
    const messageIDs = [
      ...new Set(
        permissions.flatMap((request) => {
          if (request.source?.type !== "tool") return []
          const key = permissionSourceKey(request.source.messageID, request.source.id)
          return state.toolSources.has(key) ? [] : [request.source.messageID]
        }),
      ),
    ]
    const messages = await Promise.allSettled(
      messageIDs.map((messageID) =>
        client.session.message.get({ sessionID: input.sessionID, messageID }, { signal: attempt.signal }),
      ),
    )
    if (!current(attempt)) return permissions
    for (const result of messages) {
      if (result.status !== "fulfilled" || result.value.type !== "assistant") continue
      for (const item of result.value.content) {
        if (item.type !== "tool") continue
        const key = permissionSourceKey(result.value.id, item.id)
        if (pending.has(key)) state.toolSources.set(key, normalizeTool(item))
      }
    }
    return permissions.map((request) => permissionTool(request, state.toolSources))
  }

  const hydrateState = async (attempt: Attempt, next: HydrateOptions) => {
    const client = attempt.client
    const options = { signal: attempt.signal }
    const knownActive = new Set(state.shellActive)
    const [projected, pending, permissions, forms, globals, active] = await Promise.all([
      projectedMessages(client, attempt.signal),
      client.session.inbox.list({ sessionID: input.sessionID }, options),
      client.permission.list({ sessionID: input.sessionID }, options),
      client.session.form.list({ sessionID: input.sessionID }, options),
      input.location
        ? client.form.list(
            {
              location: { directory: input.location.directory },
            },
            options,
          )
        : Promise.resolve(undefined),
      client.session.active(options),
    ])
    if (!current(attempt)) return
    state.pending = new Map(
      pending.flatMap((item) => {
        const prompt = pendingPrompt(item)
        return prompt ? [[prompt.messageID, prompt] as const] : []
      }),
    )
    syncPending()
    state.permissions = permissions
    pruneToolSources()
    renderProjectedMessages(projected, next.render)
    const projectedActive = new Set(state.shellActive)
    const inventory = await shellInventory(client, attempt)
    if (!current(attempt)) return
    const inventoryCurrent =
      inventory &&
      inventory.requestedGeneration === shellInventoryGeneration &&
      inventory.requestedLocation?.directory === shellInventoryLocation?.directory &&
      !(
        state.buffered?.attempt === attempt &&
        state.buffered.events.some((event) => event.type === "session.moved" && sessionID(event) === input.sessionID)
      )
    if (inventoryCurrent) {
      const inventoryLocation = inventory.response.location.directory
      const running = new Set(
        inventory.response.data.flatMap((shell) =>
          shell.status === "running" &&
          shell.metadata.sessionID === input.sessionID &&
          !state.shellSettled.has(shell.id)
            ? [shell.id]
            : [],
        ),
      )
      for (const shell of inventory.response.data) {
        if (running.has(shell.id)) rememberShellLocation(shell.id, inventoryLocation)
      }
      const previousActive = new Set(
        [...knownActive, ...projectedActive].filter((id) => !state.shellSettled.has(id)),
      )
      const preserved = new Set<string>()
      for (const id of previousActive) {
        if (running.has(id)) continue
        // shell.list is scoped to one Location. A shell observed in another
        // Location, or one whose origin is not known, is still live from this
        // session's point of view and must not be settled by this inventory.
        if (state.shellLocations.get(id) === inventoryLocation) settleShell(id)
        else preserved.add(id)
      }
      state.shellActive.clear()
      for (const id of preserved) state.shellActive.add(id)
      for (const id of running) state.shellActive.add(id)
    }
    state.permissions = await resolvePermissionSources(client, permissions, attempt)
    if (!current(attempt)) return
    pruneToolSources()
    state.forms = forms
    state.globalForms = globals
      ? globals.data.filter((form) => form.sessionID === "global").map((form) => globalForm(form, globals.location))
      : []
    state.rootActive = input.sessionID in active
    syncBlockers()
    await subagents.hydrate({
      sdk: client,
      messages: [...projected],
      active,
      signal: attempt.signal,
      reconnect: next.reconnect,
    })
    if (!current(attempt)) return
    write([], {
      phase: state.rootActive || hasActiveShells() ? "running" : "idle",
      status: state.rootActive ? "assistant responding" : hasActiveShells() ? "running shell" : blockerStatus(state.view),
      activeShells: state.shellActive.size,
    })
    if (!state.rootActive && !hasActiveShells() && !next.reconnect) await input.footer.idle()
    if (!current(attempt)) return
  }

  const hydrate = async (attempt: Attempt, next: HydrateOptions) => {
    const snapshot = shellLifecycleSnapshot()
    try {
      await hydrateState(attempt, next)
    } catch (error) {
      if (current(attempt)) restoreShellLifecycle(snapshot)
      throw error
    }
  }

  const apply = (attempt: Attempt, event: RunV2Event) => {
    if (!current(attempt)) return
    const client = attempt.client
    if (catalogEvents.has(event.type)) {
      if (input.location && event.location && event.location.directory !== input.location.directory)
        return
      void refreshCatalog(attempt)
      return
    }
    const source = sessionID(event)
    if (
      source === "global" &&
      (event.type === "form.created" || event.type === "form.replied" || event.type === "form.cancelled")
    ) {
      if (!sameLocation(event.location, input.location)) return
      if (event.type === "form.created") {
        if (!state.globalForms.some((item) => item.id === event.data.form.id))
          state.globalForms.push(globalForm(event.data.form, event.location!))
      } else {
        state.globalForms = state.globalForms.filter((item) => item.id !== event.data.id)
      }
      syncBlockers()
      return
    }
    if (source !== input.sessionID) {
      if (source) subagents.foreign(client, source, event, attempt.signal)
      return
    }
    input.trace?.write("recv.event", event)
    subagents.main(client, event, attempt.signal)
    if (event.type === "session.renamed") {
      input.onSessionTitle?.(event.data.title)
      return
    }
    if (event.type === "session.moved") {
      updateShellInventoryLocation(event.data.location)
      return
    }
    if (event.type === "session.inbox.enqueued") {
      if (event.data.item.type !== "user") return
      mergePending({
        id: event.data.inboxID,
        sessionID: event.data.sessionID,
        time: { created: event.created },
        ...event.data.item,
      })
      return
    }
    if (event.type === "session.inbox.delivered") {
      if (state.wait) promoteWait(state.wait, true, event.data.inboxID)
      state.admitted.delete(event.data.inboxID)
      state.promotedMessages.add(event.data.inboxID)
      const pending = state.pending.get(event.data.inboxID)
      state.pending.delete(event.data.inboxID)
      syncPending()
      if (pending) renderUser(pending.messageID, pending.prompt.text, pending.files, pending.skills)
      write([], { phase: "running", status: "waiting for assistant" })
      return
    }
    if (event.type === "session.inbox.delivery.changed") {
      const pending = state.pending.get(event.data.inboxID)
      if (!pending) return
      state.pending.set(event.data.inboxID, { ...pending, delivery: event.data.delivery })
      syncPending()
      return
    }
    if (event.type === "session.inbox.cancelled") {
      state.admitted.delete(event.data.inboxID)
      if (state.pending.delete(event.data.inboxID)) syncPending()
      return
    }
    if (event.type === "session.step.started") {
      state.stepModel = { providerID: event.data.model.providerID, modelID: event.data.model.id }
      write([], { phase: "running", status: "assistant responding" })
      return
    }
    if (event.type === "session.skill.activated") {
      const messageID = messageIDFromEvent(event.id)
      if (state.wait?.messageID === messageID) promoteWait(state.wait, true)
      if (state.skillMessages.has(messageID)) return
      state.skillMessages.add(messageID)
      if (showTools()) write([skillCommit(messageID, event.data.name)])
      return
    }
    if (event.type === "session.compaction.started") {
      const messageID = event.data.inputID ?? messageIDFromEvent(event.id)
      state.activeCompaction = messageID
      if (state.messageIDs.has(messageID)) return
      state.messageIDs.add(messageID)
      write([compactionCommit(messageID)], { phase: "running", status: "compacting session" })
      return
    }
    if (event.type === "session.compaction.delta") {
      if (!state.activeCompaction) return
      const fragment = { messageID: state.activeCompaction, partID: "compaction:summary" }
      if (!state.fragments.delta(fragment, event.data.text)) return
      write([compactionSummary(state.activeCompaction, event.data.text, "progress")])
      return
    }
    if (event.type === "session.compaction.ended") {
      if (!state.activeCompaction) return
      const messageID = state.activeCompaction
      state.activeCompaction = undefined
      const update = state.fragments.end({ messageID, partID: "compaction:summary" }, event.data.text)
      write([
        ...(event.data.text.length > update.previous.length
          ? [compactionSummary(messageID, event.data.text.slice(update.previous.length), "progress")]
          : []),
        compactionSummary(messageID, "", "final"),
      ])
      return
    }
    if (event.type === "session.compaction.failed") {
      if (!state.activeCompaction) return
      const messageID = state.activeCompaction
      state.activeCompaction = undefined
      if (event.data.error.type === "aborted") {
        write([compactionSummary(messageID, "", "final")])
        return
      }
      write([compactionSummary(messageID, "", "final"), compactionError(messageID, event.data.error.message)])
      return
    }
    if (event.type === "session.shell.started") {
      const wait = state.shellWait
      const unobservedSettledRequest =
        state.shellSettledEvents.has(event.id) ||
        (wait?.eventID === event.id && wait.settled === true && wait.id === undefined)
      if (unobservedSettledRequest) {
        state.shellSettledEvents.delete(event.id)
        rememberShellSettled(event.data.shell.id)
        if (wait?.eventID === event.id) wait.id = event.data.shell.id
        return
      }
      const id = event.data.shell.id
      if (state.shellEnded.has(id) || state.shellSettled.has(id)) return
      rememberShellLocation(id, event.location?.directory ?? event.data.shell.cwd)
      state.shellCommands.set(id, event.data.shell.command)
      if (wait?.eventID === event.id) wait.id = id
      if (!state.shellStarted.has(id)) rememberBounded(state.shellStarted, id)
      const active = state.shellActive.has(id)
      state.shellActive.add(id)
      if (active && state.shellRenderedStarted.has(id)) return
      const commits = state.shellRenderedStarted.has(id)
        ? []
        : [
            shellCommit(id, event.data.shell.command, {
              text: "running shell",
              phase: "start",
              toolState: "running",
            }),
          ]
      if (commits.length) rememberShellRenderedStarted(id)
      write(
        commits,
        {
          phase: "running",
          status: "running shell",
          activeShells: state.shellActive.size,
        },
      )
      return
    }
    if (event.type === "session.shell.ended") {
      const id = event.data.shell.id
      rememberShellLocation(id, event.location?.directory ?? event.data.shell.cwd)
      const command = state.shellCommands.get(id) ?? event.data.shell.command
      const commits: StreamCommit[] = []
      if (!state.shellStarted.has(id)) rememberBounded(state.shellStarted, id)
      if (!state.shellRenderedStarted.has(id)) {
        if (command)
          commits.push(
            shellCommit(id, command, { text: "running shell", phase: "start", toolState: "running" }),
          )
        if (command) rememberShellRenderedStarted(id)
      }
      if (!state.shellEnded.has(id)) rememberBounded(state.shellEnded, id)
      if (!state.shellRenderedEnded.has(id)) {
        rememberShellRenderedEnded(id)
        commits.push(...shellTerminal(id, command, event.data.shell, event.data.output))
      }
      settleShell(id)
      state.shellActive.delete(id)
      const wait = state.shellWait
      const owned = wait?.id === id
      const patch = hasActiveShells()
        ? { phase: "running" as const, status: "running shell", activeShells: state.shellActive.size }
        : state.rootActive
          ? {
              phase: "running" as const,
              status: state.view.type === "prompt" ? "assistant responding" : blockerStatus(state.view),
              activeShells: 0,
            }
          : { activeShells: 0 }
      write(commits, patch)
      if (owned) wait.resolve()
      if (!state.wait && !state.rootActive && (!state.shellWait || owned)) paintIdle("")
      return
    }
    if (event.type === "session.text.started") {
      return
    }
    if (event.type === "session.text.delta") {
      const fragment = fragmentRef(event.data.assistantMessageID, "text", event.data.ordinal)
      if (!state.fragments.delta(fragment, event.data.delta)) return
      if (!showTools()) {
        bufferQuietText(event.data.assistantMessageID, fragment.partID, event.data.delta, false)
        return
      }
      write([
        {
          kind: "assistant",
          source: "assistant",
          text: event.data.delta,
          phase: "progress",
          messageID: event.data.assistantMessageID,
          partID: fragment.partID,
        },
      ])
      return
    }
    if (event.type === "session.text.ended") {
      const update = state.fragments.end(
        fragmentRef(event.data.assistantMessageID, "text", event.data.ordinal),
        event.data.text,
      )
      if (!showTools()) {
        bufferQuietText(event.data.assistantMessageID, update.partID, event.data.text, true)
        return
      }
      if (event.data.text.length > update.previous.length)
        write([
          {
            kind: "assistant",
            source: "assistant",
            text: event.data.text.slice(update.previous.length),
            phase: "progress",
            messageID: event.data.assistantMessageID,
            partID: update.partID,
          },
        ])
      return
    }
    if (event.type === "session.reasoning.started") {
      return
    }
    if (event.type === "session.reasoning.delta") {
      const update = state.fragments.delta(
        fragmentRef(event.data.assistantMessageID, "reasoning", event.data.ordinal),
        event.data.delta,
      )
      if (!update) return
      if (input.thinking)
        write([
          {
            kind: "reasoning",
            source: "reasoning",
            text: update.previous ? event.data.delta : `Thinking: ${event.data.delta}`,
            phase: "progress",
            messageID: event.data.assistantMessageID,
            partID: update.partID,
          },
        ])
      return
    }
    if (event.type === "session.reasoning.ended") {
      const update = state.fragments.end(
        fragmentRef(event.data.assistantMessageID, "reasoning", event.data.ordinal),
        event.data.text,
      )
      if (input.thinking && event.data.text.length > update.previous.length)
        write([
          {
            kind: "reasoning",
            source: "reasoning",
            text: update.previous ? event.data.text.slice(update.previous.length) : `Thinking: ${event.data.text}`,
            phase: "progress",
            messageID: event.data.assistantMessageID,
            partID: update.partID,
          },
        ])
      return
    }
    if (event.type === "session.tool.input.started") {
      renderTool(event.data.assistantMessageID, {
        type: "tool",
        id: event.data.id,
        name: event.data.name,
        state: { status: "streaming", input: "" },
        time: { created: event.created },
      })
      return
    }
    if (event.type === "session.tool.input.delta" || event.type === "session.tool.input.ended") {
      const current = state.tools.get(streamPartKey(event.data.assistantMessageID, event.data.id))
      if (!current || current.part.state.status !== "streaming") return
      renderTool(event.data.assistantMessageID, {
        ...current.part,
        state: {
          status: "streaming",
          input:
            event.type === "session.tool.input.ended" ? event.data.text : current.part.state.input + event.data.delta,
        },
      })
      return
    }
    if (event.type === "session.tool.called") {
      const key = streamPartKey(event.data.assistantMessageID, event.data.id)
      if (state.finishedTools.has(key)) return
      const current = state.tools.get(key)
      const item: SessionMessageAssistantTool = {
        type: "tool",
        id: event.data.id,
        name: current?.part.name ?? "tool",
        executed: event.data.executed,
        providerState: event.data.state,
        state: { status: "running", input: event.data.input, metadata: {} },
        time: { created: current?.part.time.created ?? event.created, ran: event.created },
      }
      renderTool(event.data.assistantMessageID, item)
      return
    }
    if (event.type === "session.tool.progress") {
      const key = streamPartKey(event.data.assistantMessageID, event.data.id)
      if (state.finishedTools.has(key)) return
      const current = state.tools.get(key)
      const part = current?.part
      renderTool(event.data.assistantMessageID, {
        type: "tool",
        id: event.data.id,
        name: part?.name ?? "tool",
        executed: part?.executed,
        providerState: part?.providerState,
        state: {
          status: "running",
          input: part && part.state.status !== "streaming" ? part.state.input : {},
          metadata: event.data.metadata,
        },
        time: { created: part?.time.created ?? event.created, ran: part?.time.ran ?? event.created },
      })
      return
    }
    if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      const current = state.tools.get(streamPartKey(event.data.assistantMessageID, event.data.id))
      const part = current?.part
      const failed = event.type === "session.tool.failed"
      const item: SessionMessageAssistantTool = {
        type: "tool",
        id: event.data.id,
        name: part?.name ?? "tool",
        executed: event.data.executed,
        providerState: part?.providerState,
        providerResultState: event.data.resultState,
        state: failed
          ? {
              status: "error",
              input: part && part.state.status !== "streaming" ? part.state.input : {},
              metadata: event.data.metadata,
              content: event.data.content,
              error: event.data.error,
            }
          : {
              status: "completed",
              input: part && part.state.status !== "streaming" ? part.state.input : {},
              metadata: event.data.metadata,
              content: event.data.content,
            },
        time: { created: part?.time.created ?? event.created, ran: part?.time.ran, completed: event.created },
      }
      renderTool(event.data.assistantMessageID, item)
      return
    }
    if (event.type === "permission.asked") {
      if (!state.permissions.some((item) => item.id === event.data.id))
        state.permissions.push(permissionTool(event.data, state.toolSources))
      syncBlockers()
      return
    }
    if (event.type === "permission.replied") {
      state.permissions = state.permissions.filter((item) => item.id !== event.data.requestID)
      pruneToolSources()
      syncBlockers()
      return
    }
    if (event.type === "form.created") {
      if (!state.forms.some((item) => item.id === event.data.form.id)) state.forms.push(event.data.form)
      syncBlockers()
      return
    }
    if (event.type === "form.replied" || event.type === "form.cancelled") {
      state.forms = state.forms.filter((item) => item.id !== event.data.id)
      syncBlockers()
      return
    }
    if (event.type === "session.step.ended") {
      const total =
        event.data.tokens.input +
        event.data.tokens.output +
        event.data.tokens.reasoning +
        event.data.tokens.cache.read +
        event.data.tokens.cache.write
      const limit = state.stepModel ? input.contextLimit?.(state.stepModel) : undefined
      state.stepModel = undefined
      if (!showTools()) flushQuietText(event.data.assistantMessageID)
      write([], {
        usage:
          total > 0 || event.data.cost
            ? {
                tokens: total,
                percent: limit ? Math.round((total / limit) * 100) : undefined,
                cost: event.data.cost || undefined,
              }
            : undefined,
      })
      return
    }
    if (event.type === "session.step.failed") {
      state.stepModel = undefined
      if (!showTools()) flushQuietText(event.data.assistantMessageID)
      const rendered = state.errors.has(event.data.assistantMessageID)
      state.errors.add(event.data.assistantMessageID)
      if (state.wait) state.wait.failureRendered = true
      if (rendered) return
      write([
        {
          kind: "error",
          source: "system",
          text: errorMessage(event.data.error),
          phase: "start",
          messageID: event.data.assistantMessageID,
        },
      ])
      return
    }
    if (event.type === "session.execution.started") {
      state.executionEpoch++
      state.rootActive = true
      write([], { phase: "running" })
      return
    }
    if (
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      state.executionEpoch++
      if (!showTools()) for (const messageID of [...state.quietText.keys()]) flushQuietText(messageID)
      paintIdle("")
      const current = state.wait
      if (!current) return
      if (current.interrupted && event.type === "session.execution.interrupted" && event.data.reason === "user") {
        return
      }
      if (event.type === "session.execution.failed") {
        if (!current.failureRendered) current.terminalError = new Error(errorMessage(event.data.error))
        return
      }
      if (event.type === "session.execution.interrupted") {
        current.terminalError = new Error(`Session interrupted: ${event.data.reason}`)
      }
    }
  }

  const receive = (attempt: Attempt, event: RunV2Event) => {
    if (!current(attempt)) return
    if (state.buffered?.attempt === attempt) {
      if (event.type === "session.moved" && sessionID(event) === input.sessionID)
        updateShellInventoryLocation(event.data.location)
      state.buffered.events.push(event)
      return
    }
    apply(attempt, event)
  }

  const hydration = new Map<number, Promise<void>>()
  const serializeHydration = <A>(attempt: Attempt, run: () => Promise<A>) => {
    const previous = hydration.get(attempt.generation) ?? Promise.resolve()
    const task = previous.then(run, run)
    const tail = task.then(
      () => {},
      () => {},
    )
    hydration.set(attempt.generation, tail)
    void tail.then(() => {
      if (hydration.get(attempt.generation) === tail) hydration.delete(attempt.generation)
    })
    return task
  }
  const settleHydration = async () => {
    while (hydration.size > 0) await Promise.all(hydration.values())
  }

  const catalogRefreshes = new Map<number, Set<Promise<void>>>()
  const refreshCatalog = (attempt: Attempt) => {
    if (!current(attempt)) return Promise.resolve()
    const task = Promise.resolve(input.onCatalogRefresh?.(attempt.signal))
      .then(() => {})
      .catch(() => {})
    const refreshes = catalogRefreshes.get(attempt.generation) ?? new Set()
    refreshes.add(task)
    catalogRefreshes.set(attempt.generation, refreshes)
    void task.finally(() => {
      refreshes.delete(task)
      if (refreshes.size === 0 && catalogRefreshes.get(attempt.generation) === refreshes)
        catalogRefreshes.delete(attempt.generation)
    })
    return task
  }
  const settleCatalogRefreshes = async () => {
    while (catalogRefreshes.size > 0)
      await Promise.all([...catalogRefreshes.values()].flatMap((refreshes) => [...refreshes]))
  }

  const connect = async () => {
    while (!controller.signal.aborted && !input.footer.isClosed) {
      const client = sdk
      const error = await (async () => {
        const connection = new AbortController()
        const abortConnection = () => connection.abort()
        controller.signal.addEventListener("abort", abortConnection, { once: true })
        const attempt = { client, signal: connection.signal, generation: ++generation }
        const stream = client.event.subscribe({ signal: connection.signal })[Symbol.asyncIterator]()
        activeAttempt = attempt
        try {
          const first = await nextEvent(stream, connection.signal)
          if (first.done || first.value.type !== "server.connected") throw new Error("Event stream disconnected")
          const buffered: RunV2Event[] = []
          let booting = true
          const consume = (async () => {
            while (true) {
              const next = await nextEvent(stream, connection.signal)
              if (next.done) throw new Error("Event stream disconnected")
              if (booting) {
                // Hydration and the event consumer race. Observe moves while
                // events are buffered so an in-flight inventory response is
                // invalidated before it can reconcile the old Location.
                if (next.value.type === "session.moved" && sessionID(next.value) === input.sessionID)
                  updateShellInventoryLocation(next.value.data.location)
                buffered.push(next.value)
              }
              else receive(attempt, next.value)
            }
          })()
          await Promise.race([
            serializeHydration(attempt, () =>
              hydrate(attempt, {
                render: state.initial ? input.replay === true : true,
                reconnect: !state.initial,
              }),
            ),
            consume,
          ])
          if (!current(attempt)) throw new Error("Event stream disconnected")
          state.initial = false
          for (const event of buffered.splice(0)) apply(attempt, event)
          if (!current(attempt)) throw new Error("Event stream disconnected")
          booting = false
          state.connected = true
          readyResolve()
          void refreshCatalog(attempt)
          await consume
        } finally {
          connection.abort()
          if (activeAttempt === attempt) activeAttempt = undefined
          if (state.buffered?.attempt === attempt) state.buffered = undefined
          if (generation === attempt.generation) generation++
          controller.signal.removeEventListener("abort", abortConnection)
          void stream.return?.(undefined).catch(() => {})
        }
      })().catch((error) => error)
      state.connected = false
      if (controller.signal.aborted || input.footer.isClosed) return
      input.trace?.write("recv.reconnect", { error: formatUnknownError(error) })
      write([], { phase: "running", status: "reconnecting" })
      if (input.reconnect) {
        try {
          const next = await input.reconnect(controller.signal)
          if (controller.signal.aborted || input.footer.isClosed) return
          sdk = next
          input.onClient?.(next)
        } catch (resolveError) {
          if (controller.signal.aborted || input.footer.isClosed) return
          input.trace?.write("recv.reresolve", { error: formatUnknownError(resolveError) })
        }
      }
      await wait(250, controller.signal)
    }
  }
  const connection = connect()
  try {
    await ready
  } catch (error) {
    offFooterClose()
    controller.abort()
    await connection.catch(() => {})
    await settleHydration()
    await settleCatalogRefreshes()
    await subagents.ready()
    throw error
  } finally {
    controller.signal.removeEventListener("abort", abortReady)
  }

  const runShellTurn = async (next: SessionTurnInput) => {
    if (state.wait || state.shellWait) throw new Error("prompt already running")
    await waitUntilConnected(next.signal)
    const client = sdk
    const abort = new AbortController()
    const onAbort = () => abort.abort()
    next.signal?.addEventListener("abort", onAbort, { once: true })
    let rendered!: () => void
    const output = new Promise<void>((resolve) => {
      rendered = resolve
    })
    const messageID = SessionMessage.ID.create()
    const eventID = eventIDFromMessage(messageID)
    const active: ShellWait = {
      eventID,
      messageID,
      resolve: rendered,
      abort: () => abort.abort(),
    }
    state.shellWait = active
    input.trace?.write("send.shell", { sessionID: input.sessionID, id: messageID, command: next.prompt.text })
    write([], { phase: "running", status: "running shell" })
    try {
      await client.session.shell(
        { sessionID: input.sessionID, id: messageID, command: next.prompt.text },
        { signal: abort.signal },
      )
      active.settled = true
      if (active.id) {
        settleShell(active.id)
        state.shellActive.delete(active.id)
      } else rememberShellSettledEvent(active.eventID)
      // HTTP success settles this foreground shell only. A root execution can
      // still be active (and other background shells may still be running), so
      // do not use paintIdle here: that transition intentionally clears the
      // root lifecycle flag.
      paintAfterShellSettlement()
      await Promise.race([output, wait(SHELL_OUTPUT_GRACE_MS, abort.signal)])
    } catch (error) {
      if (abort.signal.aborted) return
      throw error
    } finally {
      next.signal?.removeEventListener("abort", onAbort)
      if (state.shellWait === active) state.shellWait = undefined
      paintAfterShellSettlement()
    }
  }

  // Prompt-shaped turns complete through the process-local idle fence. Live
  // lifecycle events remain presentation and best-effort outcome metadata.
  const runTurnWait = async (
    next: SessionTurnInput,
    messageID: string,
    client: OpenCodeClient,
    send: () => Promise<SessionInboxInfo | void>,
    onAdmitted?: () => void,
  ) => {
    const active: Wait = {
      messageID,
      failureMessageID: messageID,
      promoted: false,
      promotionObserved: false,
      interrupted: false,
      failureRendered: false,
    }
    state.wait = active
    const interrupt = () => {
      active.interrupted = true
      void sdk.session.interrupt({ sessionID: input.sessionID, resume: true }).catch(() => {})
    }
    next.signal?.addEventListener("abort", interrupt, { once: true })
    try {
      const admitted = await send()
      if (admitted) mergePending(admitted)
      onAdmitted?.()
      await settleSession(client)
      if (active.terminalError && !active.failureRendered)
        write([
          {
            kind: "error",
            source: "system",
            text: active.terminalError.message,
            phase: "start",
            messageID: active.failureMessageID,
          },
        ])
    } catch (error) {
      if (next.signal?.aborted) return
      throw error
    } finally {
      next.signal?.removeEventListener("abort", interrupt)
      if (state.wait === active) state.wait = undefined
    }
  }

  const performResizeReplay = async (attempt: Attempt, next: SessionResizeReplayInput) => {
    if (!input.replay || !state.connected || !current(attempt) || state.closed || input.footer.isClosed) return false
    const localRows = next.localRows()
    const buffered: RunV2Event[] = []
    const replayBuffer = { attempt, events: buffered }
    let failure: unknown
    let reset = false
    let projectedCommits: StreamCommit[] | undefined
    const renderedStarted = new Set(state.shellRenderedStarted)
    const renderedEnded = new Set(state.shellRenderedEnded)
    const shellReplayID = (commit: StreamCommit) => {
      if (commit.tool !== "shell" || !commit.partID?.startsWith("shell:")) return
      return commit.partID.slice("shell:".length)
    }
    const shellReplayTerminal = (commit: StreamCommit) =>
      commit.toolState === "completed" || commit.toolState === "error"
    const localShellRows = localRows.filter((row) => shellReplayID(row.commit) !== undefined)
    const localShellIDs = new Set(localShellRows.flatMap((row) => {
      const id = shellReplayID(row.commit)
      return id ? [id] : []
    }))
    const localShellPhases = new Map<string, { ended: boolean; explicitStart: boolean }>()
    for (const row of localShellRows) {
      const id = shellReplayID(row.commit)
      if (!id) continue
      const phases = localShellPhases.get(id) ?? { ended: false, explicitStart: false }
      if (row.commit.phase === "start") phases.explicitStart = true
      if (shellReplayTerminal(row.commit)) phases.ended = true
      localShellPhases.set(id, phases)
    }
    const restoreRenderedShells = () => {
      state.shellRenderedStarted.clear()
      state.shellRenderedEnded.clear()
      for (const id of renderedStarted) rememberShellRenderedStarted(id)
      for (const id of renderedEnded) rememberShellRenderedEnded(id)
    }
    const commitKey = (commit: StreamCommit) => {
      const shellID = shellReplayID(commit)
      if (shellID) return `shell:${shellID}`
      if (commit.messageID) return `${commit.kind}:${commit.messageID}:${commit.partID ?? ""}`
      return undefined
    }
    const restoreLocalRows = (projectedCommits: StreamCommit[]) => {
      const projectedShellAnchors = new Map<string, number>()
      const projectedTerminals = new Map<string, StreamCommit[]>()
      const projectedBase: StreamCommit[] = []
      for (const commit of projectedCommits) {
        const id = shellReplayID(commit)
        if (!id || !localShellIDs.has(id)) {
          projectedBase.push(commit)
          continue
        }
        if (!projectedShellAnchors.has(id)) projectedShellAnchors.set(id, projectedBase.length)
        if (shellReplayTerminal(commit)) {
          const terminals = projectedTerminals.get(id) ?? []
          terminals.push(commit)
          projectedTerminals.set(id, terminals)
        }
      }

      // A local shell row is always an insertion at its own local-row index.
      // Keeping one insertion per row is important: a shell can have assistant
      // output between its start and terminal commits.
      const baseAnchors = new Map<string, number>()
      projectedBase.forEach((commit, index) => {
        const key = commitKey(commit)
        if (key && !baseAnchors.has(key)) baseAnchors.set(key, index)
      })
      const anchor = (key: string) => {
        const shellID = key.startsWith("shell:") ? key.slice("shell:".length) : undefined
        if (shellID && projectedShellAnchors.has(shellID)) return { boundary: projectedShellAnchors.get(shellID)!, shell: true }
        const boundary = baseAnchors.get(key)
        return boundary === undefined ? undefined : { boundary, shell: false }
      }
      const insertionBoundary = (index: number) => {
        for (let next = index + 1; next < localRows.length; next++) {
          const nextAnchor = anchor(commitKey(localRows[next].commit) ?? "")
          if (nextAnchor) return nextAnchor.boundary
        }
        for (let previous = index - 1; previous >= 0; previous--) {
          const previousAnchor = anchor(commitKey(localRows[previous].commit) ?? "")
          if (previousAnchor) return previousAnchor.shell ? previousAnchor.boundary : previousAnchor.boundary + 1
        }
        return projectedBase.length
      }

      const localExtras: Array<{ index: number; boundary: number; commits: StreamCommit[] }> = []
      const seenLocalShellCommits = new Set<string>()
      const syntheticStarts = new Set<string>()
      for (const [index, row] of localRows.entries()) {
        const id = shellReplayID(row.commit)
        if (id) {
          const commitKey = `${id}\u0000${row.commit.phase}`
          if (seenLocalShellCommits.has(commitKey)) continue
          seenLocalShellCommits.add(commitKey)
          const commits = [row.commit]
          const phases = localShellPhases.get(id)
          if (!phases?.explicitStart && !syntheticStarts.has(id)) {
            syntheticStarts.add(id)
            commits.unshift(
              shellCommit(id, row.commit.shell?.command ?? "", {
                text: "running shell",
                phase: "start",
                toolState: "running",
              }),
            )
          }
          localExtras.push({
            index,
            boundary: projectedShellAnchors.get(id) ?? insertionBoundary(index),
            commits,
          })
          continue
        }

        const commit = row.commit
        let restored: StreamCommit | undefined = commit
        if (commit.image && commit.messageID && commit.partID) {
          const imageKey = streamPartKey(commit.messageID, commit.partID)
          if (state.imageIDs.has(imageKey)) restored = undefined
          else state.imageIDs.add(imageKey)
        } else if (
          commit.messageID &&
          commit.partID &&
          (commit.kind === "assistant" || commit.kind === "reasoning")
        ) {
          const prefix = commit.kind === "reasoning" ? "Thinking: " : ""
          const text = commit.text.startsWith(prefix) ? commit.text.slice(prefix.length) : commit.text
          const result = state.fragments.restore({ messageID: commit.messageID, partID: commit.partID }, text)
          if (result.type === "covered") restored = undefined
          if (result.type === "append") {
            if (!result.suffix) restored = undefined
            else restored = result.suffix === text ? commit : { ...commit, text: result.suffix }
          }
        } else if (commit.kind === "error" && commit.messageID) {
          if (state.errors.has(commit.messageID)) restored = undefined
          else state.errors.add(commit.messageID)
        } else if (commit.messageID && state.messageIDs.has(commit.messageID)) {
          restored = undefined
        }
        if (restored) localExtras.push({ index, boundary: insertionBoundary(index), commits: [restored] })
      }

      // If local rows only contain a shell start, retain the projected terminal
      // but place it after the local rows at that shell's transcript boundary.
      // This avoids dropping output while still keeping start -> terminal order.
      for (const [id, terminals] of projectedTerminals) {
        const phases = localShellPhases.get(id)
        if (!phases || phases.ended) continue
        const lastIndex = localRows.reduce(
          (last, row, index) => (shellReplayID(row.commit) === id ? index : last),
          -1,
        )
        if (lastIndex < 0) continue
        localExtras.push({
          // The terminal belongs after every local row at this projected shell
          // boundary, including non-shell rows between the local start and the
          // projected terminal.
          index: localRows.length,
          boundary: projectedShellAnchors.get(id) ?? insertionBoundary(lastIndex),
          commits: terminals,
        })
      }

      const insertions = new Map<number, Array<{ index: number; commits: StreamCommit[] }>>()
      for (const extra of localExtras) {
        const entries = insertions.get(extra.boundary) ?? []
        entries.push({ index: extra.index, commits: extra.commits })
        insertions.set(extra.boundary, entries)
      }
      return projectedBase.flatMap((commit, index) => [
        ...(insertions.get(index) ?? []).sort((left, right) => left.index - right.index).flatMap((entry) => entry.commits),
        commit,
      ]).concat(
        (insertions.get(projectedBase.length) ?? [])
          .sort((left, right) => left.index - right.index)
          .flatMap((entry) => entry.commits),
      )
    }
    state.buffered = replayBuffer
    try {
      await input.footer.idle()
      if (!current(attempt)) return false
      state.shellRenderedStarted.clear()
      state.shellRenderedEnded.clear()
      await next.reset()
      reset = true
      if (!current(attempt)) return false
      state.messageIDs.clear()
      state.imageIDs.clear()
      state.fragments.clear()
      state.tools.clear()
      state.toolSources.clear()
      state.finishedTools.clear()
      state.toolMessages.clear()
      state.quietText.clear()
      state.skillMessages.clear()
      state.activeCompaction = undefined
      state.errors.clear()
      projectedCommits = []
      deferredCommits = projectedCommits
      await hydrate(attempt, { render: true })
      deferredCommits = undefined
    } catch (error) {
      failure = error
      restoreRenderedShells()
      if (reset) {
        // The projection is incomplete. Rebuild transcript dedupe from the
        // pre-reset local snapshot, not from partially hydrated history.
        state.messageIDs.clear()
        state.imageIDs.clear()
        state.fragments.clear()
        state.errors.clear()
      }
    } finally {
      if (state.buffered === replayBuffer) state.buffered = undefined
      deferredCommits = undefined
    }
    if (!current(attempt)) return false
    try {
      if (reset) {
        const replayCommits = failure ? [] : (projectedCommits ?? [])
        for (const commit of restoreLocalRows(replayCommits)) {
          const id = shellReplayID(commit)
          if (id && commit.phase === "start") rememberShellRenderedStarted(id)
          if (id && shellReplayTerminal(commit)) rememberShellRenderedEnded(id)
          input.footer.append(commit)
        }
      }
    } finally {
      for (const event of buffered) apply(attempt, event)
    }
    if (reset) await input.footer.idle()
    if (failure) throw failure
    return true
  }

  let resizeReplay: Promise<boolean> | undefined
  let queuedResizeReplay: SessionResizeReplayInput | undefined
  let closing: Promise<void> | undefined

  const admitPrompt = async (next: SessionTurnInput, client: OpenCodeClient, delivery: RunDelivery) => {
    const messageID = next.prompt.messageID
    if (!messageID) throw new Error("Prompt message ID is required")
    const command = next.prompt.command
    const attachments = await prepareAttachments(next, command ? "command" : "prompt", input.readTextFile)
    const agents = promptAgents(next)
    const skills = promptSkills(next)
    if (!command) {
      input.trace?.write("send.prompt", { sessionID: input.sessionID, messageID, delivery })
      return client.session.prompt(
        {
          sessionID: input.sessionID,
          id: messageID,
          text: [next.prompt.text, ...attachments.text].join("\n\n"),
          files: attachments.files.length ? attachments.files : undefined,
          agents: agents.length ? agents : undefined,
          skills: skills.length ? skills : undefined,
          delivery,
        },
        { signal: next.signal },
      )
    }

    input.trace?.write("send.command", { sessionID: input.sessionID, messageID, command: command.name, delivery })
    return client.session.command(
      {
        sessionID: input.sessionID,
        name: command.name,
        text: command.arguments,
        files: attachments.files.length ? attachments.files : undefined,
        agents: agents.length ? agents : undefined,
        skills: skills.length ? skills : undefined,
        delivery,
      },
      { signal: next.signal },
    )
  }

  const replayOnResize = (next: SessionResizeReplayInput) => {
    queuedResizeReplay = next
    if (resizeReplay) return resizeReplay
    resizeReplay = (async () => {
      let replayed = false
      let failure: unknown
      while (queuedResizeReplay) {
        const next = queuedResizeReplay
        queuedResizeReplay = undefined
        const attempt = activeAttempt
        if (!attempt || !current(attempt)) continue
        try {
          replayed = (await serializeHydration(attempt, () => performResizeReplay(attempt, next))) || replayed
        } catch (error) {
          failure ??= error
        }
      }
      if (failure) throw failure
      return replayed
    })().finally(() => {
      resizeReplay = undefined
    })
    return resizeReplay
  }

  return {
    async admitPromptTurn(next, delivery) {
      if (next.prompt.mode === "shell") throw new Error("This prompt cannot be queued")
      await waitUntilConnected(next.signal)
      const client = sdk
      if (!next.prompt.command && next.agent)
        await client.session.switchAgent({ sessionID: input.sessionID, agent: next.agent }, { signal: next.signal })
      if (!next.prompt.command) {
        const selected = await resolveSelectedModel(input, client, next)
        if (next.variant && !selected) throw new Error("Cannot select a variant before selecting a model")
        if (selected)
          await client.session.switchModel({ sessionID: input.sessionID, model: selected }, { signal: next.signal })
      }
      const admitted = await admitPrompt(next, client, delivery)
      if (admitted) mergePending(admitted)
      settlementClient = client
    },
    async waitForIdle() {
      const client = settlementClient ?? sdk
      await settleSession(client)
      if (settlementClient === client) settlementClient = undefined
    },
    async runPromptTurn(next, admitted) {
      if (next.prompt.mode === "shell") {
        await runShellTurn(next)
        return
      }
      if (state.wait || state.shellWait) throw new Error("prompt already running")
      await waitUntilConnected(next.signal)
      const client = sdk
      const messageID = next.prompt.messageID
      if (!messageID) throw new Error("Prompt message ID is required")

      const command = next.prompt.command
      if (command) {
        await admitPrompt(next, client, next.prompt.delivery ?? "steer")
        admitted?.()
        return
      }

      if (next.agent) {
        await client.session.switchAgent({ sessionID: input.sessionID, agent: next.agent }, { signal: next.signal })
      }
      const selected = await resolveSelectedModel(input, client, next)
      if (next.variant && !selected) throw new Error("Cannot select a variant before selecting a model")
      if (selected)
        await client.session.switchModel({ sessionID: input.sessionID, model: selected }, { signal: next.signal })

      await runTurnWait(
        next,
        messageID,
        client,
        () => admitPrompt(next, client, next.prompt.delivery ?? "steer"),
        admitted,
      )
    },
    async interruptActiveTurn() {
      // A running shell holds no drain, so session.interrupt cannot reach it;
      // abort the blocking request instead. The server-side command keeps its
      // own lifecycle and simply loses its waiter.
      const shell = state.shellWait
      if (shell) {
        shell.abort()
        return
      }
      if (state.wait) state.wait.interrupted = true
      // Paint idle at the ack, not at settlement: the server accepts interruption immediately
      // while cleanup finishes asynchronously, and the terminal execution event re-confirms.
      // A failed request paints nothing, so the two-press gesture stays available for retry,
      // and a lifecycle event racing the ack wins via the epoch guard.
      const epoch = state.executionEpoch
      await sdk.session.interrupt({ sessionID: input.sessionID, resume: true }).then(
        () => {
          if (state.executionEpoch === epoch) paintIdle(blockerStatus(state.view))
        },
        () => {},
      )
    },
    selectSubagent(sessionID) {
      subagents.select(sdk, sessionID)
    },
    settleForm(sessionID, formID) {
      if (sessionID === input.sessionID) state.forms = state.forms.filter((item) => item.id !== formID)
      else if (sessionID === "global") state.globalForms = state.globalForms.filter((item) => item.id !== formID)
      else subagents.settleForm(sessionID, formID)
      syncBlockers()
    },
    replayOnResize,
    close() {
      if (!closing) {
        state.closed = true
        generation++
        offFooterClose()
        controller.abort()
        closing = (async () => {
          await connection.catch(() => {})
          await settleHydration()
          await resizeReplay?.catch(() => {})
          await settleCatalogRefreshes()
          await subagents.ready()
        })()
      }
      return closing
    },
  }
}
