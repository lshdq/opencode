# 需求：V2 Fork 开发技能与 Windows 部署命名

## 背景与目标

现有 `win-adapt` skill 以 V1 Windows 原生适配为中心，包含过期分支、路径、版本和问题清单。V2 fork 的主要用途改为功能增强及个性化优化，并保留按需 Windows 兼容与构建说明。

## 功能描述

### 核心功能

- 将项目本地 `win-adapt` skill 改名为 `fork-development`，以 V2 fork 开发为主线，删除 V1 专属问题清单和无效命令。
- 同步更新本地 `merge-upstream` skill 为 `v2` / `upstream/v2` 流程，以及全局 `github-retry` skill 中的旧分支示例。
- Windows 构建使用已合入上游 V2 的 merge-base 提交之 `package.json` 版本号，而不是固定 `2.0.12`；构建时不自动拉取上游。
- 构建和隔离冒烟验证通过后，默认仅将可执行文件复制到 `D:\Program\opencode\opencode-<上游版本>-<本地时间YYYYMMDDHHmm>.exe`；支持现有 `-DeployRoot`，同名拒绝覆盖。构建目录内原有元数据继续用于追溯，不随部署复制。
- 保留 `-BuildOnly`（只构建）与 `-NoDeploy`（构建并冒烟）选项；不修改默认 `opencode.exe`、PATH、快捷方式或服务。

### 边界与约束

- 不在此任务中实际合并、推送上游、构建或部署正式制品。
- 不覆盖用户工作区现有修改；`.opencode/skills` 受到上级 Git ignore 规则影响，需单独核对文件是否实际存在。
- 文件名采用本地时间、精确到分钟；同分钟的第二次部署应失败而非覆盖。

## 输入输出

- 输入：HEAD、仓库内 `upstream/v2` 引用、已合入的共同祖先、该提交的 `package.json`，构建完成的 Windows exe。
- 输出：V2 fork 开发 skill、相关 skill 示例、更新后的构建与验证指令及单个带版本与时间戳的 exe。

## 非功能需求（性能/安全/兼容性）

- 沿用冻结依赖、源码哈希、隔离冒烟及部署前检查；上游版本须与可执行文件 `--version` 一致。
- 部署失败或同名冲突不覆盖现有目标；保持 V2 Windows x64 构建限制。
- 按项目规则从包目录运行测试，从根目录运行 `bun run check`。

## 依赖

- V2 构建脚本及 Windows 运行时辅助模块；本地 Git `upstream/v2` 引用；Bun 1.4.2 / PowerShell 7。

## 验收标准

1. 新 skill 可按 `fork-development` 名称发现，旧 skill 不再给出 V1 误导指令。
2. `merge-upstream` 和 `github-retry` 示例使用正确 V2 分支；原有合并前确认与审查要求保留。
3. 上游版本和部署文件名不再写死 `2.0.12`；部署只产生单个目标 exe，同名不覆盖。
4. 相关测试、文档检查、项目规定的基本验证完成并记录结果。
