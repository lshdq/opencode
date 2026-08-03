# opencode 在 Windows 平台相比 Linux 的不足与限制 — 代码分析报告

## Context

用户希望了解 opencode 在 Windows 平台使用时，相比 Linux 存在哪些功能不足或限制，作为后续决策（是否修复 / 是否在 Windows 原生使用 vs WSL）的依据。本报告通过扫描 `D:\works\opencode` 全仓源码、测试、CI、文档得出，所有结论附 `文件路径:行号` 证据。

## 前提：技术栈校正

opencode **不是 Go 项目**，而是 **TypeScript / Bun 单体仓库**（`package.json` + `bun.lock`，`packages/*` 下全为 `.ts`，零 `.go` 文件）。原假设的 Go API 不存在，等价映射：

| Go 概念 | 实际 TS/Bun 等价物 |
|---|---|
| `runtime.GOOS` | `process.platform` |
| `//go:build` build tags | 无；运行时分支 + 平台专属文件（`terminal-win32.ts`、`desktop/.../wsl/*`） |
| `syscall`/`os.Signal` | `node:child_process`、`process.kill`、`bun:ffi`(kernel32) |
| `_windows.go`/`_linux.go` | `terminal-win32.ts`、`wsl/*.ts`（仅 Windows 专属模块，无 Linux 专属文件） |

**总判断**：Unix 是"默认且完整"路径，Windows 是"特例 + 降级 + 替代 + 跳过测试 + 官方推荐绕道 WSL"。差距集中在**进程/信号管理**、**MCP 子进程**、**文件权限/符号链接**三块。

---

## 一、进程管理与信号（差距最大）

1. **进程终止无优雅升级，直接强杀**：Windows 走 `taskkill /F /T` 一次性终止整树，没有 SIGTERM→SIGKILL 的优雅窗口，子进程拿不到清理机会；Linux 用 `process.kill(-pid, "SIGTERM")` 进程组信号，超时再 SIGKILL。
   - `packages/core/src/shell.ts:35-44`、`packages/core/src/cross-spawn-spawner.ts:297-303`、`packages/opencode/src/util/process.ts:152-162`

2. **不支持进程组负 PID 杀除**：负 PID（POSIX 进程组）Windows 无等价物，需 fork 一个 `taskkill` 子进程来终止；对 detached 的孙进程（如 npx 拉起的 node）常漏杀。
   - `packages/core/src/shell.ts:48,51`、`packages/core/src/cross-spawn-spawner.ts:308`

3. **`detached` 默认禁用**：Windows 默认 `detached:false`，无法创建独立进程组/会话。
   - `packages/core/src/cross-spawn-spawner.ts:378`、`packages/opencode/src/tool/bash.ts:158`、`packages/opencode/src/tool/shell.ts:299,308`

4. **SIGHUP/SIGUSR2/SIGTSTP/SIGCONT 在原生 Windows 不可投递**，导致以下功能**静默失效且无 fallback**：
   - 配置热重载（SIGUSR2）：`packages/opencode/src/cli/cmd/tui.ts:200`
   - 主题刷新（SIGUSR2）：`packages/opencode/src/cli/cmd/run/footer.ts:298`、`packages/tui/src/context/theme.tsx:47`
   - 终端挂起（SIGTSTP/SIGCONT）：`packages/tui/src/app.tsx:851-860`，且配置层直接 `terminalSuspend: process.platform !== "win32"`（`packages/opencode/src/config/tui.ts:215`）
   - SIGHUP 销毁渲染器：`packages/tui/src/app.tsx:225-229`
   - bin 仍一视同仁转发 SIGHUP：`packages/opencode/bin/opencode:8`、`packages/cli/bin/lildax.cjs:8`

5. **SIGTERM/SIGKILL 升级语义丢失**：Windows 上两者都被 Node 映射为 `TerminateProcess`（强杀），"先礼后兵"两阶段退化为直接强杀。
   - `packages/opencode/src/util/process.ts:79-83`、`packages/core/src/cross-spawn-spawner.ts:337-343`

---

## 二、MCP 子进程（明确功能缺失）

1. **MCP 启动无 shell 包装，`npx`/`uvx`/`python` 在原生 Windows ENOENT**：`StdioClientTransport` 裸用 Node 原生 `child_process.spawn`（**不是 cross-spawn**），Node spawn 在 Windows 不自动补 `.cmd`/`.bat`，用户需手写 `npx.cmd` 或包 `cmd /c`；代码无任何平台 fallback。
   - `packages/opencode/src/mcp/index.ts:336-349`（对比 LSP 走 cross-spawn，见五-2）

2. **MCP 后代进程清理在 Windows 被跳过**：`descendants()` 在 Windows 直接 `return []`，孙进程成孤儿（典型：npx 父进程被杀但实际 node 子进程留存）。
   - `packages/opencode/src/mcp/index.ts:410-432`，`:533-541` 用其结果逐个 SIGTERM

