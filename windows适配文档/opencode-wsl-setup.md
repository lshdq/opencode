# opencode WSL 运行方案（含任务完成/确认的任务栏闪烁通知）

> 状态：方案已定，暂不执行。记录于 Plan 模式，待切 build 模式落地。
> 日期：2026-07-30

## 1. 背景

opencode 在 Windows 原生下用 bash 工具启动长驻进程（如 `java -jar`）时经常"无限等待"。

根因（Windows 特有）：

- 退出信号绑定 Node 的 `close` 事件，要求所有 stdio 管道句柄关闭；孙进程继承管道写端 → `close` 不触发。
- `handle.kill()` 发完 `taskkill /T /F` 后又 `await(close)` → 杀完仍可能挂。
- Windows 强制 `detached:false` → 无 Job Object，杀树仅靠 taskkill 父进程链枚举，不可靠。
- Linux 下 `detached:true` + 进程组 + `kill(-pid)` + `cmd &` 后台重定向天然规避。

结论：改在 WSL（真 Linux）下跑 opencode，从环境层面消除该问题。

## 2. 环境现状（已盘点）

- WSL 2 已装（版本 2.7.11.0，内核 6.18，含 WSLg）；发行版 Ubuntu 26.04 LTS（默认）。
- WSL 内：git 2.53.0 已有；bun/node/npm/java/mvn 均未装。
- `/mnt/d`、`/mnt/c` 可访问。
- 现有源码：`/mnt/d/works/thirdparty/opencode`（remote 指向 anomalyco/opencode，默认分支 dev）。
- 终端：PowerShell 7（窗口宿主为 Windows Terminal 或 conhost，运行时自动适配）。

## 3. 第一部分：WSL 原生运行 opencode

决策：代码放 WSL 原生 `~/opencode`（性能/inotify 最佳）；只搭 opencode（Java 栈仍留 Windows 侧）。

步骤：

1. 装 bun：`curl -fsSL https://bun.sh/install | bash`，重开 shell 验证 `bun --version`。
2. 拷源码到原生（排除 node_modules/.git）：
   `rsync -a --exclude=node_modules --exclude=.git /mnt/d/works/thirdparty/opencode/ ~/opencode/`
   （嫌 9p 慢可先 Windows 侧打 tar 再 WSL 解包。）
3. `cd ~/opencode && bun install`（原生模块报错则补 `build-essential`；postinstall 会跑 fix-node-pty）。
4. 启动：`bun run --cwd packages/opencode src/index.ts`。
5. 配置：精简 Linux 版 `~/.config/opencode/`，清理 Windows 路径（`D:\`、`C:\` 在 WSL 无效）。

## 4. 第二部分：任务栏闪烁通知（仅主会话，统一闪烁）

架构：

```
opencode(WSL) 事件 → notify 插件(过滤 parentID) → WSL interop 调 /mnt/c/Tools/flash/flash.exe
→ FlashWindowEx(FLASHW_TRAY|FLASHW_TIMERNOFG) → 终端任务栏按钮闪烁直到被激活
```

### 触发事件（同一 event 钩子，均带 sessionID）

- `session.idle` —— 任务完成（`schema/session-status-event.ts:44`）
- `permission.v2.asked` / `permission.asked` —— 权限确认（`schema/permission.ts:43`；`opencode/src/permission/index.ts:100` 发布）
- `question.v2.asked` —— 提问确认（`schema/question.ts:70`）
- 过滤：`client.session.get(id)` 取 `parentID`，仅主会话（与 app 端 `notification.tsx:369` 一致）。

### flash.exe（Windows 侧）

- C# + P/Invoke：`FlashWindowEx`、`EnumWindows`、`GetWindowThreadProcessId`、`GetClassName`、`IsWindowVisible`。
- 标志：`FLASHW_TRAY | FLASHW_TIMERNOFG`（闪到被激活）。
- 目标窗口：枚举可见顶层窗口，匹配进程名 `WindowsTerminal`/`conhost`/`mintty`/`Code` 或窗口类 `ConsoleWindowClass`。
- 参数：可选 `--title <子串>` / `--proc <进程名>`（多窗口收敛）；缺省自动匹配。
- 编译：系统自带 `C:\Windows\Microsoft.NET\Framework64\v4.0.30305\csc.exe`（免安装）。
- 输出：`C:\Tools\flash\flash.exe`。

### notify 插件（WSL 侧 `~/.config/opencode/plugins/notify.js`）

```js
export const NotifyPlugin = async ({ $, client }) => {
  const FLASH = "/mnt/c/Tools/flash/flash.exe"
  const isMain = async (sid) => {
    if (!sid) return false
    const s = await client.session.get({ id: sid }).catch(() => null)
    return s ? !s.parentID : false
  }
  return {
    event: async ({ event }) => {
      const t = event.type
      const sid = event.properties?.sessionID
      if (
        t === "session.idle" ||
        t === "permission.v2.asked" ||
        t === "permission.asked" ||
        t === "question.v2.asked"
      ) {
        if (await isMain(sid)) await $`${FLASH}`.catch(() => {})
      }
    },
  }
}
```

（需在 opencode 配置注册该插件。）

## 5. 验证

1. `C:\Tools\flash\flash.exe` 直接跑 → 切走窗口 → 任务栏闪。
2. WSL 内 `echo` interop 调用 → 通。
3. opencode 长任务完成 → 闪；触发权限/提问确认 → 闪；子代理会话不触发。

## 6. 风险 / 备注

- 多同类终端窗口缺省全闪，用 `--title`/`--proc` 收敛。
- VS Code 集成终端会闪 Code 窗口（可接受）。
- csc 路径缺失（精简系统）→ 回退 PowerShell AddType 免编译版。
- 执行顺序：WSL 搭建跑通 → 编译 flash.exe → 装插件 → 验证。

## 7. 备选（未采用，记录备查）

- Windows 原生修复 A+B+C（有界等待 + exit 语义 + 可中断输出）：纯 TS、零依赖，可作独立上游小 PR，与 WSL 方案不冲突。
- D2 显式 Windows Job Object（koffi FFI / 原生 helper）：根因修复但成本高，暂不采用。
- 其他通知通道：wsl-notify-send.exe（toast）、powershell+BurntToast（toast）、bell/OSC9（看终端）——已选任务栏闪烁，未采用。
