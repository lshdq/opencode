import type { TaskQueueInfo } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { useCursorStyle } from "../../config"
import { Keymap } from "../../context/keymap"
import { useClient } from "../../context/client"
import { useTaskQueueOwner } from "../../context/task-queue"
import { useTheme } from "../../context/theme"
import { DialogFooter, DialogHeader, DialogLayout, useDialog, type DialogFooterAction } from "../../ui/dialog"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogSelect } from "../../ui/dialog-select"
import { canResumeTaskQueue, createTaskQueueFeed, taskQueueCounts, taskQueueError } from "./tasks-data"
import { createTaskQueueEvents } from "./tasks-events"

export type TaskDraft = { title: string; prompt: string }

const labels = {
  queued: "待开始", running: "执行中", done: "本批处理结束", stopped: "已停止", interrupted: "已中断",
  pending: "待执行", completed: "完成", failed: "失败", blocked: "阻塞", cancelled: "已跳过",
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
  const [field, setField] = createSignal<"title" | "prompt">("title")
  const [error, setError] = createSignal("")
  let title: TextareaRenderable | undefined
  let prompt: TextareaRenderable | undefined
  const focus = (next: "title" | "prompt") => {
    setField(next)
    ;(next === "title" ? title : prompt)?.focus()
  }
  const save = () => {
    const name = title?.plainText.trim() ?? ""
    const text = prompt?.plainText ?? ""
    if (!name || !text.trim()) return setError("请填写任务标题和完整描述。")
    props.onSave({ title: name, prompt: text })
  }
  Keymap.createLayer(() => ({
    mode: "modal", priority: 2,
    commands: [
      { bind: "escape", title: "取消编辑", run: props.onBack },
      { bind: "ctrl+s", title: "保存任务", run: save },
      { bind: "tab", title: "下一个输入框", run: () => focus(field() === "title" ? "prompt" : "title") },
      { bind: "shift+tab", title: "上一个输入框", run: () => focus(field() === "title" ? "prompt" : "title") },
      { bind: "enter", title: "描述换行", run: () => field() === "title" ? focus("prompt") : prompt?.insertText("\n") },
    ],
  }))
  onMount(() => title?.focus())
  const actions = () => [{ title: "保存", key: "ctrl+s", onTrigger: save }, { title: "取消", key: "esc", onTrigger: props.onBack }]
  return (
    <DialogLayout header={<DialogHeader title={props.task ? "编辑任务" : "添加任务"} onClose={props.onBack} />}
      footer={{ actions: { primary: actions() } }} legacyFooter={<DialogFooter actions={{ primary: actions() }} />}>
      <box gap={1}>
        <text fg={theme.text.muted}>Tab 切换输入框 · 描述内 Enter 换行 · Ctrl+S 保存</text>
        <box border borderStyle="single" borderColor={theme.border.base} paddingLeft={1} paddingRight={1}>
          <text fg={theme.text.muted}>任务标题</text>
          <textarea id="task-queue-title" height={1} wrapMode="none" initialValue={props.task?.title ?? ""}
            ref={(value: TextareaRenderable) => { title = value }} onMouseUp={() => focus("title")}
            textColor={theme.text.formfield.base} focusedTextColor={theme.text.formfield.focused}
            cursorColor={theme.text.formfield.focused} cursorStyle={cursor()} />
        </box>
        <box border borderStyle="single" borderColor={theme.border.base} paddingLeft={1} paddingRight={1}>
          <text fg={theme.text.muted}>完整描述（支持多行、粘贴中文）</text>
          <textarea id="task-queue-prompt" height={Math.max(3, Math.min(10, dimensions().height - 20))} wrapMode="word"
            initialValue={props.task?.prompt ?? ""} ref={(value: TextareaRenderable) => { prompt = value }}
            onMouseUp={() => focus("prompt")} textColor={theme.text.formfield.base}
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
        <text fg={theme.text.muted}>按序执行一次；阻塞先处理其余可执行内容，最后汇总，不自动回访。</text>
          <For each={props.tasks}>{(task, index) => (
            <box paddingBottom={1} flexShrink={0}>
              <text fg={theme.text.base}>{index() + 1}. {task.title}</text>
              <text fg={theme.text.muted} wrapMode="word">{task.prompt}</text>
            </box>
          )}</For>
      </scrollbox>
    </DialogLayout>
  )
}

