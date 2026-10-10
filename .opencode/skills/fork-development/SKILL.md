---
name: fork-development
description: OpenCode V2 fork 功能增强、个性化优化与按需 Windows 兼容开发。触发关键词：fork 开发、V2 定制、功能增强、个性化优化、Windows 兼容、fork-development。包含上游同步决策和开发验证；不是 V1 win32 问题清单。
slash: true
---

# fork-development

本 fork 以 V2 功能增强和个性化优化为主；Windows 原生兼容按实际需求处理，不把所有改动限定为 win32 修补。开发遵守项目 `AGENTS.md` 与适用的 `dev-workflow`；上游合并另按 `merge-upstream` skill 执行，不因启动开发或构建而自动 fetch/merge/push。

## 开发原则

1. 从项目默认长期分支 `v2`（缺少本地引用时用 `origin/v2`）创建短横线命名的工作分支；上游对照为 `upstream/v2`。先确认工作区及用户改动，不覆盖未提交内容。合并上游必须先做安全审查、给出变更说明并获得用户明确确认。
2. 按需求明确 V2 的行为边界、测试和回归影响；在 `packages/core`、`packages/cli`、`packages/server`、`packages/protocol`、`packages/schema` 等对应现行模块实现，不沿用 V1 路径或配置接口。保持项目规定的依赖方向；修改公共 Protocol 或 Server `HttpApi` 后，从 `packages/client` 执行 `bun run generate`，不要直接编辑生成客户端。
3. 仅确有 Windows 兼容问题时针对 `win32` 增加平台差异处理；保持其他平台既有行为，不为假设性极端竞态增加复杂度。先复现、定位，再制定最小修复并覆盖相关测试。
4. 测试从相应包目录运行，聚焦类型检查用包目录的 `bun typecheck`；完整 lint/类型检查从仓库根运行 `bun run check`。提交信息用 `type(scope): summary`；不默认提交或推送。

## Windows x64 构建边界

本技能不维护 Windows x64 构建、隔离 smoke、打包或部署契约。实际 Windows x64 构建/部署必须加载 `windows-build` Skill，并遵守其工具链、版本来源、验收和安全约束。
