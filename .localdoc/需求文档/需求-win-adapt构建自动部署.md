# 需求：win-adapt构建自动部署

## 背景与目标

当前 win-adapt skill 将构建和部署分别描述，用户说“构建”时可能只生成产物而不执行部署。目标是让 win-adapt 场景中的“构建”默认包含安全的版本化部署。

## 功能描述

### 核心功能

- 将“构建”加入 win-adapt skill 的触发语义。
- 收到构建要求时，先执行 Windows 构建，成功后自动部署版本化可执行文件。
- 从构建产物读取实际版本号，部署到 `D:\Program\opencode\opencode.exe.<实际版本号>`。
- 校验部署目标存在，构建或部署失败时明确报告失败。

### 边界与约束

- 构建失败时不得部署。
- 不覆盖或激活 `D:\Program\opencode\opencode.exe`。
- 仅在用户明确要求“只构建、不部署”时跳过部署。
- 本次仅修改 win-adapt skill，不修改构建脚本。

## 输入输出

- 输入：用户在 win-adapt 场景中提出“构建”要求，可附带 `-WinVersion` 等构建参数。
- 输出：构建产物及安装目录中的版本化文件 `opencode.exe.<实际版本号>`，并报告部署路径。

## 非功能需求（性能/安全/兼容性）

- 保持当前版本化部署的文件锁安全策略。
- 版本号来源必须与实际产物一致，避免部署文件名与内嵌版本不一致。
- 使用 PowerShell 7 命令，路径参数使用字面路径。

## 依赖

- `packages/opencode/script/build-win.ps1`
- 构建产物 `packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`
- 安装目录 `D:\Program\opencode`

## 验收标准

- skill 明确规定“构建”默认包含版本化部署。
- skill 提供可执行的构建后部署命令，版本号取自产物 `--version`。
- 命令校验构建退出状态、版本格式、安装目录和部署结果。
- skill 明确禁止自动覆盖或激活当前 `opencode.exe`。
- “改造流程”中的验证步骤与新规则一致。
