import type { ExperimentalWorkspaceAdapterListResponse, Workspace } from "@opencode-ai/sdk/v2"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSync } from "../context/sync"
import { useProject } from "../context/project"
import { useRoute } from "../context/route"
import { createMemo, createSignal, onMount } from "solid-js"
import { errorMessage } from "../util/error"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogWorkspaceFileChanges } from "./dialog-workspace-file-changes"

type Adapter = ExperimentalWorkspaceAdapterListResponse[number]

export type WorkspaceSelection =
  | {
      type: "none"
    }
  | {
      type: "new"
      workspaceType: string
      workspaceName: string
    }
  | {
      type: "existing"
      workspaceID: string
      workspaceType: string
      workspaceName: string
    }

type WorkspaceSelectValue = WorkspaceSelection | { type: "existing-list" }
type ExistingWorkspaceSelectValue = { workspace: Workspace }

export function recentConnectedWorkspaces<WorkspaceInfo extends { id: string; timeUsed: number | string }>(input: {
  workspaces: readonly WorkspaceInfo[]
  status: (workspaceID: string) => string | undefined
  limit?: number
  omitWorkspaceID?: string
}) {
  const allWorkspaces = input.workspaces.filter((workspace) => input.status(workspace.id) === "connected")
  const workspaces = allWorkspaces.toSorted((a, b) => Number(b.timeUsed) - Number(a.timeUsed))
  const recent = workspaces.slice(0, input.limit ?? 3)

  return { recent, hasMore: recent.length < workspaces.length }
}

export function warpReminderText(dir: string) {
  return `<system-reminder>The user has changed the current working directory to "${dir}". This is still the same project but at a possibly new location; take this into account when working with any files from now on.</system-reminder>`
}

async function loadWorkspaceAdapters(input: {
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  toast: ReturnType<typeof useToast>
  signal?: AbortSignal
}) {
  if (input.signal?.aborted) return
  const dir = input.sync.path.directory || input.sdk.directory
  try {
    const response = await input.sdk.client.experimental.workspace.adapter.list({ directory: dir })
    if (input.signal?.aborted) return
    if (response.error) throw response.error
    return response.data
  } catch (err) {
    if (input.signal?.aborted) return
    input.toast.show({
      title: "Failed to load workspace adapters",
      message: errorMessage(err),
      variant: "error",
    })
    return undefined
  }
}

export async function openWorkspaceSelect(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  signal: AbortSignal
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  input.dialog.clear()
  const signal = AbortSignal.any([input.signal, input.dialog.signal])
  await input.sdk.client.experimental.workspace.syncList().catch(() => undefined)
  if (signal.aborted) return
  await input.project.workspace.sync(signal).catch(() => undefined)
  if (signal.aborted) return
  const adapters = await loadWorkspaceAdapters({ ...input, signal })
  if (signal.aborted) return
  if (!adapters) return
  input.dialog.replace(() => <DialogWorkspaceSelect adapters={adapters} onSelect={input.onSelect} />)
}

export async function warpWorkspaceSession(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  sourceWorkspaceID?: string
  workspaceID: string | null
  sessionID: string
  copyChanges: boolean
  signal: AbortSignal
  done?: () => void
}): Promise<boolean> {
  if (input.signal.aborted) return false
  if (input.project.workspace.removed(input.workspaceID ?? undefined)) {
    input.toast.show({ message: "Workspace has been deleted. Choose another workspace.", variant: "error" })
    return false
  }
  let result
  try {
    result = await input.sdk.client.experimental.workspace.warp({
      id: input.workspaceID,
      sessionID: input.sessionID,
      copyChanges: input.copyChanges,
    })
  } catch (err) {
    if (input.signal.aborted) return false
    input.toast.show({
      title: "Failed to warp session",
      message: errorMessage(err),
      variant: "error",
    })
    return false
  }
  if (input.signal.aborted) return false
  if (!result?.data) {
    if (result?.error && "name" in result.error && result.error.name === "VcsApplyError") {
      await DialogAlert.show(
        input.dialog,
        "Unable to Warp Session",
        "Unable to apply file changes to this workspace. It has existing changes that conflict or is based off a different branch. Session has not been warped.",
      )
      return false
    }

    input.toast.show({
      title: "Failed to warp session",
      message: errorMessage(result?.error ?? "no response"),
      variant: "error",
    })
    return false
  }

  if (input.signal.aborted) return false
  const prepared = await input.sync.bootstrap({ fatal: false, workspace: input.workspaceID, signal: input.signal }).then(
    () => true,
    (error) => {
      if (input.signal.aborted) return false
      input.toast.show({ title: "Workspace preparation failed", message: errorMessage(error), variant: "error" })
      return false
    },
  )
  if (!prepared) return false
  if (input.signal.aborted) return false
  if (input.project.workspace.removed(input.workspaceID ?? undefined)) return false

  const dir = input.project.instance.directory() || input.sync.path.directory
  if (dir) {
    await input.sdk.client.session
      .promptAsync({
        sessionID: input.sessionID,
        workspace: input.workspaceID ?? undefined,
        noReply: true,
        parts: [
          {
            type: "text",
            text: warpReminderText(dir),
            synthetic: true,
          },
        ],
      })
      .catch(() => undefined)
  }

  if (input.signal.aborted) return false
  const refreshed = await Promise.all([
    input.project.workspace.sync(input.signal),
    input.sync.session.refresh(input.signal, input.sessionID),
  ]).then(
    () => true,
    (error) => {
      if (!input.signal.aborted) {
        input.toast.show({ title: "Workspace refresh failed", message: errorMessage(error), variant: "error" })
      }
      return false
    },
  )
  if (!refreshed || input.signal.aborted) return false

  if (input.done) {
    input.done()
    return true
  }
  input.dialog.clear()
  return true
}

