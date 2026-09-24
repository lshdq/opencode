---
name: merge-upstream
description: 定期把 OpenCode 官方上游(anomalyco/opencode)的 V2 代码合并到本地 fork(lshdq/opencode)的 v2 长期分支。触发关键词：合并上游、同步上游、merge upstream、sync fork、拉官方代码、更新 fork、同步 v2。含前置检查、差异评估、合并前安全审查与用户确认、冲突处理、验证和向 fork 推送。
slash: true
---

# merge-upstream

把官方上游 `upstream/v2` 合并进 fork 的长期分支 `v2`，定期执行以保持与上游同步。此技能专门用于合并；普通开发不自动合并上游。遵守项目 `AGENTS.md` 的默认分支、验证及提交规则。

## 前置（每次必查）

1. 当前目录是 fork 仓库（`git remote -v` 含 `upstream` 与 `origin`）：
   - `upstream` = https://github.com/anomalyco/opencode.git（官方，只读）
   - `origin`   = https://github.com/lshdq/opencode.git（你的 fork）
   不符则停下提示用户，**不擅自改 remote**。
2. 工作区干净：`git status --porcelain` 为空；非空则提示先 stash / commit，不自行覆盖或暂存用户改动。`.opencode/skills` 可能被全局忽略；合并涉及技能时还需核查这些实际文件，不能单凭 status 判断不存在改动。
3. 当前分支应为 `v2`；不在则先检查 `v2` 是否存在、能否安全切换。不得未经确认在别的分支上合并或重置工作区。

## 流程

1. 拉取上游：`git fetch upstream --tags --prune`
2. 评估差异并向用户汇报：
   - `git log --oneline v2..upstream/v2`（将并入的提交）
   - `git rev-list --left-right --count v2...upstream/v2`（领先 / 落后数）
3. **安全审查（强制，合并前）**：审查待合并代码 `git diff v2...upstream/v2`，排查危险代码：
   - 窃取隐私 / 外传数据：向陌生域名 POST、上报 token / 密钥 / 凭据 / 环境变量、可疑 telemetry。
   - 危害数据：删除 / 篡改 / 加密用户文件、破坏性 shell、`rm -rf` 类操作。
   - 混淆 / 可疑下载执行：eval、base64 解码后执行、远程脚本下载即运行、新增可疑二进制。
   - 擅动敏感文件：auth / credential / 密钥 / 钱包相关文件。
   数据量大时重点扫 `git diff v2...upstream/v2 --stat` 中的高敏路径（auth、credential、install、postinstall、网络 / 进程相关）+ 关键词。
   **发现可疑项 → 停下，向用户逐条报告（file:line + 说明），经用户判定安全前绝不合并。**
4. **变更说明 + 用户确认（强制，合并前）**：合并前先生成一份待合并变更说明交给用户，**等用户明确确认后才合并**：
   - 提交清单（`git log --oneline v2..upstream/v2`）。
   - 按模块 / 目录归纳的主要变更（`git diff v2...upstream/v2 --stat` 摘要）。
   - 安全审查结论（第 3 步）。
   - 潜在影响 / 风险点（如触及你已有补丁的文件、构建 / 依赖变更）。
   **未获用户明确确认，不得执行合并。**
5. 合并（默认 merge）：
   - `git merge upstream/v2`（保留默认合并信息）
   - 无冲突 → 进入验证。
   - 用户显式要求 rebase 时才考虑 `git rebase upstream/v2`（提醒：rebase 后需 force push，仅单人分支且获用户知情同意时可用）。
6. 冲突处理（如有）：
   - `git diff --name-only --diff-filter=U` 列出冲突文件。
   - **优先自行解决**：先理解本 fork 的改造意图——查 `v2` 相对 `upstream/v2` 的自有提交（`git log upstream/v2..v2`）及相关实现，按“保留本 fork 改造 + 吸收上游变更”的原则解决，**不盲目取一边**。
   - **仅当确实难以判断**（改造意图与上游变更语义冲突、无法确定取舍）时，才停下请用户决策该处。
   - 解决后 `git add <files>` + `git merge --continue`（rebase 用 `git rebase --continue`）。
   - 用户要放弃 → `git merge --abort`（或 `git rebase --abort`）。
   - **禁止**：不理解 fork 意图就解冲突、`--force`、丢弃本 fork 的改造。
7. 验证（默认）：
   - 从仓库根执行 `bun run check`；聚焦迭代可在受影响包目录执行 `bun typecheck`，不得直接运行 `tsc` 或从根目录运行测试。
   - bun 未安装则跳过并明确告知用户。
   - typecheck 失败 → 停下报告错误，**不推送**，让用户决定修复或回滚。
8. 推送：
   - 确认 `origin` 是 fork（非官方）且用户授权推送后 `git push origin v2`。
   - 汇总：合并提交数、冲突数、typecheck 结果、是否已推送。

## 安全规则

- 任何步骤失败 → 停下询问，不强行继续。
- **合并前必做安全审查**：发现窃取隐私 / 危害数据等危险代码，停下报告用户，判定安全前不合并。
- **合并前必做变更确认**：先给用户变更说明，获明确确认后才合并。
- 推送目标必须是 fork；**绝不向 upstream（官方）推送**。
- 不 force push（除非用户明确要求 rebase 路线并知情）。
- 解冲突须先理解本 fork 改造意图，**仅在确实难解时**停下问用户；不盲目取一边、不丢弃 fork 改造。
