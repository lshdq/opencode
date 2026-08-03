# opencode Windows 缺陷清单

> 基于 opencode 源码（win-adapt 分支）全面审查，2026-07-31
> 审查范围：packages/core、packages/opencode、packages/tui、packages/desktop、packages/app、packages/server

---

## 一、严重（影响核心功能）

### S1. archive.ts 使用 powershell 5.1 + 路径注入风险

- **文件**: `packages/opencode/src/util/archive.ts:9-10`
- **代码**:
  ```ts
  const cmd = `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -Path '${winZipPath}' -DestinationPath '${winDestDir}' -Force`
  await Process.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd])
  ```
- **问题**:
  1. 使用 `powershell`（5.1）而非 `pwsh`（7+）。Windows PowerShell 5.1 在中文 Windows 下默认编码为 GBK，与项目 AGENTS.md 规定的"使用 pwsh.exe"矛盾。
  2. 路径嵌入单引号字符串，若路径含单引号（`'`）会导致命令断裂或注入。
- **影响**: 所有 LSP 服务器安装（eslint、elixir、zls、lua-language-server、kotlin-lsp 等）在 Windows 下都经过此函数。中文用户名路径（如 `C:\Users\张三'李四\`）会导致安装失败。
- **修复建议**:
  - 改用 `pwsh.exe`（回退 `powershell.exe`）
  - 使用 `-LiteralPath` 参数并通过数组传参避免字符串拼接
  - 或使用 Bun 内置 zip 解压（`Bun.zip`）替代 PowerShell

### S2. V2 Core bash tool 缺少 PowerShell/cmd 调用处理

- **文件**: `packages/core/src/tool/bash.ts:69`
- **代码**:
  ```ts
  // TODO: Restore PowerShell and cmd-specific invocation/path handling on Windows.
  ```
- **问题**: V2 bash tool 仅有最基础的 Windows 支持（`defaultShell()` 返回 `cmd.exe`、`detached: false`），缺少：
  - PowerShell 专用参数（`-NoLogo -NoProfile -NonInteractive -Command`）
  - cmd 专用参数（`/c`）
  - Git Bash 发现与路径解析
  - MSYS/Cygwin 路径转换（`/c/...` → `C:/`）
  - PowerShell 环境变量大小写不敏感处理
  - `$ErrorActionPreference` 包装
- **对比**: 旧版 `packages/opencode/src/tool/shell.ts:294-309` 有完整的 PowerShell/cmd 分支
- **影响**: V2 会话中 shell 命令在 Windows 下行为异常，PowerShell 命令可能无法正确执行
- **修复建议**: 参考旧版 `shell.ts` 的 `cmd()` 函数，在 V2 bash tool 中添加 PowerShell/cmd 调用分支

---

## 二、高（影响重要功能）

### H1. MCP 进程后代清理在 Windows 下完全禁用

- **文件**: `packages/opencode/src/mcp/index.ts:418-440`
- **代码**:
  ```ts
  const descendants = Effect.fnUntraced(function* (pid: number) {
    if (process.platform === "win32") return [] as number[]  // 直接返回空
    // ... 使用 pgrep -P 递归查找子进程
  })
  ```
- **问题**: `pgrep` 在 Windows 不存在，直接返回空数组。MCP 服务器（stdio 模式）的子进程在关闭时不会被清理。
- **影响**: MCP 服务器派生的孙进程成为孤儿进程，长期运行后进程泄漏。
- **修复建议**: 使用 Windows 等效命令枚举后代进程：
  ```
  wmic process where (ParentProcessId=<pid>) get ProcessId /format:csv
  ```
  或 `tasklist /fi "PID eq <pid>"` + 递归，然后 `taskkill /pid <dpid> /T /F`

### H2. /dev/null 硬编码作为 git diff 参数

- **文件**:
  - `packages/core/src/git.ts:767`
  - `packages/opencode/src/git/index.ts:293, 302`
- **代码**:
  ```ts
  ["diff", "--binary", "--no-index", "--", "/dev/null", file]
  ["diff", "--no-index", "--patch", ..., "--", "/dev/null", file]
  ["diff", "--no-index", "--numstat", "--", "/dev/null", file]
  ```
- **问题**: `/dev/null` 是 POSIX 设备文件。Git for Windows（MSYS2 内核）内部能识别 `/dev/null`，但若使用非 MSYS 的 git 二进制（如 MinGit），路径会被 Windows 文件系统解析而失败。
- **影响**: untracked 文件的 diff 生成可能失败，影响 snapshot/patch 工作流。
- **修复建议**:
  ```ts
  const devNull = process.platform === "win32" ? "NUL" : "/dev/null"
  ```
  注意：`NUL` 在 Git for Windows 下也能工作（MSYS2 同时识别两者）。

### H3. util/process.ts abort 不杀进程树

- **文件**: `packages/opencode/src/util/process.ts:74-84`
- **代码**:
  ```ts
  const abort = () => {
    proc.kill(opts.kill ?? "SIGTERM")           // 只杀直接子进程
    timer = setTimeout(() => proc.kill("SIGKILL"), ms)  // Windows 下与上一行等效
  }
  ```
- **问题**:
  1. `proc.kill()` 在 Windows 下调用 `TerminateProcess`，只杀直接子进程，不杀进程树。
  2. SIGTERM→SIGKILL 升级在 Windows 下无意义（两者等效）。
  3. 同文件的 `stop()` 函数（:149-163）已正确使用 `taskkill /T /F`，但 `abort()` 未使用。
- **影响**: 通过 `Process.spawn()` 启动的命令若派生了子进程，abort 时子进程泄漏。
- **修复建议**: `abort()` 中在 win32 下调用 `stop(proc)` 或直接 `taskkill /pid <pid> /T /F`

---

## 三、中（功能降级或静默失败）

### M1. SIGUSR2 信号在 Windows 下无效（3 处）

- **文件**:
  - `packages/opencode/src/cli/cmd/run/footer.ts:298` — 主题热刷新
  - `packages/opencode/src/cli/cmd/tui.ts:219` — TUI 配置重载
  - `packages/tui/src/context/theme.tsx:47` — 主题刷新订阅
- **问题**: `process.on("SIGUSR2", handler)` 在 Windows 下注册不报错，但 handler 永远不会被触发。SIGUSR2 是 POSIX 专有信号。
- **影响**: 通过信号触发的主题热刷新、配置重载功能在 Windows 下静默失效。不会崩溃，但功能丢失。
- **修复建议**: 在 win32 下提供替代机制（如文件监听、命名管道、HTTP 端点），或至少记录日志说明功能不可用。

### M2. SIGHUP 信号在 Windows 下无效

- **文件**: `packages/tui/src/app.tsx:233-234`
- **代码**:
  ```ts
  process.on("SIGHUP", onSighup)  // 终端挂断时销毁渲染器
  ```
- **问题**: SIGHUP 在 Windows 下不存在。终端窗口关闭时（WM_CLOSE / CTRL_CLOSE_EVENT）不会触发此 handler。
- **影响**: TUI 渲染器在控制台窗口关闭时可能无法正确清理。
- **修复建议**: 在 win32 下监听 `process.on("exit")` 或使用 `SetConsoleCtrlHandler`（通过 FFI）处理 CTRL_CLOSE_EVENT。

### M3. LSP 服务器安装文件操作无 Windows 重试

- **文件**: `packages/opencode/src/lsp/server.ts`（12+ 处 `fs.rm`、1 处 `fs.rename`）
- **关键位置**:
  - `:202` — `fs.rm(finalPath)` 后紧接 `fs.rename(extractedPath, finalPath)`
  - `:1466` — `fs.rm(installDir)` 后重新解压
- **问题**: Windows 下杀毒软件、索引服务可能短暂锁定新下载/解压的文件。`{ force: true }` 只抑制 ENOENT，不处理 EBUSY/EPERM。
- **对比**: `packages/opencode/src/worktree/index.ts:372-381` 已有 win32 下 50 次重试（每次 100ms）的正确实现。
- **影响**: LSP 服务器安装在 Windows 下偶发失败（EBUSY/EPERM）。
- **修复建议**: 提取 worktree 中的重试逻辑为通用工具函数，在 LSP 安装路径中复用。

### M4. chmod 权限语义在 Windows 下静默退化

- **文件**:
  - `packages/core/src/fs-util.ts:113, 144` — `writeJson` / `writeWithDirs` 中的 `fs.chmod(path, mode)`
  - `packages/opencode/src/util/filesystem.ts:101` — `writeStream` 中的 `chmod(p, mode)`
- **问题**: Windows 下 `chmod` 只能切换只读位（`S_IWUSR`），完整的 Unix 权限模式被忽略。若调用方传入 `0o600`（意图保护敏感文件），该语义在 Windows 下不生效。
- **影响**: 不会崩溃，但安全相关的权限设置（如密钥文件 0o600）在 Windows 下无效。
- **修复建议**: 对安全敏感的写入，在 win32 下使用 `icacls` 设置 ACL，或至少记录警告。

### M5. clipboard.ts 缺少 windowsHide

- **文件**: `packages/tui/src/clipboard.ts:11`
- **代码**:
  ```ts
  const child = spawn(command, args, { stdio: [...] })  // 无 windowsHide
  ```
- **问题**: 在 win32 下调用 `powershell.exe` 进行剪贴板操作时（:56, :87），未设置 `windowsHide: true`，可能闪现控制台窗口。
- **影响**: 用户体验问题——剪贴板读写时短暂闪现黑色控制台窗口。
- **修复建议**: 添加 `windowsHide: true`（或 `process.platform === "win32"` 条件）。

### M6. 硬编码 /tmp 路径

- **文件**:
  - `packages/opencode/src/control-plane/dev/debug-workspace-plugin.ts:6` — `"/tmp/opencode-workspace-dev-data.json"`
  - `packages/plugin/src/example-workspace.ts:13` — `` `/tmp/folder/folder-${rand}` ``
- **问题**: Windows 下 `/tmp` 不存在（会被解析为当前驱动器根目录下的 `\tmp`）。
- **影响**: 开发调试插件和示例插件在 Windows 下无法正常工作。
- **修复建议**: 使用 `os.tmpdir()` + `path.join()`。

---

## 四、低（边缘场景或无实际影响）

### L1. clangd symlink 在 Windows 下静默失败

- **文件**: `packages/opencode/src/lsp/server.ts:1059`
- **代码**: `await fs.symlink(bin, path.join(Global.Path.bin, "clangd")).catch(() => {})`
- **问题**: Windows 下 `fs.symlink` 需要管理员权限或开发者模式。`.catch(() => {})` 吞掉错误。
- **影响**: 无实际影响——clangd 通过直接路径（`.exe` 后缀）启动，symlink 只是便利别名。
- **修复建议**: 可选——在 win32 下用 `fs.copyFile` 替代 symlink。

### L2. XDG 路径在 Windows 下非惯用

- **文件**: `packages/core/src/global.ts:11-14`（使用 `xdg-basedir` 库）
- **问题**: Windows 下 XDG 变量未设置，回退到 `C:\Users\<user>\.local\share\opencode` 等 Unix 风格路径。Windows 惯用路径是 `%APPDATA%` / `%LOCALAPPDATA%`。
- **影响**: 功能正常，但数据存储位置不符合 Windows 惯例。用户可能困惑于 `.local` 目录。
- **修复建议**: 可选——在 win32 下使用 `%LOCALAPPDATA%\opencode` 或 `%APPDATA%\opencode`。需注意数据迁移。

### L3. uninstall 在 Windows 下查找 bash 配置文件

- **文件**: `packages/opencode/src/cli/cmd/uninstall.ts:236-256`
- **问题**: `process.env.SHELL` 在 Windows 下未设置，回退到 `"bash"`，然后查找 `~/.bashrc` 等文件。这些文件在典型 Windows 系统中不存在。
- **影响**: 无实际影响——找不到文件，函数返回 null，不执行任何操作。

### L4. PTY 设置 LC_ALL=C.UTF-8 在 Windows 下无效

- **文件**: `packages/core/src/pty.ts:176-180`
- **问题**: `LC_ALL`、`LC_CTYPE`、`LANG` 是 Unix locale 环境变量，对 Windows 原生控制台（使用代码页 `chcp`）无效。
- **影响**: 对 ConPTY 下运行的 Unix 移植工具可能有帮助，但不是完整的编码解决方案。

### L5. desktop logging 中 XDG_DATA_HOME 回退路径

- **文件**: `packages/desktop/src/main/logging.ts:153`
- **代码**: `const xdgData = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")`
- **影响**: 无实际影响——同文件还检查 `app.getPath("userData")`，日志总能找到。

