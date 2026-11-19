import type { TaskQueueInfo } from "@opencode/client"
import type { PanelInput } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import { TaskQueue } from "@opencode/schema/task-queue"
import { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { useCursorStyle } from "../../config"
import { Keymap } from "../../context/keymap"
import { useClient } from "../../context/client"
import { useTaskQueueOwner } from "../../context/task-queue"
import { usePanel } from "../../context/panel"
import { useTheme } from "../../context/theme"
import { DialogFooter, DialogHeader, DialogLayout, useDialog, type DialogFooterAction } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogSelect } from "../../ui/dialog-select"
import {
  canPlanTaskQueue, canReplanTaskQueue, canResumeTaskQueue, canStartTaskQueue,
  createTaskQueueFeed, taskQueueCounts, taskQueueError, taskQueueProgress,
} from "./tasks-data"
import { createTaskQueueEvents } from "./tasks-events"
import { createTaskQueueDisplay, TASK_QUEUE_PANEL } from "./tasks-display"
import { TaskQueuePlan } from "./tasks-plan"

export type TaskDraft = { title?: string; prompt: string }

export function taskDraftName(task: TaskDraft) {
  return task.title || TaskQueue.titleFromPrompt(task.prompt)
}

const labels = {
  queued: "待开始", running: "执行中", done: "本批处理结束", stopped: "已停止", interrupted: "已中断",
  pending: "待执行", completed: "完成", failed: "失败", blocked: "阻塞", cancelled: "已跳过",
  planning: "规划中", ready: "已就绪（未执行）",
}

function queueLabel(info: TaskQueueInfo) {
  if (info.phase === "ready") return "等待手动开始"
  if (info.phase === "planning") {
    if (info.status === "running") return "规划中（未执行）"
    if (info.status === "queued") return "待规划"
    return `${labels[info.status]} · 规划未完成`
  }
  return labels[info.status]
}

function taskLabel(info: TaskQueueInfo, status: TaskQueueInfo["tasks"][number]["status"]) {
  if (info.phase === "planning" && status === "pending") return "待规划"
  return labels[status]
}

function activity(info: TaskQueueInfo) {
  return info.phase === "planning" ? "规划中" : "执行中"
}

function statusColor(theme: Plugin.Context["theme"], status: string) {
  if (status === "failed") return theme.text.feedback.error.base
  if (["blocked", "interrupted", "stopped"].includes(status)) return theme.text.feedback.warning.base
  if (status === "completed") return theme.text.feedback.success.base
  return theme.text.muted
}

/** Real multi-line form: a newline belongs to the description, never to another task. */
export function TaskEditor(props: { task?: TaskDraft; onSave: (task: TaskDraft) => void; onBack: () => void }) {
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const cursor = useCursorStyle()
  const [error, setError] = createSignal("")
  let prompt: TextareaRenderable | undefined
  const save = () => {
    const text = prompt?.plainText ?? ""
    if (!text.trim()) return setError("请填写任务内容，不能仅包含空白。")
    props.onSave({ prompt: text })
  }
  Keymap.createLayer(() => ({
    mode: "modal", priority: 2,
    commands: [
      { bind: "escape", title: "取消编辑", run: props.onBack },
      { bind: "ctrl+s", title: "保存任务", run: save },
      { bind: "enter", title: "内容换行", run: () => prompt?.insertText("\n") },
    ],
  }))
  onMount(() => prompt?.focus())
  const actions = () => [{ title: "保存", key: "ctrl+s", onTrigger: save }, { title: "取消", key: "esc", onTrigger: props.onBack }]
  return (
    <DialogLayout header={<DialogHeader title={props.task ? "编辑任务" : "添加任务"} onClose={props.onBack} />}
      footer={{ actions: { primary: actions() } }} legacyFooter={<DialogFooter actions={{ primary: actions() }} />}>
      <box gap={1}>
        <text fg={theme.text.muted}>Enter 换行 · Ctrl+S 保存 · 名称取自首个非空行</text>
        <box border borderStyle="single" borderColor={theme.border.base} paddingLeft={1} paddingRight={1}>
          <text fg={theme.text.muted}>任务内容（支持多行、粘贴中文）</text>
          <textarea id="task-queue-prompt" height={Math.max(3, Math.min(10, dimensions().height - 20))} wrapMode="word"
            initialValue={props.task?.prompt ?? ""} ref={(value: TextareaRenderable) => { prompt = value }}
            onMouseUp={() => prompt?.focus()} textColor={theme.text.formfield.base}
            focusedTextColor={theme.text.formfield.focused} cursorColor={theme.text.formfield.focused} cursorStyle={cursor()} />
        </box>
        <Show when={error()}><text fg={theme.text.feedback.error.base}>{error()}</text></Show>
      </box>
    </DialogLayout>
  )
}

