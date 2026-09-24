# v2 Windows 构建、隔离验证与配置迁移

## 已合入上游基线与工具链

- 上游基线：构建时对本地 Git 引用执行 `git merge-base HEAD upstream/v2`；上游前进但未合入 fork 的提交不会改变此基线。`upstream/v2` 不存在或无法解析时失败，不自动 fetch。Bun：`1.4.2`。
- 本机便携 Bun：`D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe`（Bun 1.4.2；本机无 Bun PATH）。包装脚本以此为默认路径，也可通过 `-Bun` 显式指定。
- 从上述**已合入基线提交的根 package.json**读取动态版本（要求 packageManager 为 `bun@1.4.2`）；不查询 npm latest、不改 package 版本或锁文件。产物 `--version`、注册服务及 HTTP 身份须与该版本一致；元数据保留实际基线 SHA，以便之后 `upstream/v2` 移动时重跑旧产物 smoke。
- `build-metadata.json` 独立记录 fork HEAD、dirty 状态、Git status、实际源码文件哈希清单及集合哈希、bun/lock/二进制 SHA256、构建参数和时间。清单区分 tracked/untracked、file/symlink/deleted，symlink 记录目标及目标文本哈希。未提交和未跟踪源码亦纳入；构建期间源码改变则拒绝部署。
- 同时在构建目录保存相对 HEAD 的二进制安全 `source.diff`（含 staged 与 unstaged 的最终内容差异），并将其 SHA256 写入 metadata；CI artifact 一并保留，单文件部署不复制这些元数据。未跟踪文件内容由逐文件哈希追溯，不把“HEAD 仍等于基线”误解为未打补丁。
- `source.diff` 通过 `executeRaw` 取得 Git stdout 的原始字节，直接以 Uint8Array 落盘，不解码、不 trim、不补换行；版本、SHA、路径等元数据继续使用规范化文本 `execute`。这样保留末行尾空白、LF/CRLF、无末尾换行标记和 binary patch。阶段7 R1修复前的制品差异文件可能被截断，不能作为最终交付，应重新构建、冒烟并核验，而不是手工补一个换行后复用旧制品。

## 构建命令

在 PowerShell 7 中：

```powershell
# 默认：冻结安装 → Windows 单平台构建 → 隔离 cold/warm smoke → 版本化部署
./packages/cli/script/build-win.ps1

# 仅构建（不 smoke、不部署）
./packages/cli/script/build-win.ps1 -BuildOnly

# 构建并 smoke，但不部署；已有冻结依赖时可跳过安装
./packages/cli/script/build-win.ps1 -SkipInstall -NoDeploy
```

包装调用官方 `packages/cli/script/build.ts --single --skip-web-ui --skip-install --outdir=<唯一目录>`。
安装由包装提前执行 `bun install --frozen-lockfile`，不使用官方 build.ts 的跨平台、可能写 manifest/lock 的安装分支。
输出：`packages/cli/dist/windows/v2-<上游基线版本>-<source-hash>-<timestamp>-<nonce>/`；不重用/清空旧构建目录。
`--skip-web-ui` 表示不构建浏览器资源，不能据此宣称浏览器 UI 已通过验收。

默认部署父目录 `D:\Program\opencode` 必须已存在；仅排他复制单个 `opencode-<上游基线版本>-<本地时间YYYYMMDDHHmm>.exe`，时间精确到分钟，同分钟重试若同名将失败而不覆盖已有文件。不创建版本子目录，绝不写默认 `opencode.exe`、PATH、快捷方式或启动服务。
`-DeployRoot` 可指定已存在的替代父目录。部署前隔离 cold/warm smoke 必须成功；复制后校验二进制哈希，在隔离环境运行**已改名** exe 的 `--version` 并核对基线版本。元数据、smoke 报告和 source.diff **只在构建目录保留**，不随部署复制。
失败产物保留在独立构建目录；不得将失败/未冒烟产物作为验收成功制品。