---

## 五、已有良好适配（无需处理，供参考）

以下领域已有完善的 Windows 处理，列出供后续改动时参考，避免破坏：

| 领域 | 关键文件 | 适配内容 |
|------|----------|----------|
| 进程启动 | `core/src/cross-spawn-spawner.ts` | overlapped 管道、spawn 超时(30s)、exit 宽限(2s)、taskkill 组杀、kill 等待超时(5s)、windowsHide、detached:false |
| 进程树杀死 | `core/src/shell.ts:31-60` | win32 用 `taskkill /f /t`，非 win32 用负 PID 进程组杀 |
| 进程停止 | `opencode/src/util/process.ts:149-163` | `stop()` 函数 win32 用 `taskkill /T /F` |
| Shell 发现 | `core/src/shell.ts:98-106` | pwsh → powershell → Git Bash → cmd.exe 优先级 |
| Shell 参数 | `core/src/shell.ts:166-199` | cmd `/c`、PowerShell `-NoProfile -Command`、bash/zsh `-c` |
| 默认 Shell | `core/src/tool/bash.ts:49` | win32 用 `COMSPEC`/`cmd.exe` |
| 路径规范化 | `core/src/fs-util.ts:229-258` | `normalizePath`（realpathSync.native）、`windowsPath`（/C/、/cygdrive/、/mnt/ 转换） |
| 数据库路径 | `core/src/database/path.ts` | 存储用正斜杠，使用时转回反斜杠 |
| 行尾处理 | `core/src/tool/edit.ts:42-45` | 检测/保留/恢复 CRLF |
| BOM 处理 | `opencode/src/util/bom.ts`、`core/src/file-mutation.ts` | 完整的 UTF-8 BOM 检测/保留/剥离 |
| Git 配置 | `core/src/git.ts:383-385` | `core.longpaths=true`、`core.autocrlf=false`、`core.symlinks=true` |
| 文件监听 | `core/src/filesystem/watcher.ts:39` | `@parcel/watcher` 使用 `"windows"` 后端（ReadDirectoryChangesW） |
| 文件锁 | `core/src/util/flock.ts`、`effect-flock.ts` | 基于 `mkdir` 原子性 + `O_EXCL` 写入，不依赖 POSIX flock |
| PTY | `core/src/pty/pty.node.ts:9` | `useConptyDll: true` |
| 交互 stdin | `opencode/src/cli/cmd/run/runtime.stdin.ts:24` | win32 用 `CONIN$` 替代 `/dev/tty` |
| 终端挂起 | `opencode/src/cli/cmd/run/runtime.boot.ts:71` | win32 下禁用（无 SIGTSTP） |
| Ctrl+C 守卫 | `tui/src/terminal-win32.ts` | kernel32.dll FFI 禁用 ENABLE_PROCESSED_INPUT |
| 剪贴板 | `tui/src/clipboard.ts:53,85` | win32 用 PowerShell Set-Clipboard |
| 编辑器启动 | `tui/src/editor.ts:39` | win32 用 `shell: true`（解析 .cmd） |
| 二进制解析 | `core/src/ripgrep/binary.ts`、`opencode/src/lsp/server.ts` | .exe/.cmd 扩展名、Python Scripts/ 目录 |
| 通配符匹配 | `core/src/util/wildcard.ts:13` | win32 下大小写不敏感 |
| URL/路径转换 | 多处 | 一致使用 `pathToFileURL`/`fileURLToPath` |
| which 工具 | `core/src/util/which.ts` | 使用 `path.delimiter`（win32 为 `;`）和 PATHEXT |
| fff/copy-on-select | `core/src/flag/flag.ts:34,44` | win32 下默认禁用 |
| worktree 删除 | `opencode/src/worktree/index.ts:372` | win32 下 50 次重试（vs 5 次） |
| Kitty 键盘 | `opencode/src/cli/cmd/run/runtime.lifecycle.ts:189` | win32 下启用 Kitty 键盘事件 |
| 托管配置 | `opencode/src/config/managed.ts:25` | win32 用 `C:\ProgramData\opencode` |

