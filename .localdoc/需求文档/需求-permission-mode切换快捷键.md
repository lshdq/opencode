# 需求：permission.mode 切换快捷键

## 背景与目标

TUI 已提供 `permission.mode` 命令用于在普通权限确认和自动批准模式之间切换，但该命令只能通过命令面板执行。目标是将该命令接入可配置快捷键体系，让用户能够在 `tui.json` 中自行绑定快捷键。

## 功能描述

### 核心功能

- 在 `tui.json.keybinds` 中新增 `permission_mode` 配置项。
- `permission_mode` 映射到已有的 `permission.mode` 命令。
- 用户配置快捷键后，可直接在 `normal` 和 `auto` 权限模式间切换。
- 继续复用现有动态命令标题和输入区域的 `auto` 状态提示。

### 边界与约束

- `permission_mode` 默认值为 `none`，不占用新的默认按键。
- 不改变权限模式的运行期存储方式和启动参数语义。
- 不自动处理切换前已经挂起的权限请求。
- 不修改桌面端/Web App 的自动批准实现。
- 不修改 Protocol、Server HttpApi 或 SDK，不执行代码生成。

## 输入输出

- 输入：用户在 `tui.json.keybinds.permission_mode` 配置的合法按键绑定。
- 输出：按键触发后，TUI 的权限模式在 `normal` 与 `auto` 之间切换；`auto` 模式继续显示现有状态提示。

## 非功能需求（性能/安全/兼容性）

- 不新增运行时依赖或网络调用。
- 显式 `deny` 权限规则的行为保持不变。
- 默认不绑定按键，避免不同终端和用户现有快捷键冲突。
- 配置格式、命令命名和绑定注册方式遵循现有 TUI keybind 体系。

## 依赖

- 复用 `packages/tui` 中已有的 `permission.mode` 命令和 PermissionProvider。
- 复用 `@opentui/keymap` 的配置解析和命令绑定机制。

## 验收标准

- `tui.json` 接受 `keybinds.permission_mode`，不会将其视为未知配置。
- 未配置时，`permission.mode` 不新增默认快捷键。
- 配置快捷键后，该绑定解析为 `permission.mode` 命令。
- 在 TUI 基础模式中按下配置的快捷键，可以切换权限模式并显示现有 `auto` 提示。
- 英文快捷键文档列出 `permission_mode` 及其默认值 `none`。
- 相关测试和 TUI 类型检查通过。
