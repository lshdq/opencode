# 需求：Windows源码哈希并发部署

## 背景与目标

按 fork-development 的 Windows x64 构建与部署契约执行本地 fork 的构建和部署。当前契约脚本在源码身份计算阶段因无界并发打开过多文件，在 Windows 上触发 `EMFILE`，导致构建、隔离 smoke 和部署无法开始。

目标是在不改变源码身份哈希语义和部署安全边界的前提下，修复源码哈希阶段的文件句柄压力，使契约脚本可以完成构建、隔离 smoke 和版本化单文件部署。

## 功能描述

### 核心功能

- 将 `sourceIdentity` 的文件哈希计算从无界 `Promise.all` 改为有界并发处理。
- 保持文件排序、文件类型、符号链接目标和 SHA-256 计算结果不变。
- 使用契约入口 `packages/cli/script/build-win.ps1`，以已合入本 fork 的上游基线版本构建 Windows x64 产物。
- 构建及隔离 smoke 成功后，仅复制一个带版本和本地分钟时间戳的 exe 到已有部署目录。

### 边界与约束

- 不拉取、合并或推送上游，不更新 lockfile，不猜测版本。
- 使用 Bun 1.4.2；版本从 `git merge-base HEAD upstream/v2` 对应提交的根 `package.json` 读取。
- 失败或 smoke 不通过时禁止部署。
- 不激活日常 `opencode.exe`，不修改 PATH、快捷方式或服务。
- 同名部署目标必须拒绝覆盖。

## 输入输出

- 输入：当前工作区源码、`upstream/v2` 本地引用、Bun 1.4.2、已有部署目录 `D:\Program\opencode`。
- 构建追溯输出：`packages/cli/dist/windows/<build-id>/` 下的 `build-metadata.json`、`smoke-result.json` 和 `source.diff`。
- 部署输出：`D:\Program\opencode\opencode-<上游版本>-<本地时间YYYYMMDDHHmm>.exe`。

## 非功能需求（性能/安全/兼容性）

- Windows x64 兼容；源码哈希阶段不得因文件句柄上限失败。
- 有界并发避免无界打开文件，同时保留确定性哈希结果。
- 构建产物复制后校验 SHA-256，并验证改名 exe 的 `--version`。
- 部署过程使用排他创建，禁止覆盖已有文件。

## 依赖

- PowerShell 7。
- Bun 1.4.2。
- 仓库既有冻结依赖和 `bun.lock`。
- `packages/cli/script/windows-build.ts`、`windows-runtime.ts` 及既有专项测试。

## 验收标准

1. `packages/cli` 的 Windows 构建专项测试全部通过。
2. 根目录 `bun run check` 通过且无错误。
3. 契约脚本完成 Windows x64 构建和隔离 smoke。
4. `build-metadata.json` 的版本等于上游合入基线版本，lockfile 未变化。
5. 部署目录新增且仅新增本轮单个版本化 exe，复制后哈希匹配，改名 exe 的 `--version` 与基线版本一致。
6. 日常 `opencode.exe`、PATH、快捷方式和服务保持不变。