export function TaskQueueDetail(props: {
  info: TaskQueueInfo; busy: boolean; onBack: () => void; onStart: () => void; onResume: () => void
  onStop: () => void; onSession: (id: string) => void
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
  const actions = (): DialogFooterAction[] => [
    { title: "返回", key: "esc", onTrigger: props.onBack },
    { title: "打开会话", key: "enter", disabled: !props.info.tasks[selected()]?.sessionID, onTrigger: open },
    ...(props.info.status === "queued" ? [{ title: "开始", key: "ctrl+s", disabled: props.busy, onTrigger: props.onStart }] : []),
    ...(canResumeTaskQueue(props.info) ? [{ title: "手动续办", key: "ctrl+e", disabled: props.busy, onTrigger: props.onResume }] : []),
    ...(props.info.status === "running" ? [{ title: "停止", key: "ctrl+x", disabled: props.busy, onTrigger: props.onStop }] : []),
  ]
  Keymap.createLayer(() => ({
    mode: "modal", commands: [
      { bind: "escape", title: "返回列表", run: props.onBack },
      { bind: "up", title: "上一任务", run: () => move(-1) },
      { bind: "down", title: "下一任务", run: () => move(1) },
      { bind: "pageup", title: "向上翻页", run: () => scroll?.scrollBy(-10) },
      { bind: "pagedown", title: "向下翻页", run: () => scroll?.scrollBy(10) },
      { bind: "enter", title: "打开任务会话", run: open },
      { bind: "ctrl+s", title: "开始批次", enabled: !props.busy && props.info.status === "queued", run: props.onStart },
      { bind: "ctrl+e", title: "手动续办", enabled: !props.busy && canResumeTaskQueue(props.info), run: props.onResume },
      { bind: "ctrl+x", title: "停止批次", enabled: !props.busy && props.info.status === "running", run: props.onStop },
    ],
  }))
  onMount(() => renderer.currentFocusedRenderable?.blur())
  return (
    <DialogLayout header={<DialogHeader title={props.info.title || "任务批次"} onClose={props.onBack} />}
      footer={{ actions: { primary: actions() } }} legacyFooter={<DialogFooter actions={{ primary: actions() }} />}>
      <scrollbox height={Math.max(3, dimensions().height - 10)} contentOptions={{ gap: 1 }}
        ref={(value: ScrollBoxRenderable) => { scroll = value }}>
        <text fg={statusColor(theme, props.info.status)}>{labels[props.info.status]}{props.busy ? " · 正在处理…" : ""}</text>
        <text fg={theme.text.muted} wrapMode="word">{taskQueueCounts(props.info.tasks)}</text>
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
              <text fg={statusColor(theme, task.status)}>{labels[task.status]} · rounds {task.rounds}</text>
              <Show when={task.reason}><text fg={theme.text.muted} wrapMode="word">原因：{task.reason}</text></Show>
              <Show when={task.summary}><text fg={theme.text.base} wrapMode="word">摘要：{task.summary}</text></Show>
              <Show when={task.sessionID}><text fg={theme.text.muted} wrapMode="word">会话：{task.sessionID}</text></Show>
            </box>
          )}</For>
      </scrollbox>
    </DialogLayout>
  )
}