export function TaskQueuePreview(props: {
  title: string; tasks: readonly TaskDraft[]; busy: boolean; onBack: () => void; onCreate: () => void
}) {
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  let scroll: ScrollBoxRenderable | undefined
  const back = () => { if (!props.busy) props.onBack() }
  const close = () => {
    if (props.busy) return dialog.clear()
    props.onBack()
  }
  Keymap.createLayer(() => ({
    mode: "modal", commands: [
      { bind: "escape", title: props.busy ? "关闭面板" : "返回草稿", run: close },
      { bind: "ctrl+w", title: "关闭面板", enabled: props.busy, run: dialog.clear },
      { bind: "ctrl+s", title: "创建批次", enabled: !props.busy, run: props.onCreate },
      { bind: "up", title: "向上滚动", run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "向下滚动", run: () => scroll?.scrollBy(1) },
      { bind: "pageup", title: "向上翻页", run: () => scroll?.scrollBy(-10) },
      { bind: "pagedown", title: "向下翻页", run: () => scroll?.scrollBy(10) },
    ],
  }))
  const actions = () => props.busy ? {
    secondary: [
      { title: "创建中…", disabled: true },
      { title: "返回修改", disabled: true, onTrigger: back },
    ],
    primary: [{ title: "关闭面板", key: "ctrl+w", onTrigger: dialog.clear }],
  } : {
    primary: [
      { title: "创建（暂不开始）", key: "ctrl+s", onTrigger: props.onCreate },
      { title: "返回修改", key: "esc", onTrigger: back },
    ],
  }
  return (
    <DialogLayout header={<DialogHeader title="创建前预览" closeLabel={props.busy ? "关闭" : "esc"} onClose={close} />}
      footer={{ actions: actions() }} legacyFooter={<DialogFooter actions={actions()} />}>
      <scrollbox height={Math.max(3, dimensions().height - 10)} contentOptions={{ gap: 1 }}
        ref={(value: ScrollBoxRenderable) => { scroll = value }}>
        <text fg={theme.text.base}>{props.title || "未命名批次"} · {props.tasks.length} 项任务</text>
        <Show when={props.busy}><text fg={theme.text.muted}>创建中，暂不能修改；Esc/Ctrl+W 仅关闭面板，已提交批次仍会保存。</text></Show>
        <text fg={theme.text.muted} wrapMode="word">创建后逐项规划；在任务会话确认需求和方案，全部选择 Auto 后仍须手动开始执行。</text>
          <For each={props.tasks}>{(task, index) => (
            <box paddingBottom={1} flexShrink={0}>
              <text fg={theme.text.base}>{index() + 1}. {taskDraftName(task)}</text>
              <text fg={theme.text.muted} wrapMode="word">{task.prompt}</text>
            </box>
          )}</For>
      </scrollbox>
    </DialogLayout>
  )
}