---

## 六、测试相关问题

### T1. PTY 测试使用 /usr/bin/env

- **文件**:
  - `packages/core/test/pty/pty-session.test.ts:117`
  - `packages/opencode/test/server/httpapi-pty.test.ts:87,93,145,172`
  - `packages/opencode/test/server/httpapi-v2-pty.test.ts:76,108`
- **问题**: `/usr/bin/env` 在 Windows 下不存在，这些测试必然失败。
- **修复建议**: 添加 `skipIf(process.platform === "win32")` 或使用跨平台命令。

### T2. 权限测试假设 POSIX 语义

- **文件**: `packages/opencode/test/util/filesystem.test.ts:620` 等
- **问题**: `chmod(0o000)` 在 Windows 下无法触发 EACCES（NTFS 使用 ACL）。
- **现状**: 部分测试已有注释说明（如 `filesystem.test.ts:620`），但未 skip。

### T3. symlink 测试未使用 junction

- **文件**: `packages/opencode/test/util/glob.test.ts:81,92`、`test/snapshot/snapshot.test.ts:195` 等
- **问题**: 创建目录 symlink 未指定 `"junction"` 类型，Windows 下需要开发者模式。
- **正面**: `test/plugin/loader-shared.test.ts:566` 已正确使用 `process.platform === "win32" ? "junction" : "dir"`。

