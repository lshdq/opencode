---
name: win-adapt
description: opencode Windows 适配改造与构建部署。触发关键词：构建、windows适配、win-adapt、windows问题、win32修复、windows兼容、win32适配。包含：已知问题清单、已完成适配、设计原则、改造流程、构建验证、部署；构建默认同时执行安全的版本化部署。
slash: true
---

# win-adapt

opencode 官方建议 Windows 用户使用 WSL，本 fork（`win-adapt` 分支）的目标是让 opencode 在原生 Windows 下可靠运行。

## 分支与版本

- 分支：`win-adapt`（基于 `upstream/dev` fork）
- 版本号：`<fork基准版本>.w<适配号>`，如 `1.18.11.w3`
  - 基准版本 = `git merge-base HEAD upstream/dev` 处的 `packages/opencode/package.json` version，**不随上游推进而变**
  - 适配号每次构建递增
- 构建脚本：`packages/opencode/script/build-win.ps1`（自动从 merge-base 取基准版本）

## 设计原则

1. **改动放 win32 分支**：用 `process.platform === "win32"` 守卫，不改变非 win32 行为
2. **优先原地修改**：在已有文件中添加 win32 分支代码块，不建新文件（除非改动量大到值得隔离）
3. **新增优先于修改**：添加新代码块而非改写已有行，降低定期合并上游时的冲突风险
4. **多层防御**：关键路径（如进程生命周期）加多层超时/兜底，单点失败不导致永久挂起
5. **常量集中**：win32 相关超时/阈值定义为文件顶部命名常量（`WIN32_` 前缀）

## 构建与部署

用户说“构建”时，必须依次完成构建、冒烟验证、版本化部署和部署校验，不得在构建成功后停止。只有用户明确要求“只构建、不部署”时才跳过部署。

- 构建失败时不得执行部署。
- 版本号必须从本次构建产物的 `--version` 输出读取，不得根据参数或日志猜测。
- 仅部署版本化文件；不要覆盖现有 `opencode.exe`（可能被运行中的进程锁定）。
- 激活（替换 `opencode.exe`）仅在用户明确要求，且所有 opencode 实例均已退出后执行。

```powershell
$ErrorActionPreference = "Stop"

# 1. 在当前 pwsh 会话构建，以保留脚本末尾 bun 命令的真实退出码
& "packages\opencode\script\build-win.ps1"
# 指定适配号时将上一行替换为：& "packages\opencode\script\build-win.ps1" -WinVersion 3
if ($LASTEXITCODE -ne 0) { throw "Windows build failed with exit code $LASTEXITCODE" }

# 2. 构建成功后自动部署，文件名使用产物的实际版本号
$source = (Resolve-Path -LiteralPath "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe").Path
$versionOutput = & $source --version
if ($LASTEXITCODE -ne 0) { throw "Reading built opencode version failed with exit code $LASTEXITCODE" }
$version = $versionOutput.Trim()
if ($version -notmatch '^\d+\.\d+\.\d+\.w\d+$') { throw "Unexpected opencode version: $version" }

$installDirectory = "D:\Program\opencode"
if (-not (Test-Path -LiteralPath $installDirectory -PathType Container)) { throw "Install directory does not exist: $installDirectory" }
$target = Join-Path $installDirectory "opencode.exe.$version"
Copy-Item -LiteralPath $source -Destination $target -Force
if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Deployment target was not created: $target" }
if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $target).Hash) { throw "Deployed file hash does not match the build artifact" }
Write-Output "[deploy-win] deployed=$target"
```

typecheck 从 `packages/core` 或 `packages/opencode` 目录运行：`bun run typecheck`，不要从仓库根目录运行。

## 已知 Windows 问题清单

### 已修复

