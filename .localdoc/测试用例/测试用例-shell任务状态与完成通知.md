# 测试用例：Shell任务状态与完成通知

## 测试范围

覆盖 App 会话标签页运行指示器、后台 shell 归属、子任务/shell 完成通知延迟及通知去重。

## 用例列表

### TC-001: 仅后台 shell 运行时显示会话进度
- 前置条件：根会话 idle，存在归属该会话且状态为 running 的 shell。
- 操作步骤：打开或保持根会话标签页，观察标签页头像区域。
- 预期结果：显示 `session-progress-indicator-v2`；shell 退出后指示器消失。
- 优先级：P0

### TC-002: 根会话完成但子任务仍运行时不通知
- 前置条件：根会话和一个子会话已建立，子会话仍为 running。
- 操作步骤：发送根会话 `session.execution.succeeded`，再发送子会话完成事件。
- 预期结果：根会话完成事件后无系统通知；所有工作结束后只通知一次。
- 优先级：P0

### TC-003: 根会话完成但后台 shell 仍运行时不通知
- 前置条件：根会话 idle，存在运行中的后台 shell。
- 操作步骤：发送根会话完成事件，随后发送 shell 退出事件。
- 预期结果：shell 退出前无完成通知；shell 退出后发送一次完成通知。
- 优先级：P0

### TC-004: 重复终止事件不重复通知
- 前置条件：会话、子任务和 shell 均已结束。
- 操作步骤：重复发送完成/退出事件。
- 预期结果：系统完成通知最多发送一次。
- 优先级：P1

### TC-005: 现有通知边界保持不变
- 前置条件：会话没有打开的标签页，或事件来自子会话。
- 操作步骤：发送成功和失败生命周期事件。
- 预期结果：不违反现有打开标签页限制；子会话不会错误触发根会话系统通知。
- 优先级：P1

## 测试命令

```text
cd packages/app
bun test --conditions=browser --isolate --preload ./happydom.ts ./test-browser/server-notification-state.test.ts
bun run test:e2e -- e2e/regression/tabs.spec.ts
bun typecheck
```

## 测试场景分类

通用 App UI 与通知状态。
