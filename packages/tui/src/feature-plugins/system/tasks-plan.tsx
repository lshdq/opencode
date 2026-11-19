import type { TaskQueueInfo, TaskQueueTask } from "@opencode/client"
import { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { DialogFooter, DialogHeader, DialogLayout } from "../../ui/dialog"

/** Read-only persisted plan. Approval belongs exclusively to the Session's real Form. */
export function TaskQueuePlan(props: {
  info: TaskQueueInfo; task: TaskQueueTask; busy: boolean; onBack: () => void
  onReplan?: () => void; onSession: (sessionID: string) => void
}) {
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined
  const open = () => { if (props.task.sessionID) props.onSession(props.task.sessionID) }
  const actions = () => [
    { title: "返回", key: "esc", onTrigger: props.onBack },
    { title: "打开会话", key: "enter", disabled: !props.task.sessionID, onTrigger: open },
    ...(props.onReplan ? [{ title: "重开规划", key: "ctrl+r", disabled: props.busy, onTrigger: props.onReplan }] : []),
  ]
  Keymap.createLayer(() => ({ mode: "modal", commands: [
    { bind: "escape", title: "返回批次", run: props.onBack },
    { bind: "enter", title: "打开任务会话", run: open },
    { bind: "ctrl+r", title: "重开规划并撤销批准", enabled: !!props.onReplan && !props.busy, run: () => props.onReplan?.() },
    { bind: "up", title: "向上滚动", run: () => scroll?.scrollBy(-1) },
    { bind: "down", title: "向下滚动", run: () => scroll?.scrollBy(1) },
    { bind: "pageup", title: "向上翻页", run: () => scroll?.scrollBy(-10) },
    { bind: "pagedown", title: "向下翻页", run: () => scroll?.scrollBy(10) },
    { bind: "home", title: "方案开头", run: () => scroll?.scrollTo(0) },
    { bind: "end", title: "方案末尾", run: () => scroll?.scrollTo(scroll.scrollHeight) },
  ] }))
  const approval = (value: NonNullable<TaskQueueTask["plan"]>["approval"]) => value
    ? `${value.choice} · v${value.version} · Form ${value.formID} · ${new Date(value.time).toISOString()}` : "未批准"
  return <DialogLayout header={<DialogHeader title={`完整方案：${props.task.title}`} onClose={props.onBack} />}
    footer={{ actions: { primary: actions() } }} legacyFooter={<DialogFooter actions={{ primary: actions() }} />}>
    <scrollbox height={Math.max(3, dimensions().height - 10)} contentOptions={{ gap: 1 }} ref={(value: ScrollBoxRenderable) => { scroll = value }}>
      <text fg={theme.text.muted} wrapMode="word">只读方案；批准仅在任务会话的需求/方案 Form 完成。↑/↓、PgUp/PgDn、Home/End 滚动。</text>
      <Show when={props.onReplan}><text fg={theme.text.muted} wrapMode="word">重开规划会立即提升版本，撤销本项及受影响依赖项的批准；需要重新确认，仍不会自动开始执行。</text></Show>
      <text fg={theme.text.base} wrapMode="word">顺序：{props.task.position} · 任务：{props.task.id}</text>
      <text fg={theme.text.muted} wrapMode="word">原始任务：{props.task.prompt}</text>
      <Show when={props.task.plan} fallback={<text fg={theme.text.muted}>尚无已保存方案</text>}>{(plan) => <>
        <text fg={theme.text.base} wrapMode="word">类型：{plan().type === "development" ? "开发任务" : "其他任务"} · 方案 v{plan().version} · 需求 v{plan().requirementsVersion} · 模式：{plan().mode ?? "未选择"}</text>
        <text fg={theme.text.muted} wrapMode="word">需求审批：{approval(plan().requirementsApproval)}</text>
        <text fg={theme.text.muted} wrapMode="word">方案审批：{approval(plan().approval)}</text>
        <Show when={plan().requirementsApproval?.answer}><text fg={theme.text.muted} wrapMode="word">需求原始回答：{JSON.stringify(plan().requirementsApproval!.answer)}</text></Show>
        <Show when={plan().approval?.answer}><text fg={theme.text.muted} wrapMode="word">方案原始回答：{JSON.stringify(plan().approval!.answer)}</text></Show>
        <text fg={theme.text.base} wrapMode="word">依赖：{plan().dependencies.map((id) => {
          const task = props.info.tasks.find((task) => task.id === id)
          return task ? `${task.position}. ${task.title} (${id})` : id
        }).join("、") || "无"}</text>
        <text fg={theme.text.base} wrapMode="word">需求全文：{"\n"}{plan().requirements}</text>
        <box flexShrink={0}>
          <text fg={theme.text.base}>验收标准：</text>
          <For each={plan().acceptance}>{(item, index) => <text fg={theme.text.base} wrapMode="word">{index() + 1}. {item}</text>}</For>
        </box>
        <text fg={theme.text.base} wrapMode="word">方案全文：{"\n"}{plan().proposal ?? "尚未提交方案"}</text>
      </>}</Show>
      <text fg={theme.text.muted} wrapMode="word">方案快照：{props.info.snapshot ?? "手动开始前由服务保存到项目 .localdoc/任务队列/；保存失败不执行。"}</text>
    </scrollbox>
  </DialogLayout>
}
