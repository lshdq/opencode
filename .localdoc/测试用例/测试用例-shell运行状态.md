# 测试用例：Shell运行状态显示

## 测试范围

验证 V2 mini/direct TUI 在后台 shell 生命周期与 session execution 生命周期交错时的 footer 状态，以及现有前台 shell 行为不回归。

## 用例列表

### TC-001: 主执行结束但后台 shell 仍运行

- 前置条件：mini transport 已连接，session execution 已启动，shell started 事件已收到。
- 操作步骤：发送 `session.execution.succeeded`，暂不发送 shell ended。
- 预期结果：最后的 footer patch 仍为 `phase: "running"`，状态表示 shell 正在运行。
- 优先级：P0

### TC-002: 最后一个后台 shell 结束

- 前置条件：存在一个已启动且未结束的后台 shell。
- 操作步骤：发送该 shell 的 `session.shell.ended` 事件。
- 预期结果：footer 状态恢复为 `phase: "idle"`。
- 优先级：P0

### TC-003: 并行 shell 部分结束

- 前置条件：两个后台 shell 均已收到 started 事件。
- 操作步骤：先发送第一个 shell 的 ended 事件，再发送第二个 shell 的 ended 事件。
- 预期结果：第一个结束后仍为 running；第二个结束后才恢复 idle。
- 优先级：P1

### TC-004: 前台 shell 执行回归

- 前置条件：mini transport 已连接。
- 操作步骤：执行一个前台 shell 命令并收到 started/ended 事件。
- 预期结果：shell 输出正常渲染，命令结束后 footer 不保持 running。
- 优先级：P1

### TC-005: hydration 恢复运行中的 shell

- 前置条件：hydration 返回一个尚未完成的 shell 消息。
- 操作步骤：建立 transport 并完成 hydration。
- 预期结果：底部保持 running，不因初始 session execution idle 而显示完成。
- 优先级：P1

## 测试命令

```bash
cd packages/tui
bun test test/mini/stream-v2.transport.test.ts
bun typecheck
```

## 测试场景分类

框架代码 / 通用 TUI 状态流转。
