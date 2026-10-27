# 需求：Windows x64 构建 Skill 拆分

## 背景与目标

当前 `fork-development` 同时包含 fork 开发规则和 Windows x64 构建、smoke、部署契约。需要将构建契约独立为专用 Skill，并提供确定性的 `/build` 命令，降低职责耦合并提高“构建”请求加载正确规则的概率。

## 功能描述

### 核心功能

1. 新增 `windows-build` Skill，完整承载现有 Windows x64 构建与部署契约。
2. `fork-development` 保留 fork 开发规则，并明确实际 Windows x64 构建必须加载 `windows-build`。
3. 新增 `/build` 项目命令，明确要求加载 `windows-build`，并将命令参数传递给构建流程。

### 边界与约束

- 不改变现有构建脚本、构建参数或部署行为。
- 不删除构建契约中的版本来源、smoke、部署冲突保护和验收要求。
- `/build` 是确定性入口；自然语言“构建”仍由模型根据 Skill 描述判断是否加载。
- 不新增自动拉取、自动提交、自动推送或自动激活日常服务的行为。

## 输入输出

- 输入：`/build` 及可选的 `-BuildOnly`、`-NoDeploy`、`-SkipInstall`、`-Bun`、`-DeployRoot` 等现有构建参数。
- 输出：向当前会话提交严格加载 `windows-build` 后执行构建的任务提示。
- Skill 输出：构建、隔离 smoke 和部署的规则与验收要求。

## 非功能需求（性能/安全/兼容性）

- 保持 OpenCode V2 Skill 和 Command 的目录约定。
- 不修改运行时代码，不引入第三方依赖。
- 保留现有安全约束：构建失败或 smoke 失败时禁止部署，同名部署目标禁止覆盖。

## 依赖

- `.opencode/skills/fork-development/SKILL.md`
- 新增 `.opencode/skills/windows-build/SKILL.md`
- 新增 `.opencode/commands/build.md`
- `packages/cli/script/build-win.ps1` 及其相关实现作为构建契约指向的实际入口。

## 验收标准

1. `windows-build` Skill 存在，且包含原构建契约的全部关键规则。
2. `fork-development` 不再重复维护完整构建契约，并明确引用 `windows-build`。
3. `/build` 命令存在，且明确要求加载 `windows-build`，支持传递参数。
4. Skill、Command 的 frontmatter 和目录结构符合项目约定。
5. 变更不包含生产代码或运行时行为修改。
