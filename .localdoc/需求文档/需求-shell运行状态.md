# 需求：Shell运行状态显示

## 背景与目标

在 V2 mini/direct TUI 中，模型启动后台 shell 后，主模型执行可能先结束，但 shell 仍在运行。当前底部状态会被错误地重置为 idle，用户会误以为全部任务已经完成。

目标是让底部运行状态准确反映尚未结束的 shell 生命周期。

## 功能描述

### 核心功能

- 主会话执行结束但仍有 shell 运行时，底部继续显示运行状态。
- 多个 shell 并行时，任意 shell 仍运行则保持运行状态。
- 最后一个运行中的 shell 结束后，底部恢复 idle。
- 前台 shell 命令的现有输出和结束行为保持不变。

### 边界与约束

- 仅修改 V2 mini/direct TUI 状态流转，不扩大到桌面端或传统 TUI。
- 不改变 shell 输出内容、shell 中止语义、普通 prompt、子 agent、权限和表单行为。
- 不引入新的服务端协议或持久化字段。
- 已结束 shell 不得继续使底部保持 running。

## 输入输出

### 输入

- `session.shell.started` / `session.shell.ended` 事件。
- session execution started/succeeded/failed/interrupted 事件。
- mini footer 与 prompt queue 的状态事件。

### 输出

- Footer 状态在仍有未结束 shell 时保持 `phase: "running"`，状态文本为 shell 运行提示。
- 所有相关 shell 结束后输出 `phase: "idle"`。

## 非功能需求（性能/安全/兼容性）

- 优先使用已有内存中的 shell 生命周期集合；在 hydration、reconnect 或 resize replay 的状态重建场景，可调用已有 shell inventory 做一次有界生命周期对账，不得让可选对账请求无限阻塞 transport。
- 事件重复投递、重连 hydration 和多个 shell 事件顺序不应导致状态错误。
- 保持现有 TypeScript 类型约束和 TUI 渲染性能。

## 依赖

- `packages/tui/src/mini/stream-v2.transport.ts`
- `packages/tui/src/mini/footer.ts` / 相关 footer 状态类型（如实现需要）
- `packages/tui/test/mini/stream-v2.transport.test.ts`

## 验收标准

1. 后台 shell 启动后，即使主 session execution 已成功结束，底部仍显示运行状态。
2. 多个 shell 中一个结束时，底部仍显示运行状态。
3. 最后一个 shell 结束后，底部显示 idle/完成状态。
4. 前台 shell 直接执行的现有测试继续通过。
5. `packages/tui` 的目标测试和 `bun typecheck` 通过。
