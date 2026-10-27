# 需求：TUI输入剪切

## 背景与目标

TUI 已支持输入文本选择、复制和粘贴，但缺少标准的剪切操作。需要在不破坏现有 `Ctrl+X` leader 组合键的前提下，为可编辑输入选区提供剪切能力。

## 功能描述

### 核心功能

- 标准 TUI 中，当前聚焦的可编辑输入存在选区时，按 `Ctrl+X` 将选中文本写入系统剪贴板并删除选区。
- 剪切文本沿用现有剪贴板文本转换逻辑，例如展开 Prompt 中的长文本占位符。
- 剪切成功后显示提示；剪贴板写入异常沿用现有错误提示机制。
- 删除操作进入编辑器撤销历史，可通过现有 undo 操作恢复。

### 边界与约束

- 当前可编辑输入没有选区时，`Ctrl+X` 必须继续作为 leader，不能被剪切逻辑消费。
- 剪切成功后必须清除此前遗留的 leader pending sequence，避免后续普通输入误触发 leader 命令。
- 仅精确的 `Ctrl+X` 触发剪切，带 Shift、Alt/Meta、Option、Super 或 Hyper 的组合键不得被拦截。
- 会话输出等不可编辑选区不能被删除。
- Prompt 处于 disabled 状态时不得剪切或删除其中的选区。
- 本次仅覆盖标准 TUI，不修改独立的 `--mini` 输入组件。
- 不改变默认 leader，不新增或修改 Protocol、Server API 及 SDK。

## 输入输出

- 输入：聚焦可编辑输入中的非空文本选区，以及 `Ctrl+X` 键盘事件。
- 输出：转换后的选中文本写入剪贴板，源选区从输入缓冲区删除；无可剪切选区时事件继续交由 leader 处理。

## 非功能需求（性能/安全/兼容性）

- 剪切判断必须同步完成，避免异步命令错误消费 leader。
- 复用现有跨平台 ClipboardService，兼容 Windows、macOS、Linux 和 OSC 52。
- 不自行计算 Unicode 或双宽字符偏移，选区读取和删除均使用 OpenTUI 编辑器 API。
- 剪贴板写入为异步操作，删除保持即时编辑体验；写入失败时显示错误并允许用户通过 undo 恢复。

## 依赖

- OpenTUI `EditBufferRenderable` 的 `hasSelection()`、`getSelectedText()`、`deleteSelection()`。
- `packages/tui/src/util/selection.ts` 现有选区事件拦截。
- `ClipboardService` 和 Toast 服务。

## 验收标准

- Prompt 有选区时按 `Ctrl+X`，剪贴板收到选中文本且输入选区被删除。
- Prompt 无选区时按 `Ctrl+X`，剪切逻辑不消费事件，现有 leader 功能保持可用。
- 不可编辑选区不会被删除。
- Prompt 的剪贴板文本转换函数在剪切时生效。
- 剪贴板写入能力不可用时不删除文本。
- TUI 类型检查和相关测试通过。
