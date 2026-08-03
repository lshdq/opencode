# opencode Windows Fork 搭建与上游同步指南

> 状态：fork 已创建（`https://github.com/lshdq/opencode.git`，默认分支 `dev`）。
> 日期：2026-07-30
> 关联：`opencode-wsl-setup.md`（WSL 备选方案）

## 0. 决策记录

- **路线**：Windows 原生 + GitHub fork（名 `opencode`），定期同步官方上游。
- **为何不选 WSL**：平时主要在 Windows 下开发，WSL 双环境（代码 / Java 栈 / IDE 割裂）摩擦大。
- **为何不做 C++ 重写**：痛点（进程挂起 / 编码 / 信号）是**正确性**问题，非 TS 性能问题；重写会丧失上游同步能力，且脱离 Effect / AI SDK / 插件生态。
- **维护范围**：先仅搭基建（fork + 同步纪律），**暂不写修复**；改造按需渐进扩展。
- **公开分发**：暂不做（无 CI / 签名 / 品牌承诺），纯自用 + 可选上游 PR。

## 1. 角色与 remote 布局

| 角色 | 地址 |
|---|---|
| 官方上游 `upstream` | `https://github.com/anomalyco/opencode.git`（只读同步源，**绝不推送**） |
| 你的 fork `origin` | `https://github.com/lshdq/opencode.git`（推送目标） |

- 官方默认分支：`dev`（本仓库主开发分支，**不是 main**）。
- 本地仓库：`D:\works\thirdparty\opencode`（就地重配 remote）。

## 2. 网页 fork 步骤（已完成）

1. 打开 https://github.com/anomalyco/opencode → 右上角 **Fork**。
2. Owner 选自己账号；Repository name 保持 `opencode`；"Copy the default branch only" 保持勾选；**Create fork**。
3. fork 的 Settings → General → Default branch 确认为 `dev`。
4. fork 地址：`https://github.com/lshdq/opencode.git`。

## 3. 本地 remote 配置（就地重配）

```powershell
cd D:\works\thirdparty\opencode

# 现状 origin=官方 → 改名 upstream（只读同步源）
git remote rename origin upstream

# 新增 origin → 你的 fork（推送目标）
git remote add origin https://github.com/lshdq/opencode.git

# 同步上游最新
git fetch upstream

# dev 对齐上游
git checkout dev
git merge --ff-only upstream/dev

# 建长期分支 win-adapt（所有改造落这）
git checkout -b win-adapt

# 推送到 fork
git push -u origin win-adapt
git push origin dev
```

验证：

```powershell
git remote -v        # upstream=anomalyco/opencode，origin=lshdq/opencode
git branch -vv       # win-adapt（当前），dev 跟踪 upstream/dev
```

## 4. 同步纪律（定期 merge 上游）

建议频率：每周 / 每个上游 release。

```powershell
cd D:\works\thirdparty\opencode
git checkout win-adapt
git status --porcelain              # 确认工作区干净，否则先 stash/commit
git fetch upstream --tags --prune

# 预览将并入的提交
git log --oneline win-adapt..upstream/dev
git rev-list --left-right --count win-adapt...upstream/dev   # 领先/落后数

# 合并（默认 merge，保留历史）
git merge upstream/dev
```

冲突处理：

```powershell
git diff --name-only --diff-filter=U     # 列冲突文件，逐个解决
git add <已解决文件>
git merge --continue
# 放弃本次合并：git merge --abort
```

合并后验证：

```powershell
bun turbo typecheck       # 或 bun run --cwd packages/opencode typecheck（需先装 bun）
```

推送（**目标必须是 fork**）：

```powershell
git push origin win-adapt
```

也可用 opencode 的 `merge-upstream` skill（`.opencode/skills/merge-upstream`，slash 命令 `/merge-upstream`）自动走上述流程。

## 5. 降低冲突的策略

- 改造收进**平台专属文件 + 条件导入**（仿 `#sqlite`/`#pty`）与已有 `process.platform === "win32"` 分支。
- 必须改共享行时加 `// win-adapt:` 标记，便于冲突识别。
- 第三方库（含 effect）改动走 `patchedDependencies`（patches/ 目录），不直接改 node_modules。
- 补丁集保持小而集中，rebase / merge 成本最低。
- 每次同步后跑 Windows 回归（挂起 / 编码场景）。

## 6. 安全红线

