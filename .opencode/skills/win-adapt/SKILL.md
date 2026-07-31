---
name: win-adapt
description: opencode Windows 适配改造。触发关键词：windows适配、win-adapt、windows问题、win32修复、windows兼容、win32适配。包含：已知问题清单、已完成适配、设计原则、改造流程、构建验证、部署。
slash: true
---

# win-adapt

opencode 官方建议 Windows 用户使用 WSL，本 fork（`win-adapt` 分支）的目标是让 opencode 在原生 Windows 下可靠运行。

## 分支与版本

- 分支：`win-adapt`（基于 `upstream/dev` fork）
- 版本号：`<fork基准版本>.w<适配号>`，如 `1.18.9.w2`
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

```powershell
# 构建（适配号默认 2，可用 -WinVersion N 指定）
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "packages\opencode\script\build-win.ps1"
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "packages\opencode\script\build-win.ps1" -WinVersion 3

# typecheck（从包目录运行，不从仓库根）
bun run typecheck   # 在 packages/core 或 packages/opencode 下

# 部署：构建完成后复制到安装目录，exe 文件名追加版本号
Copy-Item "dist\opencode-windows-x64\bin\opencode.exe" "D:\Program\opencode\opencode.exe.1.18.9.w2"
```

## 已知 Windows 问题清单

### 已修复

| # | 问题 | 修复位置 | 提交 |
|---|------|----------|------|
| 1 | 进程 spawn/close 事件在 Bun+Windows 下偶发不触发，导致 shell tool 无限挂起（超时竞争根本不会启动） | `packages/core/src/cross-spawn-spawner.ts` | `ddcad28203` |

修复细节（三层防御，均 win32 守卫）：
- **spawn 超时（30s）**：`spawn` 事件未触发 → `Effect.callback` 失败返回，不再永久挂起
- **exit 宽限期（2s）**：`exit` 触发后 `close` 未到 → 强制完成 signal Deferred（管道句柄继承导致 close 不触发）
- **kill 等待超时（5s）**：`handle.kill` 和 scope finalizer 中 `Deferred.await(signal)` 加兜底超时

### 待修复（按影响排序）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 2 | V2 Core bash tool 缺少 PowerShell/cmd 处理（有明确 TODO） | `packages/core/src/tool/bash.ts:69` | V2 会话 shell 命令行为异常 |
| 3 | `util/process.ts` spawn abort 用 `SIGTERM/SIGKILL` 不走 `taskkill /T /F` | `packages/opencode/src/util/process.ts:79,83` | 子进程泄漏 |
| 4 | `/dev/null` 硬编码 | `packages/opencode/src/git/index.ts:293,302`、`project/vcs.ts:58` | untracked 文件 diff 可能失败 |
| 5 | MCP 进程清理禁用（`pgrep` 不可用，`descendants()` 返回空） | `packages/opencode/src/mcp/index.ts:420` | MCP 服务器进程泄漏 |
| 6 | symlink 需要管理员权限或开发者模式 | `packages/opencode/src/lsp/server.ts:1059`、`snapshot/index.ts` | clangd/snapshot 静默失败 |
| 7 | `cross-spawn-spawner.ts` spawn finalizer 用 `proc.kill("SIGTERM")` 不走 `killGroup` | `packages/core/src/cross-spawn-spawner.ts:288` | 进程树未完整清理 |

### 原版已有的 win32 适配（无需重复处理）

- Shell 发现与启动（`core/src/shell.ts`：pwsh/powershell/Git Bash/cmd.exe）
- cross-spawn 进程启动（`overlapped` stdio、`windowsHide`、`detached: false`、`taskkill /T /F`）
- PTY（`useConptyDll: true`、UTF-8 环境变量）
- 文件路径规范化（`FSUtil.normalizePath`、`windowsPath`、驱动器号处理）
- ripgrep 二进制下载（`.exe`、PowerShell `Expand-Archive`）
- LSP 服务器安装（`.exe`/`.cmd` 扩展、平台特定下载 URL）
- 剪贴板（PowerShell `Set-Clipboard`）
- TUI Ctrl+C 守卫（`kernel32.dll` FFI）
- `fff` 和 copy-on-select 在 win32 下默认禁用
- terminal suspend 在 win32 下禁用

## 改造流程

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
