# 需求：Kimi K3 启动脚本

## 背景与目标

为 Windows 环境提供一个独立的 OpenCode 启动脚本，便于直接使用 Kimi For Coding 的 Kimi K3 模型，同时保持现有 OpenAI 启动脚本不变。

## 功能描述

### 核心功能

- 在 `D:\Program\opencode\opencodeKimi.cmd` 创建启动脚本。
- 默认模型使用 `kimi-for-coding/k3`。
- 将开发子智能体的 fast、standard、deep 档位分别映射为 `low`、`high`、`max`。
- 将调用者提供的额外命令行参数原样传递给 `opencode`。
- 返回 `opencode` 进程的退出码。

### 边界与约束

- 参考 `D:\Program\opencode\opencodeOpenai.cmd` 的结构与调用方式。
- 不修改 `opencodeOpenai.cmd`。
- 不修改 OpenCode 全局配置或认证信息。
- 使用 Windows CMD 兼容语法与 ASCII 内容。

## 输入输出

- 输入：调用脚本时附加的任意 OpenCode CLI 参数。
- 输出：OpenCode CLI 的标准输出、标准错误和退出码。

## 非功能需求（性能/安全/兼容性）

- 不在脚本中写入密钥或令牌。
- 路径和变量赋值使用安全的 CMD 引号形式。
- 脚本应可在当前 Windows OpenCode 安装环境中执行。

## 依赖

- `opencode` 命令已安装并可从 `PATH` 解析。
- 用户已为 `kimi-for-coding` provider 配置有效认证。
- 当前 OpenCode 模型目录包含 `kimi-for-coding/k3`。

## 验收标准

- `D:\Program\opencode\opencodeKimi.cmd` 存在，内容结构与参考脚本一致。
- `OPENCODE_DEV_MODEL` 为 `kimi-for-coding/k3`。
- 三档 variant 依次为 `low`、`high`、`max`。
- 启动命令包含 `--model "%OPENCODE_DEV_MODEL%" %*`。
- 脚本返回被调用命令的退出码。
- 现有 `opencodeOpenai.cmd` 未发生变化。