| # | 问题 | 修复位置 | 提交 |
|---|------|----------|------|
| 1 | 进程 spawn/close 事件在 Bun+Windows 下偶发不触发，导致 shell tool 无限挂起（超时竞争根本不会启动） | `packages/core/src/cross-spawn-spawner.ts` | `ddcad28203` |
| 2 | archive 解压用 powershell 5.1 且路径拼入单引号字符串（注入/断裂风险） | `packages/opencode/src/util/archive.ts` | `7d936fd5f3` |
| 3 | V2 Core bash tool 缺少 PowerShell 调用处理 | `packages/core/src/tool/bash.ts` | `7d936fd5f3` |
| 4 | `util/process.ts` spawn abort 不走 `taskkill /T /F`，进程树泄漏 | `packages/opencode/src/util/process.ts` | `7d936fd5f3` |
| 5 | `/dev/null` 硬编码（git diff --no-index） | `packages/core/src/git.ts`、`packages/opencode/src/git/index.ts` | `7d936fd5f3` |
| 6 | MCP 后代进程清理禁用（`pgrep` 不可用） | `packages/opencode/src/mcp/index.ts`（Get-CimInstance 枚举） | `7d936fd5f3` |
| 7 | LSP 安装 rm/rename 无 Windows 重试（EBUSY/EPERM） | `packages/opencode/src/util/filesystem.ts`（withRetry）、`lsp/server.ts`、`worktree/index.ts` | `7d936fd5f3` |
| 8 | chmod 0o600 等属主独占权限在 Windows 不生效 | `packages/core/src/util/file-mode.ts`（icacls ACL 加固） | `7d936fd5f3` |
| 9 | SIGUSR2 信号不可用（主题/配置热重载静默失效） | footer.ts / tui.ts / theme.tsx（win32 一次性日志） | `7d936fd5f3` |
| 10 | SIGHUP 不可用，关闭控制台渲染器不清理 | `packages/tui/src/terminal-win32.ts`（SetConsoleCtrlHandler FFI）+ exit 兜底 | `7d936fd5f3` |
| 11 | clipboard 调用 powershell 闪现控制台窗口 | `packages/tui/src/clipboard.ts`（windowsHide） | `7d936fd5f3` |
| 12 | 硬编码 `/tmp` 路径 | debug-workspace-plugin.ts、example-workspace.ts（os.tmpdir） | `7d936fd5f3` |
| 13 | clangd symlink 需管理员/开发者模式 | `packages/opencode/src/lsp/server.ts`（win32 copyFile） | `7d936fd5f3` |
| 14 | uninstall 在 win32 无意义探测 bash rc | `packages/opencode/src/cli/cmd/uninstall.ts`（SHELL 未设置提前返回） | `7d936fd5f3` |
| 15 | ripgrep zip 解压用 powershell 5.1，继承 pwsh7 的 PSModulePath 后 5.1 优先加载不兼容的 PS7 版 Microsoft.PowerShell.Archive，`Expand-Archive` 报 CouldNotAutoloadMatchingModule，导致 rg.exe 装不上、skill 加载/grep/glob 全部失败 | `packages/core/src/ripgrep/binary.ts`（zip 解压优先 tar.exe；兜底 pwsh→5.1 且剥离 PSModulePath、强制 UTF-8 输出；zip 复用+解压失败删除重下）、`packages/opencode/src/util/archive.ts`（同款 tar.exe 优先）、`packages/opencode/src/tool/skill.ts`（ripgrep 失败时文件列表降级为空，不阻断 skill 加载） | 1.18.11.w4 |

修复细节见 `windows适配文档/版本说明/`（w2、w3）。

### 待修复（按影响排序）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | `cross-spawn-spawner.ts` spawn 阶段超时/取消的 finalizer 用 `proc.kill("SIGTERM")` 不走 `killGroup` | `packages/core/src/cross-spawn-spawner.ts:283,320` | spawn 阶段中止时进程树可能未完整清理（边缘场景，进程树通常尚未形成） |

### 评估后不修

| # | 问题 | 原因 |
|---|------|------|
| 1 | XDG 路径在 Windows 非惯用（`~/.local/share`） | 功能正常；迁移到 %LOCALAPPDATA% 需数据迁移，风险大于收益 |
| 2 | PTY 设置 LC_ALL=C.UTF-8 | 有意适配（ConPTY 下对 Unix 移植工具有益） |
| 3 | desktop logging XDG_DATA_HOME 回退 | 回退路径恰为 Windows 实际日志位置 |