### Windows checkout 环境

Git 设置 `core.symlinks=false` 时，app/enterprise 的 `src/custom-elements.d.ts` 可能被检出为路径文本，导致 TS1128。使用：

```powershell
& 'D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe' ./packages/cli/script/repair-windows-links.ts
```

只修复这两个 mode=120000 且内容等于索引目标的占位文件，通过命令级 `git -c core.symlinks=true checkout-index` 建立真实链接；不更改全局/local Git 配置或索引。不覆盖已编辑的文件，缺少创建 symlink 权限时明确失败。构建包装和 CI 已调用该预检。

若安装曾被强制中断，后续普通 frozen install 返回成功仍可能留下未完整链接的包。实际排障中 cache 的 zod locales 完整而 node_modules 只有部分文件；以 `bun install --frozen-lockfile --force` 重新链接修复，不改锁、不降版本。不要在安装仍运行时并发启动依赖安装或依赖修复。

## 服务隔离与更新保护

本构建编译 channel 固定为官方 `local`，不是 `latest/dev/beta/next`，也不是自定义 fork channel：

1. 官方 `Updater.inspect` 对 `OPENCODE_LOCAL` 跳过自动更新；`check` 返回 unavailable。无需改更新核心。
2. `ServiceConfig.filename` 使用 `service-local.json`；local 不迁移默认 `service.json`。
3. 任意自定义 channel 虽有不同文件名，但 `ServiceConfig.options` 可能迁移 `service.json`，而 `versionBelongsToChannel` 对**同版号**直接返回 true。因此仅改自定义 channel 不能证明与官方同版服务隔离。
4. 同版号不能区分 fork 或两个不同的补丁构建。smoke 必须验证新启动子进程 PID、注册 instance id、HTTP pid/version、Win32_Process.ExecutablePath 和 SHA256，而非只比较 `--version`。

smoke 使用新建目录中的 HOME/USERPROFILE、APPDATA/LOCALAPPDATA、XDG config/data/state/cache、临时目录、数据库和 Bun 缓存；清除继承的 OPENCODE 配置/服务/凭证覆盖，禁止项目配置发现；禁用模型网络刷新和自动更新。服务显式绑定 `127.0.0.1:0`（随机端口）。
脚本明确拥有新建临时根的 `data` 子目录；在启动服务或创建/复制任何数据库之前调用当前公开 API `FileMode.directory(data, { owned: true })`。smoke DB、compiled integration 合成基线库和恢复副本均位于此私有目录。源码诊断也是先准备目录再启动目标源码，因此固定官方基线无需认识新 `privateDirectory` 选项，也能从创建时继承正确 ACL。该授权只属于脚本自身临时目录，不能套用到用户传入的任意 DB 父目录。
仅读取该新目录的 `service-local.json`，绝不执行日常程序的 `service get password/status/stop`。终止前重新核对注册所有权；失败清理只操作持有的子进程对象。凭证/测试数据库结束后删除，报告仅保存非敏感身份及耗时。

```powershell
# 可对保留构建重新执行 smoke；依据该产物记录的上游提交而非当前 upstream/v2 核对版本
& 'D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe' `
  ./packages/cli/script/smoke-win.ts '<构建目录>'