3. **env 合并未做大小写去重**：Windows 环境变量键大小写不敏感，`...process.env, ...mcp.environment` 字面量展开可能产生 `Path`/`PATH` 冲突。
   - `packages/opencode/src/mcp/index.ts:344-348`

---

## 三、TUI / 终端

1. **Ctrl+C 是 `CTRL_C_EVENT`，需 kernel32 FFI 轮询清除控制台全局标志**：Windows 专属 `terminal-win32.ts` 用 `bun:ffi` 调 `GetStdHandle/SetConsoleMode` 清除 `ENABLE_PROCESSED_INPUT`，并 100ms 轮询反复清除（因该标志是 console 全局、非进程级，会被其它运行时重设）；Unix 无此债。
   - `packages/tui/src/terminal-win32.ts:60-113`、`packages/opencode/src/cli/cmd/tui.ts:16,174`

2. **终端挂起（suspend）在 Windows 禁用**：依赖 POSIX SIGTSTP/SIGCONT，Windows 无。
   - `packages/tui/src/app.tsx:851-860`；文档 `packages/web/src/content/docs/keybinds.mdx:185` 明确 "`terminal_suspend` forced to `none`"

3. **无 Windows Terminal / conhost 运行时检测**：代码仅读 `TERM_PROGRAM`（识别 vscode/zed），不区分旧 conhost 与 Windows Terminal；ANSI 24-bit、alt screen、鼠标、bracketed paste 全靠 opentui 渲染器，旧 conhost 下体验退化无降级提示。
   - grep `wt\.exe|conhost|WT_SESSION` 在 src 零命中

4. **Windows Terminal 剪贴板/键位怪癖需用户手动处理**：旧版 WT 把 image-only 剪贴板呈现为空 bracketed paste（`packages/tui/src/component/prompt/index.tsx:1403`）；Shift+Enter 需用户手动改 WT `settings.json`（`keybinds.mdx:266-299`），Linux/macOS 终端通常无需此步。

---

## 四、文件权限与符号链接（安全相关）

1. **chmod 在 Windows 是 no-op，敏感文件 `0o600`/`0o700` 保护失效**：NTFS 靠 ACL 非 mode 位，以下敏感文件在 Windows **未获文件级保护**，任何同用户进程可读：
   - 认证数据 `0o600`：`packages/opencode/src/auth/index.ts:79,88`
   - MCP OAuth 凭据 `0o600`：`packages/opencode/src/mcp/auth.ts:80`
   - daemon 密码文件 `0o600`：`packages/cli/src/services/daemon.ts:53,171`
   - 锁目录 `0o700`：`packages/core/src/util/flock.ts:154,166,193`
   - 测试明确记录："Windows: chmod(0o000) is a no-op"（`packages/opencode/test/util/filesystem.test.ts:620`）

2. **symlink 静默失败**：Windows 创建符号链接需开发者模式或管理员（SeCreateSymbolicLinkPrivilege）；生产路径用 `.catch(()=>{})` 吞错，clangd 别名等静默失败无提示。测试里用 junction 绕过（`process.platform === "win32" ? "junction" : "dir"`），但生产路径未统一改用 junction。
   - `packages/opencode/src/lsp/server.ts:1059`；测试 `plugin-loader-entrypoint.test.ts:164` 等

3. **git 强制 `core.symlinks=true`**：全平台设置，Windows 无开发者模式/管理员时检出含 symlink 的仓库会失败或退化为文本文件。
   - `packages/opencode/src/git/index.ts:6-18`、`packages/core/src/git.ts:383-385`

4. **`process.getuid` 不存在**：root 检测等用可选链兜底。
   - `packages/opencode/test/util/filesystem.test.ts:623`

---

## 五、Shell、路径与配置目录

1. **配置目录非 Windows 标准**：用 `xdg-basedir`，Windows 下落到 `C:\Users\<u>\.config\opencode`（而非 `%APPDATA%\opencode`），与 Windows 惯例相悖。
   - `packages/core/src/global.ts:11-29`（可用 `OPENCODE_CONFIG_DIR` 覆盖）

2. **Shell 探测式选择（这点做得好）**：未硬编码 bash，按 `pwsh → powershell → git-bash → cmd.exe` 探测；但 Windows 无 `SHELL` 环境变量，无 `/etc/shells`，git-bash 路径推断失败时只剩 cmd.exe。
   - `packages/core/src/shell.ts:98-137`

3. **cmd.exe 无语法树**：命令解析用 tree-sitter 的 bash + powershell 两种语法，**无 cmd 语法树**，cmd 管道/重定向仅靠白名单粗略识别。
   - `packages/opencode/src/tool/shell.ts:311-336`

