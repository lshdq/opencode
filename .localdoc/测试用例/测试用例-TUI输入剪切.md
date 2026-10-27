# 测试用例：TUI输入剪切

## 测试范围

标准 TUI 的可编辑文本选区剪切、剪贴板转换、事件消费和 `Ctrl+X` leader 回退行为。

## 用例列表

### TC-001: 剪切可编辑输入选区
- 前置条件：可编辑输入已聚焦并存在非空选区，剪贴板支持写入。
- 操作步骤：触发 `Ctrl+X`。
- 预期结果：选中文本写入剪贴板，编辑器删除选区，事件被阻止继续传播。
- 优先级：P0

### TC-002: 无选区时保留 leader
- 前置条件：Prompt 已聚焦但没有选区。
- 操作步骤：触发 `Ctrl+X`。
- 预期结果：剪切返回未处理，事件未被阻止，可继续进入 leader 处理链。
- 优先级：P0

### TC-003: 使用 Prompt 剪贴板文本转换
- 前置条件：Prompt 选区文本存在对应的长文本占位符转换函数。
- 操作步骤：触发 `Ctrl+X`。
- 预期结果：剪贴板收到转换后的原始文本，编辑器删除可见选区。
- 优先级：P0

### TC-004: 不剪切跨组件或不可编辑选区
- 前置条件：renderer 存在选区，但聚焦对象不可删除或不属于该选区。
- 操作步骤：触发 `Ctrl+X`。
- 预期结果：不写剪贴板、不删除内容，事件不被剪切逻辑消费。
- 优先级：P1

### TC-005: 剪贴板写入能力缺失
- 前置条件：可编辑输入存在选区，但 ClipboardService 没有 write 实现。
- 操作步骤：触发 `Ctrl+X`。
- 预期结果：不删除选区，事件不被剪切逻辑消费。
- 优先级：P1

### TC-006: 剪贴板异步写入失败
- 前置条件：可编辑输入存在选区，ClipboardService.write 返回 rejected Promise。
- 操作步骤：触发 `Ctrl+X` 并等待异步任务结束。
- 预期结果：错误交给 Toast 处理；即时删除保持在编辑器 undo 历史中。
- 优先级：P1

### TC-007: 附加修饰键不触发剪切
- 前置条件：可编辑输入存在选区。
- 操作步骤：分别触发 `Ctrl+Shift+X`、`Ctrl+Alt+X`、`Ctrl+Option+X`、`Ctrl+Super+X` 和 `Ctrl+Hyper+X`。
- 预期结果：剪切逻辑不消费组合键，不写剪贴板且不删除选区。
- 优先级：P0

### TC-008: 禁用 Prompt 不允许剪切
- 前置条件：Prompt 处于 disabled 状态并保留文本选区。
- 操作步骤：触发 `Ctrl+X`。
- 预期结果：不写剪贴板且不删除选区。
- 优先级：P0

### TC-009: 剪切清除遗留 leader 状态
- 前置条件：无选区按 `Ctrl+X` 已激活 leader，在超时前通过鼠标或编辑器 API 形成输入选区。
- 操作步骤：再次触发 `Ctrl+X` 执行剪切。
- 预期结果：剪切成功，keymap pending sequence 被清空，后续普通字符不会作为 leader 后缀执行。
- 优先级：P0

## 测试命令

在 `packages/tui` 目录执行：

```shell
bun test test/util/selection.test.ts
bun test test/util/selection-integration.test.tsx
bun test test/app-lifecycle.test.tsx --timeout 30000
bun typecheck
```

## 测试场景分类

框架代码。