```

`local` 默认服务端口仍与其他 local 开发共享。因此**日常试用也必须独立设置数据目录及服务端口**；本任务仅版本化部署，不自动激活或提供未隔离运行捷径。禁止 `dev:live`。不要手工执行 `upgrade --method ...`：那是显式请求官方安装器，与自动更新保护不同。

## 配置迁移原则

- 不直接覆盖日常 `opencode.json(c)`、`config.json`、`cli.json` 或数据库；新环境只迁入人工审核的副本。
- 使用官方 v2 配置分域：运行/模型配置在服务端配置，TUI/会话权限初值使用 `cli.json` 的 `session.permissions` 或 `--auto`。不增加旧 `auto_approve` 字段。
- 权限切换是当前 TUI 实例临时覆盖，不能把快捷键切换解释为自动改写持久配置；deny 保留。
- 旧 `autoupdate:false` 的 v2 对应值为服务端配置 `"update":"disable"`；这与 local 编译保护叠加，不依赖迁移后默认策略。
- 不可批量复制旧 fork schema；权限、时间戳和输入历史的具体边界如下。
- 不恢复旧 runtime 或强制恢复 LSP；Windows shell 正常退出允许后代存活的官方契约保留。

### F4、Settings 与输入撤销窗口

- **F4**（可通过 `permission.mode` keybind 重绑定）在 prompt/autoaccept 间双向切换，作用于当前 TUI 实例及其标签；也能把 `--auto` 启动的实例切回 prompt。它不是设置保存操作，不会修改 cli.json，显式 deny 仍有效。
- `/settings` → Session → **Permissions** 修改持久默认 `session.permissions`（`prompt` / `autoaccept`）。F4 手动覆盖的优先级高于该默认以及 `--auto`，覆盖持续到当前实例结束；不要把修改默认设置误认为清除了已有实例覆盖。
- `/settings` → Session → **Assistant timestamps** 控制持久的 `session.timestamps`，默认关闭。显示的是助手消息**创建时间**，不是 duration；也可用命令面板 Show/Hide assistant timestamps（`session.toggle.timestamps`，默认没有快捷键）。
- Ctrl+X 只在聚焦、可编辑且有有效选区时剪切；无选区仍保留 leader。应用层统一管理文本、光标、附件和粘贴载荷的撤销/重做，不按 OpenTUI 内部 checkpoint 数量猜测元数据。
- **Prompt 输入历史最多保留最近256个逻辑编辑步骤，并受16 MiB历史保留预算约束**；任一上限触发时淘汰最旧完整记录，不能只撤销文本而丢失对应附件/占位元数据。预算覆盖应用历史，不代表整个 renderer 的内存上限。新编辑清空 redo 分支；`setText`/`setTextOwned`、`clear`、`clearHistory` 重置窗口，普通可撤销 `replaceText` 仍记录逻辑步骤。该限制仅针对输入框 undo/redo，不是 Session 消息撤回。

### Windows 自定义数据库目录：有意的兼容行为变化

- **推荐保留默认路径，不设置 OPENCODE_DB。** 默认应用数据目录及 DB 文件位置不迁移；CLI 只对未覆盖的默认位置显式授权 `privateDirectory: true`，在 SQLite 创建/打开文件之前建立私有继承。该应用自有目录及继承型后代的 ACL 可能被收紧，但不加固上级 XDG 根，不移动或丢弃现有数据库内容。
- 显式 `OPENCODE_DB` 属于自定义路径，**不会自动获得父目录 ownership**。其实际父目录必须已存在、不是 reparse point，并满足 protected DACL、仅当前 SID Allow FullControl、ObjectInherit + ContainerInherit、无传播限制。生产检查不修改不安全的 custom parent，不满足时 fail closed，而不是悄悄修共享目录。
- 因此，原先指向普通/shared 目录的 Windows custom DB **现在可能被拒绝启动**。不能声明“对所有用户都无行为变化”，也不要通过扩大其他账号权限或给整个工作目录递归改 ACL 来绕过。
- 私有继承确保新 DB/WAL/SHM/journal 从创建起即受保护，关闭后重新生成侧文件也适用；事后只 chmod 文件无法撤销其他主体已经取得的旧读取句柄。已发生的暴露或历史句柄需要另行处置，本补丁不能追溯撤权。
- Windows 文件权限宿主默认使用系统绝对路径 PowerShell 5.1，支持 PowerShell 7；不可用或被策略阻止时明确失败。需要支持 DACL 的本地文件系统，原子配置迁移还需要同卷 hard link；本机验证为 NTFS。

确需自定义库时，应明确创建一个**全新的专用目录**，然后在写入任何数据库或副本之前准备继承 ACL。例如在本源码仓库根运行（下面仅影响新建专用目录，不修改现有用户目录）：

```powershell
$parent = 'D:\works'
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw '父目录不存在' }
$directory = Join-Path $parent 'opencode-v2-private-db'
if (Test-Path -LiteralPath $directory) { throw '拒绝修改已有目录，请选择全新的专用目录' }
New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
& 'D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe' -e `
  'import { FileMode } from "./packages/util/src/file-mode.ts"; await FileMode.directory(process.argv[1], { owned: true })' `
  $directory