4. **解压依赖 PowerShell**：`Expand-Archive`，无原生 unzip；系统缺失/损坏 PowerShell 则解压失败（ripgrep 下载也走此路径）。
   - `packages/opencode/src/util/archive.ts:5-11`、`packages/core/src/ripgrep/binary.ts:59-88`

5. **worktree 在 Windows 的多重脆弱性**：删除重试 50 次（vs Linux 5 次，因文件锁/杀软占用）、路径强制小写（NTFS 大小写不敏感）、start 命令走 `cmd /c`（vs `bash -lc`）。
   - `packages/opencode/src/worktree/index.ts:301,374,465`

6. **路径归一化不对称**：`normalizePath` 只在 Windows 调 `realpathSync.native`，Linux 直接返回原值，可能影响缓存 key 与符号链接可比性。
   - `packages/core/src/fs-util.ts:211-247`（含 `/c/`、`/cygdrive/`、`/mnt/` 转换，处理 git-bash/WSL 路径泄漏）

7. **全局 worktree 硬编码 `/`**：Windows 下解析为当前盘根（如 `C:\`），Unix-ism。
   - `packages/opencode/src/project/project.ts:217`

8. **桌面端 `apps.ts` 读 `process.env.HOME`**（Windows 通常为空，应 `os.homedir()`），且 `checkAppExists` 在 Windows 直接 `return true`（不做实际检查）。
   - `packages/desktop/src/main/apps.ts:13-17,27`

9. **LSP 走 cross-spawn（比 MCP 好）**：cross-spawn 自动解析 `.cmd`/`.bat`，各 LSP server 显式拼 `.exe`/`.cmd`/`.bat`；但关闭走 `taskkill /T /F`，跳过 LSP 协议的 `shutdown`→`exit` 优雅关闭。
   - `packages/opencode/src/lsp/launch.ts:11`、`packages/opencode/src/lsp/lsp.ts:174,238,246`、`packages/opencode/src/lsp/server.ts:206,237,382`

10. **权限 glob 在 Windows 需额外归一化**；`$HOME` 展开在原生 Windows 可能失效（Windows 用 `%USERPROFILE%`）。
    - `packages/opencode/src/tool/shell.ts:267-269`、`packages/opencode/src/permission/index.ts:178-184`

---

## 六、桌面端 WSL 依赖（架构级）

1. **桌面端 Windows 不加载登录 shell 环境**：`preferAppEnv` 在 Windows 直接 `shell = null`，跳过 `loadShellEnv`，不继承用户登录 shell 环境变量。
   - `packages/desktop/src/main/server.ts:44-53`

2. **桌面端 Windows 主路径走 WSL sidecar，并禁用文件监视器**：因跨 9p 文件系统监视不可靠，sidecar 显式 `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`；`wsl.exe` 易因 LXSS 服务死锁而卡死（默认 20s 超时）。
   - `packages/desktop/src/main/wsl/sidecar.ts:16-90`、`packages/desktop/src/main/wsl/runtime.ts:22-30`

3. **桌面端依赖 WebView2 Runtime**（Linux/macOS 无此依赖）。
   - `packages/web/src/content/docs/troubleshooting.mdx:147-149`

4. **WSL 内硬编码 bash**：sidecar 与安装脚本 `bash -se` / `bash -lc`（属 WSL=Linux 环境，合理，但意味着 Windows 桌面主路径依赖 WSL 里有 bash）。
   - `packages/desktop/src/main/wsl/sidecar.ts:39`、`runtime.ts:201,266`

---

## 七、自更新与安装

1. **正在运行的 `opencode.exe` 被文件锁占用，自更新失败**：`postinstall` 用 `unlinkSync`/`copyFileSync`，未用 Windows 推荐的"先重命名旧文件再写入"原子替换技巧；TUI 启动 1 秒后由 worker 触发升级，旧进程仍在则撞锁。
   - `packages/opencode/script/postinstall.mjs:146-156`、`packages/opencode/src/cli/cmd/tui.ts:246-248`

2. **`curl` 自更新法需 bash**：原生 cmd/PowerShell 无 bash/sh，回退失败。
   - `packages/opencode/src/installation/index.ts:138-164`

3. **choco 升级需管理员权限**（brew/scoop/npm 无此问题）。
   - `packages/opencode/src/cli/cmd/upgrade.ts:61-64`

4. **无 winget 支持**：安装方式枚举仅 `scoop`/`choco`。
   - `packages/opencode/src/installation/index.ts:17`

5. **install 脚本是 `#!/usr/bin/env bash`**：原生 cmd/PowerShell 用户需先有 Git Bash/WSL 才能运行。
   - 根目录 `install` shebang

---

## 八、CI 与测试覆盖（间接暴露薄弱面）