### 原版已有的 win32 适配（无需重复处理）

- Shell 发现与启动（`core/src/shell.ts`：pwsh/powershell/Git Bash/cmd.exe）
- cross-spawn 进程启动（`overlapped` stdio、`windowsHide`、`detached: false`、`taskkill /T /F`）
- PTY（`useConptyDll: true`、UTF-8 环境变量）
- 文件路径规范化（`FSUtil.normalizePath`、`windowsPath`、驱动器号处理）
- ripgrep 二进制下载（`.exe`；解压已改为 tar.exe 优先，见已修复 #15）
- LSP 服务器安装（`.exe`/`.cmd` 扩展、平台特定下载 URL）
- 剪贴板（PowerShell `Set-Clipboard`）
- TUI Ctrl+C 守卫（`kernel32.dll` FFI）
- `fff` 和 copy-on-select 在 win32 下默认禁用
- terminal suspend 在 win32 下禁用

## 改造流程

0. **同步上游**（修改代码前）
   - 先将官方 dev 分支更新到最新，并合并到 win-adapt 分支，确保改动基于最新上游代码
   - 按 `merge-upstream` skill 执行（含前置检查、差异评估、安全审查、冲突处理、typecheck 验证）

1. **定位问题**
   - 复现：明确触发条件、频率、症状
   - 根因分析：追踪代码路径，区分"超时前卡住"还是"超时后卡住"
   - 关键判断：挂起点在 `Effect.raceAll` 之前（spawn 阶段）还是之后（等待/kill 阶段）

2. **评估方案**
   - 能否用 win32 分支解决？是否需要新文件？
   - 是否影响非 win32 行为？
   - 合并冲突风险评估

3. **实施**
   - 遵循设计原则
   - 常量用 `WIN32_` 前缀
   - 不加注释（除非行为非常反直觉）

4. **验证**
   - `bun run typecheck`（packages/core 和 packages/opencode）
   - `build-win.ps1` 构建 + smoke test
   - 构建成功后按“构建与部署”流程自动部署版本化文件并校验文件哈希
   - 相关测试（注意已有 Windows 环境失败，见下方）
   - 手动测试实际场景

5. **提交**
   - conventional commit：`fix(core): xxx` 或 `fix(opencode): xxx`
   - commit message 说明根因和修复策略

6. **更新本 skill**
   - 将修复项从"待修复"移到"已修复"
   - 补充修复细节

## 测试注意事项

- **不从仓库根目录跑测试**（有 `do-not-run-tests-from-root` 守卫）
- `packages/core/test/effect/cross-spawn-spawner.test.ts`：在 Windows/Bun 下有 **已有失败**（测试用 `node` 命令但 Bun 环境 node 不在 PATH），与适配改动无关
- `packages/core/test/shell.test.ts`：Git Bash 路径测试在 pwsh 环境下有 **已有失败**
- 验证改动时对比 stash 前后的测试结果，确认失败是已有的而非新引入的

## 调试技巧

- **进程挂起定位**：区分"spawn 阶段挂起"（`Effect.callback` 未 resume，超时竞争未启动）和"等待阶段挂起"（`close` 事件不触发，`Deferred.await` 阻塞）
- **Bun + Windows 特有问题**：Bun 的 `child_process` 兼容层在 Windows 上与 Node.js 有差异，特别是 `overlapped` stdio 和 `spawn`/`close` 事件
- **管道句柄继承**：Windows 上子进程继承 `overlapped` 管道句柄，孙进程也继承，导致 `close` 事件（等待所有句柄关闭）不触发
- **信号无效**：Windows 不支持 POSIX 信号，`SIGTERM`/`SIGKILL` 被 Node.js 转译为 `TerminateProcess`，只杀直接子进程不杀进程树；必须用 `taskkill /pid <pid> /T /F`
