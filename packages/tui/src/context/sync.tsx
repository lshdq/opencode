import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
  SnapshotFileDiff,
  ConsoleState,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "./project"
import { useEvent } from "./event"
import { useSDK } from "./sdk"
import { useTuiStartup } from "./runtime"
import { createSimpleContext } from "./helper"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup } from "solid-js"
import path from "path"
import { useKV } from "./kv"
import { usePermission } from "./permission"
import { usePreparation } from "./preparation"

const emptyConsoleState: ConsoleState = {
  consoleManagedProviders: [],
  switchableOrgCount: 0,
}

function search<T>(items: T[], target: string, key: (item: T) => string) {
  let left = 0
  let right = items.length - 1
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    const value = key(items[middle])
    if (value === target) return { found: true, index: middle }
    if (value < target) left = middle + 1
    else right = middle - 1
  }
  return { found: false, index: left }
}

function compareMessage(a: Message, b: Message) {
  return a.time.created - b.time.created || a.id.localeCompare(b.id)
}

const messageKey = (message: Message) => message.time.created + message.id

export const {
  context: SyncContext,
  use: useSync,
  provider: SyncProvider,
} = createSimpleContext({
  name: "Sync",
  deferRender: false,
  init: () => {
    const preparation = usePreparation()
    let disposed = false
    onCleanup(() => {
      disposed = true
      preparing?.owner.abort()
    })
    const startup = useTuiStartup()
    const kv = useKV()
    const permission = usePermission()
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleState
      capabilities: {
        experimentalBackgroundSubagents: boolean
      }
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: SnapshotFileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      capabilities: {
        experimentalBackgroundSubagents: false,
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()

    const fullSyncedSessions = new Set<string>()
    const syncingSessions = new Map<string, Promise<void>>()
    const hydratingSessions = new Map<string, { messages: Set<string>; parts: Set<string> }>()
    const touchMessage = (sessionID: string, messageID: string) => {
      hydratingSessions.get(sessionID)?.messages.add(messageID)
    }
    const touchPart = (sessionID: string, partID: string) => {
      hydratingSessions.get(sessionID)?.parts.add(partID)
    }

    function sessionListQuery(instancePath = project.data.instance.path): { scope?: "project"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "project" }
      if (!instancePath.worktree || !instancePath.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(instancePath.worktree), instancePath.directory)
          .replaceAll("\\", "/"),
      }
    }

    function listSessions(context = { workspace: project.workspace.current(), path: project.data.instance.path }) {
      return sdk.client.session
        .list({
          workspace: context.workspace,
          start: Date.now() - 30 * 24 * 60 * 60 * 1000,
          ...sessionListQuery(context.path),
        })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
    }

    event.subscribe((event, { directory, workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          refreshInstance({ id: event.id, directory, workspace })
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          if (project.workspace.removed(workspace)) break
          if (permission.mode === "auto" && store.status !== "loading" && workspace === hydratedWorkspace) {
            void sdk.client.permission.reply({
              requestID: request.id,
              reply: "once",
              directory,
              workspace,
            })
            break
          }
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.next.moved": {
          const result = search(store.session, event.properties.sessionID, (s) => s.id)
          if (!result.found) break
          setStore(
            "session",
            result.index,
            produce((session) => {
              session.directory = event.properties.location.directory
              session.path = event.properties.subdirectory
              session.workspaceID = event.properties.location.workspaceID
              session.time.updated = event.properties.timestamp
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          touchMessage(event.properties.info.sessionID, event.properties.info.id)
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = search(messages, messageKey(event.properties.info), messageKey)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          touchMessage(event.properties.sessionID, event.properties.messageID)
          const messages = store.message[event.properties.sessionID]
          const index = messages.findIndex((message) => message.id === event.properties.messageID)
          if (index !== -1) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          touchPart(event.properties.part.sessionID, event.properties.part.id)
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = search(parts, event.properties.part.id, (part) => part.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (!result.found) break
          touchPart(event.properties.sessionID, event.properties.partID)
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          touchPart(event.properties.sessionID, event.properties.partID)
          const parts = store.part[event.properties.messageID]
          const result = search(parts, event.properties.partID, (part) => part.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()
    let hydratedWorkspace: string | undefined
    let preparing: {
      owner: AbortController
      signal: AbortSignal
      workspace: string | undefined
      directory: string | undefined
      pending: boolean
      events: Set<string>
      refresh: (id: string) => void
      task: Promise<void>
    } | undefined
    let stale: { id: string; directory: string; workspace: string | undefined } | undefined
    let recovery: { signal: AbortSignal; workspace: string | undefined; task: Promise<void> } | undefined

    function matches(instance: { directory: string; workspace: string | undefined }, target: { directory?: string; workspace: string | undefined }) {
      return instance.workspace === target.workspace &&
        (target.directory === undefined || path.normalize(instance.directory) === path.normalize(target.directory))
    }

    function refreshInstance(instance: { id: string; directory: string; workspace: string | undefined }) {
      if (disposed || project.workspace.removed(instance.workspace)) return
      const current = { directory: project.instance.directory(), workspace: project.workspace.current() }
      if (preparing && !preparing.signal.aborted && matches(instance, preparing) && preparing.events.has(instance.id)) return
      if (preparing && !preparing.signal.aborted && preparing.pending && matches(instance, preparing)) {
        preparing.refresh(instance.id)
        return
      }
      if (!matches(instance, current)) return
      // A refresh is not a new navigation intent. Keep it for fallback, without
      // cancelling a different candidate or clearing that candidate's failure.
      stale = instance
      if (preparing && !preparing.signal.aborted && (preparing.pending || !matches(instance, preparing))) return
      stale = undefined
      void bootstrap({ fatal: false, workspace: current.workspace ?? null, refresh: instance.id }).catch(() => {})
    }

    function recover(signal: AbortSignal) {
      const workspace = project.workspace.current()
      if (recovery?.signal === signal && recovery.workspace === workspace) return recovery.task
      if (!project.workspace.removed(workspace)) return Promise.resolve()
      const task = bootstrap({ fatal: false, workspace: null, signal })
      recovery = { signal, workspace, task }
      return task
    }

    function bootstrap(input: { fatal?: boolean; signal?: AbortSignal; workspace?: string | null; refresh?: string } = {}) {
      // Provider setup calls bootstrap after dispose; the event may already have
      // started the same refresh. Never replace an explicit in-flight candidate.
      if (!("workspace" in input) && !input.signal && preparing?.pending && !preparing.signal.aborted) return preparing.task
      if (input.signal?.aborted) return Promise.reject(input.signal.reason)
      preparing?.owner.abort()
      const owner = new AbortController()
      const signal = AbortSignal.any([owner.signal, ...(input.signal ? [input.signal] : [])])
      const workspace = "workspace" in input ? input.workspace ?? undefined : project.workspace.current()
      const candidate = {
        owner, signal, workspace,
        directory: workspace === undefined ? sdk.directory : project.workspace.get(workspace)?.directory ?? undefined,
        pending: true,
        events: new Set(input.refresh ? [input.refresh] : []),
        refresh: (_id: string) => {},
        task: Promise.resolve(),
      }
      preparing = candidate
      signal.addEventListener("abort", () => {
        // Let a synchronous explicit switch install its new candidate first.
        // Otherwise restore a dirty retained context before released waiters run.
        queueMicrotask(() => {
          if (disposed || preparing !== candidate || !stale) return
          refreshInstance(stale)
        })
      }, { once: true })
      candidate.task = preparation.track((async () => {
        while (true) {
          signal.throwIfAborted()
          const pass = new AbortController()
          const refresh = Promise.withResolvers<"refresh">()
          candidate.refresh = (id) => {
            candidate.events.add(id)
            if (pass.signal.aborted) return
            pass.abort()
            refresh.resolve("refresh")
          }
          const outcome = await Promise.race([
            loadContext({ ...input, workspace: workspace ?? null, signal: AbortSignal.any([signal, pass.signal]),
              directory: (directory) => { candidate.directory = directory },
            }).then(() => "complete" as const, (error: unknown) => ({ error })),
            refresh.promise,
          ])
          // An event can invalidate the pass after its promise won the race but
          // before this continuation runs. That result still cannot finish us.
          if (outcome === "refresh" || pass.signal.aborted) {
            continue
          }
          signal.throwIfAborted()
          if (outcome !== "complete") throw outcome.error
          if (preparing === candidate) stale = undefined
          candidate.pending = false
          return
        }
      })().finally(() => { candidate.pending = false }), { signal })
      return candidate.task
    }

    async function loadContext(input: { fatal?: boolean; signal: AbortSignal; workspace?: string | null; directory: (directory: string) => void }) {
      const fatal = input.fatal ?? true
      const workspace = "workspace" in input ? input.workspace ?? undefined : project.workspace.current()
      const active = () => !disposed && !input.signal.aborted
      const available = () => active() && !project.workspace.removed(workspace)
      if (project.workspace.removed(workspace)) throw new Error("Workspace has been deleted. Choose another workspace.")
      const projectPromise = project.load(workspace).then((snapshot) => {
        if (active()) input.directory(snapshot.path.directory)
        return snapshot
      })
      const sessionListPromise = projectPromise.then((snapshot) => listSessions(snapshot))

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({ workspace }, { throwOnError: true })
      const capabilitiesPromise = sdk.client.experimental.capabilities
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => undefined)
      const consoleStatePromise = sdk.client.experimental.console
        .get({ workspace }, { throwOnError: true })
        .then((x) => x.data)
        .catch(() => emptyConsoleState)
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      const commandsPromise = sdk.client.command.list({ workspace }, { throwOnError: true })
      // Observe the optional list immediately even when mandatory bootstrap fails.
      void sessionListPromise.catch(() => {})
      await Promise.all([
        providersPromise,
        providerListPromise,
        capabilitiesPromise,
        agentsPromise,
        configPromise,
        commandsPromise,
        projectPromise,
        ...(args.continue || args.fork ? [sessionListPromise] : []),
      ])
        .then(async () => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const capabilitiesResponse = capabilitiesPromise
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue || args.fork ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            capabilitiesResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            projectPromise,
            commandsPromise,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            if (!active()) return
            if (project.workspace.removed(workspace)) throw new Error("Workspace has been deleted. Choose another workspace.")
            const providers = responses[0]
            const providerList = responses[1]
            const capabilities = responses[2]
            const consoleState = responses[3]
            const agents = responses[4]
            const config = responses[5]
            const snapshot = responses[6]
            const commands = responses[7]
            const sessions = responses[8]

            batch(() => {
              hydratedWorkspace = workspace
              project.apply(snapshot)
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("capabilities", "experimentalBackgroundSubagents", capabilities?.backgroundSubagents === true)
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              permission.configure(config.auto_approve === true)
              setStore("command", reconcile(commands.data ?? []))
              if (store.status !== "complete") setStore("status", "partial")
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(async () => {
          if (!available()) return
          // non-blocking
          void Promise.all([
            ...(args.continue || args.fork ? [] : [sessionListPromise.then((sessions) => available() && setStore("session", reconcile(sessions)))]),
            consoleStatePromise.then((consoleState) => available() && setStore("console_state", reconcile(consoleState))),
            sdk.client.lsp.status({ workspace }).then((x) => available() && setStore("lsp", reconcile(x.data ?? []))),
            sdk.client.mcp.status({ workspace }).then((x) => available() && setStore("mcp", reconcile(x.data ?? {}))),
            sdk.client.experimental.resource
              .list({ workspace })
              .then((x) => available() && setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status({ workspace }).then((x) => available() && setStore("formatter", reconcile(x.data ?? []))),
            sdk.client.session.status({ workspace }).then((x) => {
              if (available()) setStore("session_status", reconcile(x.data ?? {}))
            }),
            sdk.client.provider.auth({ workspace }).then((x) => available() && setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get({ workspace }).then((x) => available() && setStore("vcs", reconcile(x.data))),
            project.workspace.sync(input.signal),
          ]).then(() => {
            if (available()) setStore("status", "complete")
          }).catch((error) => console.error("tui background sync failed", error))
        })
        .catch(async (e) => {
          if (!active()) return
          console.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          if (fatal) exit(e)
          throw e
        })
      // Supersession is not successful preparation for callers such as warp.
      input.signal.throwIfAborted()
    }

    const initialized = preparation.track(bootstrap({ fatal: false }))

    const result = {
      data: store,
      initialized,
      // Only complete contexts are published. Candidate workspace selection
      // lives in bootstrap inputs, never in the SDK or the committed project.
      get workspace() {
        return hydratedWorkspace
      },
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (startup.skipInitialLoading) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh(signal?: AbortSignal, sessionID?: string) {
          if (signal?.aborted) return
          const list = await listSessions()
          if (signal?.aborted) return
          // The moved session may fall outside the list filter. Refresh it too,
          // but publish neither response after this operation loses its owner.
          const session = sessionID ? await sdk.client.session.get({ sessionID }, { throwOnError: true }) : undefined
          if (signal?.aborted) return
          setStore("session", reconcile(
            session?.data
              ? [...list.filter((item) => item.id !== sessionID), session.data].toSorted((a, b) => a.id.localeCompare(b.id))
              : list,
          ))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          // A workspace list refresh may have removed this cached session.
          if (fullSyncedSessions.has(sessionID) && result.session.get(sessionID)) return
          const syncing = syncingSessions.get(sessionID)
          if (syncing) return syncing
          const tracker = { messages: new Set<string>(), parts: new Set<string>() }
          hydratingSessions.set(sessionID, tracker)
          const task = (async () => {
            const [session, messages, todo, diff] = await Promise.all([
              sdk.client.session.get({ sessionID }, { throwOnError: true }),
              sdk.client.session.messages({ sessionID, limit: 100 }),
              sdk.client.session.todo({ sessionID }),
              sdk.client.session.diff({ sessionID }),
            ])
            setStore(
              produce((draft) => {
                const match = search(draft.session, sessionID, (s) => s.id)
                if (match.found) draft.session[match.index] = session.data!
                if (!match.found) draft.session.splice(match.index, 0, session.data!)
                draft.todo[sessionID] = todo.data ?? []
                const currentMessages = draft.message[sessionID] ?? []
                const infos = (messages.data ?? []).flatMap((message) => {
                  if (!tracker.messages.has(message.info.id)) return [message.info]
                  const current = currentMessages.find((item) => item.id === message.info.id)
                  return current ? [current] : []
                })
                infos.push(
                  ...currentMessages.filter(
                    (message) => tracker.messages.has(message.id) && !infos.some((item) => item.id === message.id),
                  ),
                )
                infos.sort(compareMessage)
                const removed = infos.slice(0, -100)
                const visible = infos.slice(-100)
                const visibleIDs = new Set(visible.map((message) => message.id))
                for (const message of messages.data ?? []) {
                  if (!visibleIDs.has(message.info.id)) {
                    delete draft.part[message.info.id]
                    continue
                  }
                  const currentParts = draft.part[message.info.id] ?? []
                  const parts = message.parts.flatMap((part) => {
                    const current = currentParts.find((item) => item.id === part.id)
                    if (tracker.parts.has(part.id)) return current ? [current] : []
                    if (
                      current &&
                      (part.type === "text" || part.type === "reasoning") &&
                      (current.type === "text" || current.type === "reasoning") &&
                      part.text.length === 0 &&
                      current.text.length > 0
                    ) {
                      return [current]
                    }
                    return [part]
                  })
                  parts.push(
                    ...currentParts.filter(
                      (part) => tracker.parts.has(part.id) && !parts.some((item) => item.id === part.id),
                    ),
                  )
                  draft.part[message.info.id] = parts
                }
                for (const message of removed) delete draft.part[message.id]
                draft.message[sessionID] = visible
                draft.session_diff[sessionID] = diff.data ?? []
              }),
            )
            fullSyncedSessions.add(sessionID)
          })().finally(() => {
            syncingSessions.delete(sessionID)
            hydratingSessions.delete(sessionID)
          })
          syncingSessions.set(sessionID, task)
          return task
        },
      },
      bootstrap,
      recover,
    }
    return result
  },
})