1. **test.yml 是唯一跑 Windows 的 CI，但有降级**：Windows 强制 `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`；"Check generated client" 与 "Run HttpApi exerciser gates" 仅 Linux 跑；Playwright 系统依赖仅 Linux 安装。
   - `.github/workflows/test.yml:70,73,78,127`

2. **其余 ~20 个 workflow 全部仅 Ubuntu**：typecheck、review、stats、storybook、docs、generate 等从不在 Windows 验证。

3. **大量测试在 Windows 被跳过**，Windows 代码路径覆盖严重不足：
   - PTY 会话：`packages/core/test/pty/pty-session.test.ts:27,224`、`packages/opencode/test/server/httpapi-pty.test.ts:15`、`httpapi-v2-pty.test.ts:18`、`httpapi-listen.test.ts:19`
   - 快照：`packages/opencode/test/snapshot/snapshot.test.ts:23`
   - 符号链接监视：`packages/core/test/filesystem/watcher.test.ts:236`
   - worktree：`worktree-endpoint-repro.test.ts:31`、`project/worktree.test.ts:19`、`httpapi-experimental.test.ts:20`
   - 文件锁：`packages/core/test/util/flock.test.ts:96,404`、`effect-flock.test.ts:74,313`
   - which / 权限 / EACCES / ELOOP：`which.test.ts:68,79,91`、`filesystem.test.ts:620,622,640`
   - 滚动回看、跨实例、prompt(unix)：`scrollback.surface.test.ts:537`、`control-plane/workspace.test.ts:934`、`session/prompt.test.ts:256`

---

## 九、官方文档表态

- **官方明确推荐 WSL 而非原生 Windows**："While OpenCode can run directly on Windows, we recommend using WSL for the best experience. WSL provides better file system performance, **full terminal support**, and compatibility with development tools."
  - `packages/web/src/content/docs/windows-wsl.mdx:8,11`（15+ 语言翻译版本，全局立场）
- troubleshooting 把 Windows 性能/文件/终端问题导向 WSL：`packages/web/src/content/docs/troubleshooting.mdx:153-155`

---

## 十、做得好的方面（公允）

- Shell 探测式选择（pwsh/powershell/git-bash/cmd）、`which` + `PATHEXT`、`cross-spawn` 自动解析 `.cmd/.bat`、stdio pipe→`overlapped` 适配
- LSP server 二进制按平台显式拼 `.exe`/`.cmd`/`.bat`，ripgrep 自带 `*-pc-windows-msvc` 二进制
- edit/apply_patch 工具检测并保留 CRLF，git 强制 `core.autocrlf=false`、`core.longpaths=true`（绕过 260 字符限制）
- IPC 走 HTTP over TCP（`127.0.0.1:port`），有意规避 unix socket / 命名管道的可移植性问题
- 多数路径用 `os.homedir()`（正确取 USERPROFILE）、Windows 环境变量大小写不敏感查找、`windowsHide` 避免弹窗

---

## 严重度排序（建议关注顺序）

| 严重度 | 限制 | 证据节 |
|---|---|---|
| 高 | MCP 子进程启动无 shell 包装，`npx`/`uvx` 在原生 Windows ENOENT | 二-1 |
| 高 | MCP 后代进程清理在 Windows 跳过，孙进程成孤儿 | 二-2 |
| 高 | 敏感文件 `0o600` 在 NTFS 无实际保护（auth/daemon 密码/MCP 凭据） | 四-1 |
| 高 | SIGHUP/SIGUSR2/SIGTSTP 等信号功能静默失效无 fallback | 一-4 |
| 中 | 进程终止无优雅升级，直接 `taskkill /F` | 一-1 |
| 中 | symlink 静默失败 + git `core.symlinks=true` | 四-2,3 |
| 中 | 自更新文件占用未用原子替换 | 七-1 |
| 中 | 配置目录非 Windows 标准（`.config` 而非 `%APPDATA%`） | 五-1 |
| 中 | 桌面端 WSL 模式禁用文件监视器、LXSS 易死锁 | 六-2 |
| 中 | cmd.exe 无语法树，命令解析粗略 | 五-3 |
| 低 | Ctrl+C 需 kernel32 FFI 守护、终端挂起禁用、路径归一化不对称、全局 worktree=`/`、无 winget | 三、五 |
| 低 | CI/测试在 Windows 大面积跳过（覆盖缺口） | 八 |

## 验证方式

本报告为只读分析，无需改动代码。如需复核任一条目：`Grep` 对应 `文件路径:行号` 附近代码即可验证。若后续要验证运行时行为，可在 Windows 原生环境复现：配置一个 `command: "npx"` 的 MCP server 观察是否 ENOENT；或运行中 `kill -USR2 <pid>` 观察主题是否刷新（Windows 不刷新即印证一-4）。