export function TaskQueueDetail(props: {
  info: TaskQueueInfo; busy: boolean; onBack: () => void; onStart: () => void; onResume: () => void
  onStop: () => void; onSession: (id: string) => void; onPanel?: () => void
  onPlan?: () => void; onViewPlan?: (taskID: string) => void
}) {
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()
  const [selected, setSelected] = createSignal(0)
  const rows: BoxRenderable[] = []
  let scroll: ScrollBoxRenderable | undefined
  const move = (offset: number) => {
    const next = Math.max(0, Math.min(props.info.tasks.length - 1, selected() + offset))
    setSelected(next)
    const row = rows[next]
    if (row) scroll?.scrollChildIntoView(row.id)
  }
  const open = () => {
    const task = props.info.tasks[selected()]
    if (task?.sessionID) props.onSession(task.sessionID)
  }
  const viewPlan = () => {
    const task = props.info.tasks[selected()]
    if (task?.plan) props.onViewPlan?.(task.id)
  }
  const planLabel = () => props.info.status === "queued" ? "开始规划" : "继续规划"
  const actions = (): DialogFooterAction[] => [
    { title: "返回", key: "esc", onTrigger: props.onBack },
    { title: "打开会话", key: "enter", disabled: !props.info.tasks[selected()]?.sessionID, onTrigger: open },
    ...(props.onPanel ? [{ title: "批次侧面板", key: "ctrl+o", disabled: !props.info.tasks.some((task) => task.sessionID), onTrigger: props.onPanel }] : []),
    ...(canPlanTaskQueue(props.info) ? [{ title: planLabel(), key: "ctrl+s", disabled: props.busy, onTrigger: props.onPlan }] : []),
    ...(canStartTaskQueue(props.info) ? [{ title: "手动开始", key: "ctrl+s", disabled: props.busy, onTrigger: props.onStart }] : []),
    ...(canResumeTaskQueue(props.info) ? [{ title: "手动续办", key: "ctrl+e", disabled: props.busy, onTrigger: props.onResume }] : []),
    ...(props.info.status === "running" ? [{ title: "停止", key: "ctrl+x", disabled: props.busy, onTrigger: props.onStop }] : []),
  ]
  const planActions = () => props.onViewPlan && props.info.tasks[selected()]?.plan
    ? [{ title: "查看方案", key: "ctrl+p", onTrigger: viewPlan }] : []
  Keymap.createLayer(() => ({
    mode: "modal", commands: [
      { bind: "escape", title: "返回列表", run: props.onBack },
      { bind: "up", title: "上一任务", run: () => move(-1) },
      { bind: "down", title: "下一任务", run: () => move(1) },
      { bind: "pageup", title: "向上翻页", run: () => scroll?.scrollBy(-10) },
      { bind: "pagedown", title: "向下翻页", run: () => scroll?.scrollBy(10) },
      { bind: "enter", title: "打开任务会话", run: open },
      { bind: "ctrl+o", title: "打开批次侧面板", enabled: !!props.onPanel && props.info.tasks.some((task) => task.sessionID), run: () => props.onPanel?.() },
      { bind: "ctrl+p", title: "查看完整方案", enabled: !!props.info.tasks[selected()]?.plan, run: viewPlan },
      { bind: "ctrl+s", title: "开始规划或执行", enabled: !props.busy && (canStartTaskQueue(props.info) || canPlanTaskQueue(props.info)),
        run: () => { if (canPlanTaskQueue(props.info)) return props.onPlan?.(); props.onStart() } },
      { bind: "ctrl+e", title: "手动续办", enabled: !props.busy && canResumeTaskQueue(props.info), run: props.onResume },
      { bind: "ctrl+x", title: "停止批次", enabled: !props.busy && props.info.status === "running", run: props.onStop },
    ],
  }))
  onMount(() => renderer.currentFocusedRenderable?.blur())
  return (
    <DialogLayout header={<DialogHeader title={props.info.title || "任务批次"} onClose={props.onBack} />}
      footer={{ actions: { primary: actions(), secondary: planActions() } }} legacyFooter={<DialogFooter actions={{ primary: actions(), secondary: planActions() }} />}>
      <scrollbox height={Math.max(3, dimensions().height - 10)} contentOptions={{ gap: 1 }}
        ref={(value: ScrollBoxRenderable) => { scroll = value }}>
        <text fg={statusColor(theme, props.info.status)}>{queueLabel(props.info)}{props.busy ? " · 正在处理…" : ""}</text>
        <text fg={theme.text.muted} wrapMode="word">{taskQueueCounts(props.info.tasks, props.info.phase)}</text>
        <Show when={props.info.phase === "planning"}><text fg={theme.text.muted} wrapMode="word">打开当前任务会话回答问题和需求/方案 Form；方案 Form 是唯一确认，不会提前执行。</text></Show>
        <Show when={props.info.phase === "ready"}><text fg={theme.text.muted} wrapMode="word">全部方案当前版本获批并选择 Auto 后才可手动开始。请开启自动接受权限；显式 deny 仍有效。</text></Show>
        <Show when={props.info.snapshot}><text fg={theme.text.muted} wrapMode="word">方案快照：{props.info.snapshot}</text></Show>
        <Show when={props.info.reason}><text fg={theme.text.muted}>{props.info.reason}</text></Show>
        <text fg={theme.text.muted}>↑/↓ 选择 · PgUp/PgDn 滚动 · 关闭面板不会停止；退出本 TUI 才停止自有批次。</text>
          <For each={props.info.tasks}>{(task, index) => (
            <box id={`queue-task-${task.id}`} ref={(value: BoxRenderable) => { rows[index()] = value }}
              paddingLeft={1} paddingRight={1} paddingBottom={1} flexShrink={0}
              backgroundColor={selected() === index() ? theme.background.formfield.focused : undefined}
              onMouseUp={() => setSelected(index())}>
              <text fg={theme.text.formfield.base}>
                {props.info.currentTaskID === task.id ? "▶ " : "  "}{index() + 1}. {task.title}
              </text>
              <text fg={statusColor(theme, task.status)}>{taskLabel(props.info, task.status)} · rounds {task.rounds}</text>
              <Show when={task.plan}>{(plan) => <text fg={theme.text.muted} wrapMode="word">{plan().type === "development" ? "开发" : "其他"} · 方案 v{plan().version} · {plan().mode ?? "未选择模式"} · {plan().approval ? `方案审批 ${plan().approval!.choice} v${plan().approval!.version}` : "方案未批准"}</text>}</Show>
              <Show when={task.reason}><text fg={theme.text.muted} wrapMode="word">原因：{task.reason}</text></Show>
              <Show when={task.summary}><text fg={theme.text.base} wrapMode="word">摘要：{task.summary}</text></Show>
              <Show when={task.sessionID}><text fg={theme.text.muted} wrapMode="word">会话：{task.sessionID}</text></Show>
            </box>
          )}</For>
      </scrollbox>
    </DialogLayout>
  )
}

