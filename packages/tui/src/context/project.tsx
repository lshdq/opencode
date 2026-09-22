import { batch } from "solid-js"
import type { Path, Workspace } from "@opencode-ai/sdk/v2"
import { createStore, reconcile } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"

type WorkspaceStatus = "connected" | "connecting" | "disconnected" | "error"

export const { use: useProject, provider: ProjectProvider } = createSimpleContext({
  name: "Project",
  init: () => {
    const sdk = useSDK()

    const defaultPath = {
      home: "",
      state: "",
      config: "",
      worktree: "",
      directory: sdk.directory ?? "",
    } satisfies Path

    const [store, setStore] = createStore({
      project: {
        id: undefined as string | undefined,
        worktree: undefined as string | undefined,
        mainDir: undefined as string | undefined,
      },
      instance: {
        path: defaultPath,
      },
      workspace: {
        current: undefined as string | undefined,
        list: [] as Workspace[],
        status: {} as Record<string, WorkspaceStatus>,
        removed: {} as Record<string, boolean>,
      },
    })

    // Loading a candidate must not publish a partial execution context. Sync
    // commits this snapshot together with config, agents, providers and commands.
    async function load(workspace: string | undefined) {
      const [instancePath, project] = await Promise.all([
        sdk.client.path.get({ workspace }, { throwOnError: true }),
        sdk.client.project.current({ workspace }, { throwOnError: true }),
      ])
      const directories = project.data?.id
        ? await sdk.client.project.directories({ projectID: project.data.id, workspace })
        : undefined
      return {
        workspace,
        path: instancePath.data || defaultPath,
        id: project.data?.id,
        worktree: project.data?.worktree,
        mainDir: directories?.data?.findLast((item) => item.strategy === undefined)?.directory,
      }
    }

    function apply(snapshot: Awaited<ReturnType<typeof load>>) {
      batch(() => {
        setStore("workspace", "current", snapshot.workspace)
        setStore("instance", "path", reconcile(snapshot.path))
        setStore("project", "id", snapshot.id)
        setStore("project", "worktree", snapshot.worktree)
        setStore("project", "mainDir", snapshot.mainDir)
      })
    }

    async function sync(signal?: AbortSignal) {
      const snapshot = await load(store.workspace.current)
      if (!signal?.aborted) apply(snapshot)
    }

    async function syncWorkspace(signal?: AbortSignal) {
      if (signal?.aborted) return
      const listed = await sdk.client.experimental.workspace.list().catch(() => undefined)
      if (!listed?.data || signal?.aborted) return
      const status = await sdk.client.experimental.workspace.status().catch(() => undefined)
      if (signal?.aborted) return
      const next = Object.fromEntries((status?.data ?? []).map((item) => [item.workspaceID, item.status]))

      batch(() => {
        setStore("workspace", "list", reconcile(listed.data))
        setStore("workspace", "status", reconcile(next))
        // Discovery cannot change the committed execution context. A removed
        // workspace stays unavailable until an explicit, fully prepared switch.
      })
    }

    sdk.event.on("event", (event) => {
      if (event.payload.type === "workspace.status") {
        setStore("workspace", "status", event.payload.properties.workspaceID, event.payload.properties.status)
      }
    })

    return {
      data: store,
      project() {
        return store.project.id
      },
      instance: {
        path() {
          return store.instance.path
        },
        directory() {
          return store.instance.path.directory
        },
      },
      workspace: {
        // Deletion is a fact, not a cancellable route task. Discovery and late
        // session reads must never make this execution target usable again.
        invalidate(workspaceID: string) {
          setStore("workspace", "removed", workspaceID, true)
        },
        removed(workspaceID: string | undefined) {
          return workspaceID !== undefined && store.workspace.removed[workspaceID] === true
        },
        current() {
          return store.workspace.current
        },
        set(next?: string | null) {
          const workspace = next ?? undefined
          if (store.workspace.current === workspace) return
          setStore("workspace", "current", workspace)
        },
        list() {
          return store.workspace.list
        },
        get(workspaceID: string) {
          return store.workspace.list.find((item) => item.id === workspaceID)
        },
        status(workspaceID: string) {
          if (store.workspace.removed[workspaceID]) return "error"
          return store.workspace.status[workspaceID]
        },
        statuses() {
          return store.workspace.status
        },
        sync: syncWorkspace,
      },
      sync,
      load,
      apply,
    }
  },
})
