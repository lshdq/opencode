---
name: merge-upstream
description: 定期把 opencode 官方上游(anomalyco/opencode)代码合并到本地 fork(lshdq/opencode)的 win-adapt 分支。触发关键词：合并上游、同步上游、merge upstream、sync fork、拉官方代码、更新 fork、同步 dev。含前置检查、差异评估、冲突处理、typecheck 验证、推送。
slash: true
---

# merge-upstream

把官方上游 `upstream/dev` 合并进 fork 的长期分支 `win-adapt`，定期执行以保持与上游同步。

## 前置（每次必查）

1. 当前目录是 fork 仓库（`git remote -v` 含 `upstream` 与 `origin`）：
   - `upstream` = https://github.com/anomalyco/opencode.git（官方，只读）
   - `origin`   = https://github.com/lshdq/opencode.git（你的 fork）
   不符则停下提示用户，**不擅自改 remote**。
2. 工作区干净：`git status --porcelain` 为空；非空则提示先 stash / commit。
3. 当前分支应为 `win-adapt`；不在则切过去。

## 流程

1. 拉取上游：`git fetch upstream --tags --prune`
2. 评估差异并向用户汇报：
   - `git log --oneline win-adapt..upstream/dev`（将并入的提交）
   - `git rev-list --left-right --count win-adapt...upstream/dev`（领先 / 落后数）
3. 合并（默认 merge）：
   - `git merge upstream/dev`（保留默认合并信息）
   - 无冲突 → 进入验证。
   - 用户显式要求 rebase 时改用 `git rebase upstream/dev`（提醒：rebase 后需 force push，仅单人分支可用）。
4. 冲突处理（如有）：
   - `git diff --name-only --diff-filter=U` 列出冲突文件，**停下让用户决策**。
   - 用户解决后 `git add <files>` + `git merge --continue`（rebase 用 `git rebase --continue`）。
   - 用户要放弃 → `git merge --abort`（或 `git rebase --abort`）。
   - **禁止**擅自自动解冲突、`--force`、丢弃改动。
5. 验证（默认）：
   - `bun turbo typecheck`（仓库根；或 `bun run --cwd packages/opencode typecheck`）。
   - bun 未安装则跳过并明确告知用户。
   - typecheck 失败 → 停下报告错误，**不推送**，让用户决定修复或回滚。
6. 推送：
   - 确认 `origin` 是 fork（非官方）后 `git push origin win-adapt`。
   - 汇总：合并提交数、冲突数、typecheck 结果、是否已推送。

## 安全规则

- 任何步骤失败 → 停下询问，不强行继续。
- 推送目标必须是 fork；**绝不向 upstream（官方）推送**。
- 不 force push（除非用户明确要求 rebase 路线并知情）。
- 不自动解决冲突。