type Workspace = ReturnType<typeof createTasksWorkspace>
const TASK_QUEUE_PLUGIN = "opencode.tasks"

export function TaskQueuePanel(props: {
  info: TaskQueueInfo; panel: PanelInput; following: boolean
  onFollow: () => void; onSession: (id: string) => void
}) {
  const theme = useTheme()
  const dialog = useDialog()
  const [selected, setSelected] = createSignal(Math.max(0, props.info.tasks.findIndex((task) => task.sessionID === props.panel.sessionID)))
  const rows: BoxRenderable[] = []
  let scroll: ScrollBoxRenderable | undefined
  const move = (offset: number) => {
    const next = Math.max(0, Math.min(props.info.tasks.length - 1, selected() + offset))
    setSelected(next)
    const row = rows[next]
    if (row) scroll?.scrollChildIntoView(row.id)
  }
  const open = (index = selected()) => {
    setSelected(index)
    const sessionID = props.info.tasks[index]?.sessionID
    if (sessionID) props.onSession(sessionID)
  }
  Keymap.createLayer(() => ({
    mode: "global", enabled: () => props.panel.focused && dialog.stack.length === 0,
    commands: [
      { bind: "up", title: "上一任务", run: () => move(-1) },
      { bind: "down", title: "下一任务", run: () => move(1) },
      { bind: "pageup", title: "向上翻页", run: () => scroll?.scrollBy(-10) },
      { bind: "pagedown", title: "向下翻页", run: () => scroll?.scrollBy(10) },
      { bind: "enter", title: "查看任务会话", run: () => open() },
      { bind: "r", title: "回到当前任务", run: props.onFollow },
      { bind: "escape", title: "收起批次（继续处理）", run: props.panel.close },
      { bind: "f", title: "切换面板大小", run: props.panel.toggleFullscreen },
    ],
  }))
  return <box flexGrow={1} minHeight={0} minWidth={0} paddingLeft={1} paddingRight={1}>
    <box flexDirection="row" gap={1} flexShrink={0}>
      <text fg={theme.text.base} flexGrow={1} minWidth={0} wrapMode="word">批次：{props.info.title || "未命名批次"}</text>
      <text fg={theme.text.action.secondary.base} onMouseUp={props.panel.toggleFullscreen}>大小 [f]</text>
      <text fg={theme.text.action.secondary.base} onMouseUp={props.panel.close}>收起 [esc]</text>
    </box>
    <text fg={statusColor(theme, props.info.status)} flexShrink={0} wrapMode="word">{queueLabel(props.info)} · {taskQueueProgress(props.info)}/{props.info.tasks.length}</text>
    <text fg={theme.text.muted} flexShrink={0}>{props.following ? props.info.phase === "ready" ? "规划完成，未执行" : `跟随${activity(props.info)}` : "已暂停跟随"}</text>
    <text fg={theme.text.action.secondary.base} flexShrink={0} onMouseUp={props.onFollow}>{props.info.phase === "ready" ? "查看最后规划会话" : `回到${activity(props.info)}`} [r]</text>
    <scrollbox flexGrow={1} minHeight={0} contentOptions={{ gap: 1 }} ref={(value: ScrollBoxRenderable) => { scroll = value }}>
      <text fg={theme.text.muted} wrapMode="word">{taskQueueCounts(props.info.tasks, props.info.phase)}</text>
      <Show when={props.info.phase === "ready"}><text fg={theme.text.muted} wrapMode="word">/tasks 手动开始；Auto 不授予工具权限，请开启自动接受权限，显式 deny 仍有效。</text></Show>
      <Show when={props.info.snapshot}><text fg={theme.text.muted} wrapMode="word">方案快照：{props.info.snapshot}</text></Show>
      <Show when={props.info.reason}><text fg={theme.text.muted} wrapMode="word">批次原因：{props.info.reason}</text></Show>
      <For each={props.info.tasks}>{(task, index) => <box id={`batch-panel-${task.id}`} flexShrink={0} paddingLeft={1} paddingRight={1}
        ref={(value: BoxRenderable) => { rows[index()] = value }}
        backgroundColor={selected() === index() && props.panel.focused ? theme.background.formfield.focused : undefined}
        onMouseUp={() => open(index())}>
        <text fg={theme.text.formfield.base} wrapMode="word">{index() + 1}. {task.title}</text>
        <text fg={statusColor(theme, task.status)} wrapMode="word">{taskLabel(props.info, task.status)} · rounds {task.rounds}{props.info.currentTaskID === task.id && props.info.status === "running" ? props.info.phase === "planning" ? " · ▶ 规划" : " · ▶ 执行" : ""}{task.sessionID === props.panel.sessionID ? " · ◉ 查看" : ""}</text>
        <Show when={task.plan}>{(plan) => <text fg={theme.text.muted}>方案 v{plan().version} · {plan().mode ?? "未选择模式"}</text>}</Show>
        <Show when={!task.sessionID}><text fg={theme.text.muted}>会话尚未创建，不会提前执行</text></Show>
        <Show when={task.reason}><text fg={theme.text.muted} wrapMode="word">原因：{task.reason}</text></Show>
        <Show when={task.summary}><text fg={theme.text.base} wrapMode="word">摘要：{task.summary}</text></Show>
      </box>}</For>
    </scrollbox>
    <text fg={theme.text.muted} flexShrink={0} wrapMode="word">↑/↓ 选择 · Enter 查看 · 收起不停止 · /tasks 重开</text>
  </box>
}