- **绝不向 `upstream`（官方）推送**；推送目标永远是 `origin`（fork）。
- 不 force push（除非明确改走 rebase 路线且分支仅自用）。
- 冲突不自动解决，逐个确认。

## 7. 后续改造 backlog（按性价比，暂未实施）

| 项 | 内容 | 上游候选 |
|---|---|---|
| A+B+C | 进程挂起修复：kill/finalizer 有界等待 + exit 语义 + 输出 fiber 可中断 | 是（纯修复，易接受） |
| 编码 | 子进程输出按代码页解码（GBK↔UTF-8）+ 注入 UTF-8 环境 | 是 |
| Job Object | Windows 进程组式可靠杀树 | 否（侵入式） |
| 信号 | SIGTERM 优雅退出 / Ctrl+C / SIGBREAK 语义 | 部分 |

原则：纯修复**优先提 PR 上游**，合并后即免维护；侵入式 / 分发特性留 fork。

## 8. 构建 exe（已验证通过）

### bun 安装（D 盘，绕 github）
- 官方安装脚本走 github releases（时断时续），改用 **npm 镜像**：下载 `https://registry.npmjs.org/@oven/bun-windows-x64/-/bun-windows-x64-1.3.14.tgz`，解出 `bun.exe`。
- 装到 `D:\Program\bun\bin\bun.exe`；用户环境变量：`BUN_INSTALL=D:\Program\bun`、`BUN_INSTALL_CACHE_DIR=D:\Program\bun\cache`、PATH 追加 `D:\Program\bun\bin`。全在 D 盘。

### 构建命令（推荐用包装脚本）
```powershell
bun install --ignore-scripts                       # 首次/依赖变更时；跳过 tree-sitter 的 node-gyp（需 Python+github），构建用 WASM 已自带
.\packages\opencode\script\build-win.ps1           # 默认适配号 1，精简版（不嵌 Web UI）
.\packages\opencode\script\build-win.ps1 -WinVersion 2     # 第二个适配版
.\packages\opencode\script\build-win.ps1 -SkipWebUi:$false # 嵌入 Web UI
```
`build-win.ps1` 自动：fetch upstream → 取 base 版本 → 算版本号 → 设 `MODELS_DEV_API_JSON`（本地缓存绕开被墙的 models.dev）→ 调 `build.ts --single`。

### 版本号方案
- 格式：`<upstream/dev 版本>.w<适配号>`，如 **`1.18.9.w1`**（base 取 upstream/dev 的 `packages/opencode/package.json`，适配号从 1 起递增）。
- 构建时经 `OPENCODE_VERSION` 覆盖（零代码分歧，利于合并上游）。
- **副作用（利好）**：channel 变为 `latest` → 数据库默认走共享 `opencode.db`（与原版会话共享，无需 `OPENCODE_DISABLE_CHANNEL_DB`）。

### 产物与实测
- `packages/opencode/dist/opencode-windows-x64/bin/opencode.exe`，独立单文件（无需 bun/node）。
- 体积 **~136 MB**，启动 **~430-480ms**，版本 `1.18.9.w1`。
- `--skip-embed-web-ui`：Web 界面走代理 `app.opencode.ai`（可能被墙）；**TUI / HTTP API / SDK / IDE 集成均不受影响**。

### CI
- `.github/workflows/build-windows.yml`（简化 Windows-only，不签名）：`windows-latest` + `workflow_dispatch`/tag 触发 + `oven-sh/setup-bun` + 构建 + 上传 Release。
- 版本同方案：base（upstream/dev）+ `.w<N>`（tag 触发时 N 取自 tag 的 `.w<N>` 后缀，否则默认 1）。CI 网络可直连 github/models.dev。

## 9. Windows 符号链接修复（typecheck 前提）

- **问题**：`core.symlinks=false` 时，仓库 ~60 个符号链接被检出成"内容为路径字符串"的纯文本伪链接；其中 2 个 `.d.ts`（app/enterprise 的 `custom-elements.d.ts`）导致 desktop typecheck 报 TS1128，进而 pre-push 钩子失败。
- **前提**：启用 Windows **开发者模式**（设置 → 开发者选项；非管理员即可建 symlink）。
- **修复**：把每个伪链接替换为真符号链接（目标取自原文件内容）+ `git update-index --skip-worktree`（保持 git 状态干净）。已全量修复 60 个，typecheck 30/30 通过。
- **注意**：符号链接 + skip-worktree 是**本机状态**，不入 git；换机/重新克隆需重做此修复。