export function TasksDialog(props: { context: Plugin.Context; events: ReturnType<typeof createTaskQueueEvents> }) {
  const dialog = useDialog()
  const client = useClient()
  const owner = useTaskQueueOwner()
  const theme = useTheme().surface("dialog")
  const feed = createTaskQueueFeed(() => client.api.experimental.taskQueue)
  const [view, setView] = createSignal<"list" | "detail" | "draft" | "edit" | "title" | "preview" | "delete">("list")
  const [queueID, setQueueID] = createSignal<string>()
  const [title, setTitle] = createSignal("")
  const [tasks, setTasks] = createSignal<TaskDraft[]>([])
  const [index, setIndex] = createSignal(0)
  const [editing, setEditing] = createSignal<number>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const current = createMemo(() => feed.items().find((info) => info.id === queueID()))
  // Refreshing Location metadata must not reset an in-flight draft in the same directory.
  const directory = createMemo(() => props.context.location?.directory ?? props.context.data.location.default().directory)
  let generation = 0
  let operation = 0
  createEffect(() => {
    const target = directory()
    generation++
    setView("list")
    setQueueID(undefined)
    setTasks([])
    setTitle("")
    setBusy(false)
    setFailure(undefined)
    feed.directory(target)
  })
  createEffect(on(feed.connection, () => {
    operation++
    setFailure(busy() ? "连接已更换，旧操作可能已提交；请检查当前服务后再重试。" : undefined)
    setBusy(false)
  }, { defer: true }))
  createEffect(() => {
    if (feed.loading() || current() || !["detail", "delete"].includes(view())) return
    setQueueID(undefined)
    setView("list")
  })
  onMount(() => { dialog.setSize("large"); dialog.setCentered(true) })
  onCleanup(() => { generation++; feed.dispose() })
  onCleanup(props.events.attach(feed, client))

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
  const acquire = (action: "start" | "resume") => {
    const id = queueID()
    if (!id) return
    run(async (valid) => {
      const info = await owner.acquire(id, action)
      if (valid()) feed.update(info)
    })
  }
  const stop = () => {
    const id = queueID()
    if (!id) return
    run(async (valid) => {
      const info = await client.api.experimental.taskQueue.stop({ queueID: id, reason: "用户在 /tasks 停止批次；请手动继续。" })
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
      const info = await feed.created(client.api.experimental.taskQueue.create({ directory: target, title: title().trim() || undefined, tasks: [first, ...rest] }))
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
      await client.api.experimental.taskQueue.delete({ queueID: info.id })
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
            footer: `${info.tasks.filter((task) => ["completed", "failed", "blocked", "cancelled"].includes(task.status)).length}/${info.tasks.length} · ${labels[info.status]}`,
            details: info.reason ? [info.reason] : undefined,
          }))} current={current()?.id ?? feed.items()[0]?.id} preserveSelection locked={busy()}
            onMove={(option) => setQueueID(option.value)} onSelect={(option) => open(option.value)}
            footer={<text fg={theme.text.muted} wrapMode="word">{busy() ? "正在处理…" : props.context.ui.format.path(directory())} · 面板关闭继续执行</text>}
            emptyView={<box paddingLeft={4} paddingRight={4}><text fg={theme.text.muted}>{feed.loading() ? "正在加载…" : "暂无批次。Ctrl+A 新建；开关关闭或访问被拒绝时请先检查服务端配置。"}</text></box>}
            actions={[
              { command: "tasks.new", bind: "ctrl+a", title: "新建", selection: "none", onTrigger: () => { setTasks([]); setTitle(""); setIndex(0); setView("draft") } },
              { command: "tasks.refresh", bind: "ctrl+r", title: "刷新", selection: "none", onTrigger: () => void feed.load() },
              { command: "tasks.start", bind: "ctrl+s", title: "开始", hidden: current()?.status !== "queued", onTrigger: () => acquire("start") },
              { command: "tasks.resume", bind: "ctrl+e", title: "手动续办", hidden: !current() || !canResumeTaskQueue(current()!), onTrigger: () => acquire("resume") },
              { command: "tasks.delete", bind: "ctrl+x", title: "删除", hidden: !current() || current()?.status === "running", onTrigger: () => setView("delete") },
            ]} />
        </Match>
        <Match when={view() === "detail" && current()}>
          <TaskQueueDetail info={current()!} busy={busy()} onBack={() => setView("list")}
            onStart={() => acquire("start")} onResume={() => acquire("resume")} onStop={stop}
            onSession={(sessionID) => { dialog.clear(); props.context.ui.router.navigate({ type: "session", sessionID }) }} />
        </Match>
        <Match when={view() === "draft"}>
          <DialogSelect title={`新建批次：${title() || "未命名"}`} renderFilter={false} current={index()} focusTarget={index()}
            options={tasks().map((task, index) => ({ title: `${index + 1}. ${task.title}`, value: index, description: task.prompt }))}
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
    context.ui.slot({ append: "app", render() {
      context.keymap.layer(() => ({ mode: "global", commands: [{
        id: "tasks.open", title: "任务队列 / Task queues", group: "System", slash: { name: "tasks" }, palette: true,
        run() {
          context.ui.dialog.show(() => <TasksDialog context={context} events={events} />)
        },
      }] }))
      return null
    } })
    return events.dispose
  },
})