export async function confirmWorkspaceFileChanges(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sourceWorkspaceID?: string
  signal: AbortSignal
}) {
  const signal = AbortSignal.any([input.signal, input.dialog.signal])
  const status = await input.sdk.client.vcs.status({ workspace: input.sourceWorkspaceID }).catch(() => undefined)
  if (signal.aborted) return
  const fileChangeChoice = status?.data?.length
    ? await DialogWorkspaceFileChanges.show(input.dialog, status.data)
    : "no"
  if (!fileChangeChoice || input.signal.aborted) return
  return fileChangeChoice === "yes"
}

export function DialogWorkspaceSelect(props: {
  adapters?: Adapter[]
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  const dialog = useDialog()
  const project = useProject()
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [adapters, setAdapters] = createSignal<Adapter[] | undefined>(props.adapters)
  let selecting = false
  const select = async (selection: WorkspaceSelection) => {
    if (selecting) return
    selecting = true
    try {
      await props.onSelect(selection)
    } finally {
      selecting = false
    }
  }
  const omittedWorkspaceID = createMemo(() => (route.data.type === "session" ? project.workspace.current() : undefined))

  onMount(() => {
    dialog.setSize("medium")
    const signal = AbortSignal.any([route.signal, dialog.signal])
    void (async () => {
      if (adapters()) return
      const res = await loadWorkspaceAdapters({ sdk, sync, toast, signal })
      if (!res || signal.aborted) return
      setAdapters(res)
    })()
  })

  const options = createMemo<DialogSelectOption<WorkspaceSelectValue>[]>(() => {
    const list = adapters()
    if (!list) return []
    const { recent, hasMore } = recentConnectedWorkspaces({
      workspaces: project.workspace.list(),
      status: project.workspace.status,
      omitWorkspaceID: omittedWorkspaceID(),
    })
    return [
      ...list.map((adapter) => ({
        title: adapter.name,
        value: { type: "new" as const, workspaceType: adapter.type, workspaceName: adapter.name },
        description: adapter.description,
        category: "New workspace",
      })),
      {
        title: "None",
        value: { type: "none" as const },
        description: "Use the local project",
        category: "Choose workspace",
      },
      ...recent.map((workspace: Workspace) => ({
        title: workspace.name,
        description: `(${workspace.type})`,
        value: {
          type: "existing" as const,
          workspaceID: workspace.id,
          workspaceType: workspace.type,
          workspaceName: workspace.name,
        },
        category: "Choose workspace",
      })),
      ...(hasMore
        ? [
            {
              title: "View all workspaces",
              value: { type: "existing-list" as const },
              description: "Choose from all workspaces",
              category: "Choose workspace",
            },
          ]
        : []),
    ]
  })

  if (!adapters()) return null
  return (
    <DialogSelect<WorkspaceSelectValue>
      title="Warp"
      skipFilter={true}
      renderFilter={false}
      options={options()}
      onSelect={(option) => {
        if (!option.value) return
        if (option.value.type === "none") {
          void select(option.value)
          return
        }
        if (option.value.type === "new") {
          void select(option.value)
          return
        }
        if (option.value.type === "existing") {
          void select(option.value)
          return
        }

        dialog.replace(() => (
          <DialogExistingWorkspaceSelect omitWorkspaceID={omittedWorkspaceID()} onSelect={select} />
        ))
      }}
    />
  )
}

function DialogExistingWorkspaceSelect(props: {
  omitWorkspaceID?: string
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  const project = useProject()

  const options = createMemo<DialogSelectOption<ExistingWorkspaceSelectValue>[]>(() =>
    project.workspace
      .list()
      .filter((workspace) => project.workspace.status(workspace.id) === "connected")
      .filter((workspace) => workspace.id !== props.omitWorkspaceID)
      .map((workspace: Workspace) => ({
        title: workspace.name,
        description: `(${workspace.type})`,
        value: { workspace },
      })),
  )

  return (
    <DialogSelect<ExistingWorkspaceSelectValue>
      title="Existing Workspace"
      options={options()}
      onSelect={(option) => {
        void props.onSelect({
          type: "existing",
          workspaceID: option.value.workspace.id,
          workspaceType: option.value.workspace.type,
          workspaceName: option.value.workspace.name,
        })
      }}
    />
  )
}
