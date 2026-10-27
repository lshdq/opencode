# 测试用例：permission.mode 切换快捷键

## 测试范围

覆盖 TUI 快捷键配置解析、命令映射、App 基础模式中的实际按键触发，以及英文快捷键文档。既有权限审批规则、服务端接口和桌面端行为不在本次测试范围内。

## 用例列表

### TC-001: 默认不注册快捷键
- 前置条件：未配置 `keybinds.permission_mode`。
- 操作步骤：解析默认 TUI 配置并查询 `permission.mode` 绑定。
- 预期结果：查询不到有效绑定，不占用默认按键。
- 优先级：P0

### TC-002: 解析自定义快捷键
- 前置条件：配置 `keybinds.permission_mode` 为一个合法组合键。
- 操作步骤：解析 TUI 配置并查询 `permission.mode` 绑定。
- 预期结果：返回配置的组合键，命令描述正确。
- 优先级：P0

### TC-003: 快捷键切换到自动批准模式
- 前置条件：TUI 以 `normal` 模式启动，并为 `permission_mode` 配置快捷键。
- 操作步骤：启动测试 TUI，按下配置的快捷键，重新渲染界面。
- 预期结果：快捷键触发 `permission.mode` 命令，输入区域显示现有 `auto` 状态提示。
- 优先级：P0

### TC-004: 快捷键往返切换
- 前置条件：已完成 TC-003，当前为 `auto` 模式。
- 操作步骤：再次按下同一快捷键，重新渲染界面。
- 预期结果：权限模式恢复为 `normal`，输入区域不再显示 `auto` 状态提示。
- 优先级：P1

### TC-005: 文档列出配置项
- 前置条件：英文快捷键文档已更新。
- 操作步骤：检查 `packages/web/src/content/docs/keybinds.mdx` 的配置示例。
- 预期结果：示例包含 `"permission_mode": "none"`。
- 优先级：P1

## 测试命令

在 `packages/tui` 目录执行：

```bash
bun test --timeout 30000 test/config.test.tsx test/app-lifecycle.test.tsx
bun run test
bun typecheck
```

## 测试场景分类

框架代码。