if ($LASTEXITCODE -ne 0) { throw '私有目录准备失败，不要创建或复制数据库' }
$env:OPENCODE_DB = Join-Path $directory 'opencode.db'
```

这里 `owned: true` 是创建者对专用目录的明确授权，不是 CLI 环境变量，也不应设成对所有自定义路径通用的绕过开关。已有自定义 DB 应先做一致性备份，再按下节复制/恢复到明确准备的私有目录；不要直接切到一个空库冒充数据迁移。隔离验证还须同时设置独立 XDG 根和服务端口，上例不负责启动服务。

## 数据迁移与回滚

1. 停止**副本测试环境**服务后复制数据。对正在使用的 SQLite 使用一致性备份方式，不能只复制主 DB 而忽略 WAL；不要为取副本主动关闭日常服务。
2. 建立完整副本（config/data/state/cache 及数据库），保留只读原始备份；Windows 自定义目标库在复制前先准备上述专用私有父目录。不要把旧 service 注册、密码、PID 当成可复用服务身份。
3. 在隔离环境中启动新版本，核对实际二进制及数据路径，再做历史会话兼容测试。
4. 回滚不仅切回旧 exe，还需切回升级前数据副本；不得让旧版本直接打开已被新版本迁移的数据。

当前自动 smoke 只验证空环境 cold/warm 服务生命周期及认证。真实历史数据迁移、交互 TUI、反复启动性能统计须另测；文档不是这些测试已通过的证明。

## 源码启动诊断

```powershell
& 'D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe' `
  ./packages/cli/script/diagnose-source-win.ts 'D:\works\thirdparty\opencode-v2' `
  serve --service --port 0 --print-logs
```

该脚本不构建产物，使用全新隔离目录，校验自己启动的 PID/源文件命令行及认证 API 身份，最终清理自己仍持有的进程树和数据目录。失败/超时退出非零。可使用 `--version`、`--help`，以及额外 `--trace-imports` 输出主要模块加载时刻；trace 会加入 TS loader 观察器，不能取代无插桩对照。

实测固定无补丁基线与补丁版均能注册并返回 `/api/info` 200。源码加载/初始化耗时曾超过原 service.test.ts 的20秒内部注册等待预算，且日志直到 server bootstrap 才出现；后续独立测试已把启动预算与识别后退出预算分开。因此“30秒无 stdout”不是永久挂起或 ACL 根因的充分证据。当前 ACL 目录契约又有变化，完整服务测试仍需重新准备 fixture 私有父目录并复测，不应忽略失败或沿用旧制品验收。

## CI

`.github/workflows/build-windows.yml` 使用 Windows runner 和 Bun 1.4.2，冻结安装、小测试、独立构建与 smoke；明确 `-NoDeploy`，仅上传 bin、metadata 和脱敏 smoke 报告。不提交、不推送、不发布 release。CI 在完整历史 checkout 后，显式从官方 `anomalyco/opencode` 的 `v2` 分支获取本地 `upstream/v2` 引用，并在安装依赖前验证其与 HEAD 存在共同祖先；构建脚本本身不会自动 fetch。离线运行或上游不可访问时，该 CI 前置步骤会失败。