function TaskQueuePending(props: { feed: Workspace["feed"]; panel: PanelInput }) {
  const theme = useTheme()
  const dialog = useDialog()
  Keymap.createLayer(() => ({
    mode: "global", enabled: () => props.panel.focused && dialog.stack.length === 0,
    commands: [
      { bind: "escape", title: "收起批次（继续处理）", run: props.panel.close },
      { bind: "f", title: "切换面板大小", run: props.panel.toggleFullscreen },
    ],
  }))
  return <box paddingLeft={1} paddingRight={1} gap={1}>
    <text fg={theme.text.action.secondary.base} onMouseUp={props.panel.close}>收起 [esc]</text>
    <text fg={theme.text.muted}>{props.feed.loading() ? "正在加载批次…" : "批次暂不可用，等待更新或 /tasks 刷新。"}</text>
    <Show when={props.feed.error()}>{(error) => <text fg={theme.text.feedback.error.base}>{error()}</text>}</Show>
  </box>
}

function createTasksWorkspace(context: Plugin.Context, events: ReturnType<typeof createTaskQueueEvents>) {
  const client = useClient()
  const panels = usePanel()
  const feed = createTaskQueueFeed(() => client.api.taskQueue)
  const directory = createMemo(() => context.location?.directory ?? context.data.location.default().directory)
  const [scope, setScope] = createSignal(0)
  let initialized = false
  let origin = client.url
  const display = createTaskQueueDisplay({
    feed,
    route: () => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : route.type === "plugin" ? `plugin:${route.id}:${route.name}` : "home"
    },
    panel: panels.current,
    navigate: (sessionID) => context.ui.router.navigate({ type: "session", sessionID }),
    open: (sessionID) => panels.open({ plugin: TASK_QUEUE_PLUGIN, name: TASK_QUEUE_PANEL, sessionID, autoFocus: false }),
    close: context.ui.panel.close,
  })
  const ensure = () => {
    initialized = true
    if (!feed.directory(directory())) return false
    display.reset()
    setScope((value) => value + 1)
    return true
  }
  createEffect(on(directory, () => { if (initialized) ensure() }))
  onCleanup(events.attach({
    update: (info) => { if (initialized) feed.update(info) },
    load: async () => { if (initialized) await feed.load() },
  }, client))
  onCleanup(client.onReconnect((source) => {
    if (source.url !== origin) display.reset()
    origin = source.url
    // Invalidate reads and pending view intents before any buffered event is dispatched.
    feed.capture()
  }))
  onCleanup(() => { display.reset(); feed.dispose() })
  return { feed, display, ensure, directory, scope }
}