### T4. cross-spawn-spawner 测试在 Windows/Bun 下已有失败

- **文件**: `packages/core/test/effect/cross-spawn-spawner.test.ts`
- **问题**: 测试用 `node` 命令但 Bun 环境下 node 不在 PATH。与适配改动无关。

### T5. shell 测试在 pwsh 环境下已有失败

- **文件**: `packages/core/test/shell.test.ts`
- **问题**: Git Bash 路径测试在 pwsh 环境下失败。与适配改动无关。

---

## 七、修复优先级建议

| 优先级 | 编号 | 预估工作量 | 说明 |
|--------|------|-----------|------|
| P0 | S1 | 小 | archive.ts 改用 pwsh + 安全传参，影响所有 LSP 安装 |
| P0 | H3 | 小 | abort() 中 win32 用 taskkill，与 stop() 对齐 |
| P1 | S2 | 中 | V2 bash tool 添加 PowerShell/cmd 分支（参考旧版 shell.ts） |
| P1 | H1 | 中 | MCP descendants 用 wmic/tasklist 替代 pgrep |
| P1 | H2 | 小 | /dev/null → 平台条件（NUL） |
| P2 | M3 | 小 | 提取 worktree 重试逻辑为通用函数 |
| P2 | M5 | 极小 | clipboard.ts 加 windowsHide |
| P2 | M6 | 极小 | /tmp → os.tmpdir() |
| P3 | M1/M2 | 中 | 信号替代机制（需设计） |
| P3 | M4 | 中 | chmod → icacls（需评估必要性） |
| P3 | L1-L5 | 小 | 按需处理 |