export function TasksDialog(props: { context: Plugin.Context; workspace: Workspace }) {
  const dialog = useDialog()
  const client = useClient()
  const owner = useTaskQueueOwner()
  const theme = useTheme().surface("dialog")
  const feed = props.workspace.feed
  const [view, updateView] = createSignal<"list" | "detail" | "plan" | "draft" | "edit" | "title" | "preview" | "delete">("list")
  let viewIntent = 0
  const setView = (value: ReturnType<typeof view>) => { viewIntent++; updateView(value) }
  const [queueID, setQueueID] = createSignal<string>()
  const [taskID, setTaskID] = createSignal<string>()
  const [title, setTitle] = createSignal("")
  const [tasks, setTasks] = createSignal<TaskDraft[]>([])
  const [index, setIndex] = createSignal(0)
  const [editing, setEditing] = createSignal<number>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const current = createMemo(() => feed.items().find((info) => info.id === queueID()))
  // Refreshing Location metadata must not reset an in-flight draft in the same directory.
  const directory = props.workspace.directory
  let generation = 0
  let operation = 0
  createEffect(on(props.workspace.scope, () => {
    generation++
    setView("list")
    setQueueID(undefined)
    setTasks([])
    setTitle("")
    setBusy(false)
    setFailure(undefined)
  }))
  createEffect(on(feed.connection, () => {
    operation++
    setFailure(busy() ? "连接已更换，旧操作可能已提交；请检查当前服务后再重试。" : undefined)
    setBusy(false)
  }, { defer: true }))
  createEffect(() => {
    const id = queueID()
    if (!id || !feed.missing(id) || !["detail", "plan", "delete"].includes(view())) return
    setQueueID(undefined)
    setView("list")
  })
  onMount(() => { dialog.setSize("large"); dialog.setCentered(true) })
  onCleanup(() => { generation++ })

  const run = (action: (valid: () => boolean) => Promise<void>) => {
    if (busy()) return
    const valid = feed.capture()
    const current = generation
    const ticket = ++operation
    const active = () => current === generation && ticket === operation && valid()
    setBusy(true)
    setFailure(undefined)
    void action(active).catch((cause) => {
      if (active()) setFailure(taskQueueError(cause))
    }).finally(() => { if (active()) setBusy(false) })
  }
  const acquire = (action: "plan" | "start" | "resume", taskID?: string) => {
    if (busy()) return
    const id = queueID()
    if (!id) return
    const accept = props.workspace.display.prepare()
    const currentGeneration = generation
    const intent = viewIntent
    run(async (valid) => {
      const info = await owner.acquire(id, action, taskID)
      accept(info, () => {
        if (intent !== viewIntent || queueID() !== id) return false
        if (currentGeneration === generation) dialog.clear()
      })
      if (valid()) feed.update(info)
    })
  }
  const stop = () => {
    const id = queueID()
    if (!id) return
    run(async (valid) => {
      const info = await client.api.taskQueue.stop({ queueID: id, reason: "用户在 /tasks 停止批次；请手动继续。" })
      if (!valid()) return
      owner.observe(info)
      feed.update(info)
    })
  }
  const open = (id: string) => {
    setQueueID(id)
    setView("detail")
    void feed.get(id)
  }
  const move = (offset: number) => {
    const next = index() + offset
    if (next < 0 || next >= tasks().length) return
    const reordered = [...tasks()]
    ;[reordered[index()], reordered[next]] = [reordered[next], reordered[index()]]
    setTasks(reordered)
    setIndex(next)
  }
  const add = () => { setEditing(undefined); setView("edit") }
  const create = () => {
    const [first, ...rest] = tasks()
    if (!first) return
    const target = directory()
    run(async (valid) => {
      const info = await feed.created(client.api.taskQueue.create({ directory: target, title: title().trim() || undefined, tasks: [first, ...rest] }))
      if (!valid() || !info) return
      setTasks([])
      setTitle("")
      open(info.id)
    })
  }
  const remove = () => {
    const info = current()
    if (!info || info.status === "running") return
    run(async (valid) => {
      await client.api.taskQueue.delete({ queueID: info.id })
      if (!valid()) return
      feed.remove(info.id)
      setView("list")
    })
  }
  return (
    <box>
      <Show when={failure() ?? feed.error()}>{(error) => <box paddingLeft={3} paddingRight={3}><text fg={theme.text.feedback.error.base}>{error()}</text></box>}</Show>
      <Switch>
        <Match when={view() === "list"}>
          <DialogSelect title="任务队列 / tasks" options={feed.items().map((info) => ({
            title: info.title || "未命名批次", value: info.id,
            footer: `${taskQueueProgress(info)}/${info.tasks.length} · ${queueLabel(info)}`,
            details: info.reason ? [info.reason] : undefined,
          }))} current={current()?.id ?? feed.items()[0]?.id} preserveSelection locked={busy()}
            onMove={(option) => { if (queueID() !== option.value) viewIntent++; setQueueID(option.value) }} onSelect={(option) => open(option.value)}
            footer={<text fg={theme.text.muted} wrapMode="word">{busy() ? "正在处理…" : props.context.ui.format.path(directory())} · 面板关闭继续规划/执行</text>}
             emptyView={<box paddingLeft={4} paddingRight={4}><text fg={theme.text.muted}>{feed.loading() ? "正在加载…" : "暂无批次。Ctrl+A 新建；访问被拒绝时请检查权限。"}</text></box>}
            actions={[
              { command: "tasks.new", bind: "ctrl+a", title: "新建", selection: "none", onTrigger: () => { setTasks([]); setTitle(""); setIndex(0); setView("draft") } },
              { command: "tasks.refresh", bind: "ctrl+r", title: "刷新", selection: "none", onTrigger: () => void feed.load() },
              { command: "tasks.plan", bind: "ctrl+s", title: current()?.status === "queued" ? "开始规划" : "继续规划", hidden: !current() || !canPlanTaskQueue(current()!), onTrigger: () => acquire("plan") },
              { command: "tasks.start", bind: "ctrl+s", title: "手动开始", hidden: !current() || !canStartTaskQueue(current()!), onTrigger: () => acquire("start") },
              { command: "tasks.resume", bind: "ctrl+e", title: "手动续办", hidden: !current() || !canResumeTaskQueue(current()!), onTrigger: () => acquire("resume") },
              { command: "tasks.delete", bind: "ctrl+x", title: "删除", hidden: !current() || current()?.status === "running", onTrigger: () => setView("delete") },
            ]} />
        </Match>
        <Match when={view() === "detail" && current()}>
          <TaskQueueDetail info={current()!} busy={busy()} onBack={() => setView("list")}
            onStart={() => acquire("start")} onResume={() => acquire("resume")} onStop={stop} onPlan={() => acquire("plan")}
            onViewPlan={(taskID) => { setTaskID(taskID); setView("plan") }}
             onPanel={() => {
               const info = current()!
               const sessionID = info.tasks.find((task) => task.id === info.currentTaskID)?.sessionID ?? info.tasks.findLast((task) => task.sessionID)?.sessionID
               if (!sessionID) return
               dialog.clear()
               props.workspace.display.view(info, sessionID)
             }}
             onSession={(sessionID) => { const info = current()!; dialog.clear(); props.workspace.display.view(info, sessionID) }} />
        </Match>
        <Match when={view() === "plan" && current()}>
          <Show when={current()!.tasks.find((task) => task.id === taskID())}>{(task) => <TaskQueuePlan info={current()!} task={task()} busy={busy()}
            onBack={() => setView("detail")} onReplan={canReplanTaskQueue(current()!) ? () => acquire("plan", task().id) : undefined}
            onSession={(sessionID) => { const info = current()!; dialog.clear(); props.workspace.display.view(info, sessionID) }} />}</Show>
        </Match>
        <Match when={view() === "draft"}>
          <DialogSelect title={`新建批次：${title() || "未命名"}`} renderFilter={false} current={index()} focusTarget={index()}
             options={tasks().map((task, index) => ({ title: `${index + 1}. ${taskDraftName(task)}`, value: index, description: task.prompt }))}
            onMove={(option) => setIndex(option.value)} onSelect={(option) => { setEditing(option.value); setView("edit") }}
            emptyView={<box paddingLeft={4}><text fg={theme.text.muted}>逐项添加任务，描述支持多行。Ctrl+A 添加第一项。</text></box>}
            bindings={[{ bind: "escape", title: "返回队列列表", run: () => { setView("list") } }]}
            actions={[
              { command: "tasks.draft.add", bind: "ctrl+a", title: "添加", selection: "none", onTrigger: add },
              { command: "tasks.draft.title", bind: "ctrl+t", title: "批次标题", selection: "none", onTrigger: () => setView("title") },
              { command: "tasks.draft.up", bind: "ctrl+up", title: "上移", disabled: index() === 0, onTrigger: () => move(-1) },
              { command: "tasks.draft.down", bind: "ctrl+down", title: "下移", disabled: index() === tasks().length - 1, onTrigger: () => move(1) },
              { command: "tasks.draft.remove", bind: "ctrl+x", title: "移除", onTrigger: () => { setTasks((items) => items.filter((_, i) => i !== index())); setIndex((i) => Math.max(0, Math.min(i, tasks().length - 1))) } },
              { command: "tasks.draft.preview", bind: "ctrl+r", title: "预览", selection: "none", disabled: !tasks().length, onTrigger: () => setView("preview") },
            ]} />
        </Match>
        <Match when={view() === "edit"}>
          <TaskEditor task={editing() === undefined ? undefined : tasks()[editing()!]} onBack={() => setView("draft")}
            onSave={(task) => {
              const at = editing()
              setTasks((items) => at === undefined ? [...items, task] : items.map((item, index) => index === at ? task : item))
              setIndex(at ?? tasks().length - 1)
              setView("draft")
            }} />
        </Match>
        <Match when={view() === "title"}>
          <DialogPrompt title="批次标题（可选）" value={title()} size="large" onCancel={() => setView("draft")}
            onConfirm={(value) => { setTitle(value); setView("draft") }} />
        </Match>
        <Match when={view() === "preview"}>
          <TaskQueuePreview title={title()} tasks={tasks()} busy={busy()} onBack={() => setView("draft")} onCreate={create} />
        </Match>
        <Match when={view() === "delete"}>
          <DeleteQueue title={current()?.title || "未命名批次"} busy={busy()} onDelete={remove} onBack={() => setView("list")} />
        </Match>
      </Switch>
    </box>
  )
}

function DeleteQueue(props: { title: string; busy: boolean; onDelete: () => void; onBack: () => void }) {
  const theme = useTheme().surface("dialog")
  const actions = () => [{ title: "确认删除", key: "ctrl+x", onTrigger: props.onDelete, disabled: props.busy }, { title: "取消", key: "esc", onTrigger: props.onBack }]
  Keymap.createLayer(() => ({ mode: "modal", commands: [
    { bind: "escape", title: "取消删除", run: props.onBack },
    { bind: "ctrl+x", title: "确认删除批次", enabled: !props.busy, run: props.onDelete },
  ] }))
  return <DialogLayout header={<DialogHeader title="删除批次？" onClose={props.onBack} />}
    footer={{ actions: { primary: actions() } }} legacyFooter={<DialogFooter actions={{ primary: actions() }} />}>
    <text fg={theme.text.base}>删除「{props.title}」的队列记录。任务会话和文件改动保留。</text>
  </DialogLayout>
}

export default Plugin.define({
  id: "opencode.tasks",
  setup(context) {
    const events = createTaskQueueEvents(context.data)
    const [workspace, setWorkspace] = createSignal<Workspace>()
    context.ui.slot({ append: "session.panel", render: (panel) => (
      <Show when={panel.name === TASK_QUEUE_PANEL && workspace()}>{(workspace) => (
        <Show when={workspace().display.info()} fallback={<TaskQueuePending feed={workspace().feed} panel={panel} />}>{(info) => (
          <TaskQueuePanel info={info()} panel={panel} following={workspace().display.following()}
            onFollow={workspace().display.follow} onSession={(id) => workspace().display.view(info(), id)} />
        )}</Show>
      )}</Show>
    ) })
    context.ui.slot({ append: "app", render() {
      const workspace = createTasksWorkspace(context, events)
      setWorkspace(workspace)
      onCleanup(() => setWorkspace(undefined))
      context.keymap.layer(() => ({ mode: "global", commands: [{
        id: "tasks.open", title: "任务队列 / Task queues", group: "System", slash: { name: "tasks" }, palette: true,
        run() {
          if (!workspace.ensure()) void workspace.feed.load()
          context.ui.dialog.show(() => <TasksDialog context={context} workspace={workspace} />)
        },
      }] }))
      return null
    } })
    return events.dispose
  },
})
