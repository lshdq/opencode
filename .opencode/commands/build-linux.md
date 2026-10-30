---
description: 在 Ubuntu WSL 构建并验证 Linux x64 glibc baseline 便携版（含 Web UI）
agent: build
subagent: false
---

从当前工作区执行一次 Linux 便携版构建。以下是给执行智能体的操作指令，不是自动插值执行的 shell 脚本。只构建、隔离验证和生成本地归档；不修改源码或锁文件，不拉上游、不提交推送、不发布部署、不替换安装、不启动新的开发流程。不新增构建脚本，复用现有构建器。用户附加参数不能取消下面的目标、隔离或验收要求；有冲突先报告阻塞。

## 1. 只读预检

- 定位当前仓库根目录，记录 Git HEAD、工作区是否有改动以及根 `package.json` 的 `version`、`packageManager` 和 `bun.lock` SHA256。版本必须每次读取，不能写死（编写时为 `2.0.32`、`bun@1.4.2`）。版本规则参照 `packages/cli/script/windows-build.ts`、`windows-runtime.ts`，但不要运行 Windows 构建/部署脚本。
- Windows 下通过 `wsl.exe --list --verbose` 确认可用的 Ubuntu 发行版，再显式使用该发行版；已在 Ubuntu WSL 时直接使用。核对 `uname -m` 为 `x86_64`，记录 `/etc/os-release`、`uname -r`、`getconf GNU_LIBC_VERSION`。检查 Linux Bun 的真实路径、`bun --version` 与根 `packageManager` 中的版本完全一致，不能误用挂载盘上的 Windows Bun。
- 核对 Linux Git、bash、tar、gzip、sha256sum、mktemp、readlink、file 等所需工具；HTTP 检查可使用现有 Linux Bun。缺工具、版本不符、WSL 不可用、依赖下载/原生依赖失败或权限不足均停止并报告，不擅自安装软件、不改锁绕过失败。
- 只读核对当前实现：`packages/cli/script/build.ts`、`app-assets.ts`、`packages/script/src/index.ts`、`packages/app/vite.config.ts` 与 `vite.js`；运行验收参照 CLI 的 `src/commands/commands.ts`、`handlers/serve.ts`、`src/server-process.ts`、`services/service-config.ts`、`service-registration.ts`、`services/web-ui.ts`，以及 `packages/server/src/auth.ts`、`handlers/server.ts`。实现与下面参数/路径不符时先核实，不猜测不存在的 `web` 命令。

## 2. 创建当前源码的 Linux 快照

- 在 WSL 原生 Linux 文件系统用 `mktemp -d` 建立本次私有工作目录（权限 0700），内含源码、独立 HOME/缓存、编译输出、打包区和验收区；不得在原仓库里运行安装或构建，不共享、链接或复制 Windows `node_modules`。
- 从原工作区用 `git ls-files -z --cached --others --exclude-standard` 获取候选清单，按 NUL 解析，去重，读取**当前磁盘内容**，包含已修改的已跟踪文件及构建相关的未跟踪文件，跳过已删除文件。不能仅 `git archive HEAD`、checkout HEAD 或复制干净克隆，否则会丢失当前改动。
- 清单须再按 `git check-ignore --no-index` 排除忽略项（包括历史已跟踪但现被忽略的本地文件），并审查排除 `.git`、所有 `node_modules`、dist、缓存、日志、测试数据库、`.localdoc`、凭据/私钥、`.env*`、用户配置及其他秘密；不要盲目递归复制整个工作区或整个用户目录。必须保留构建所需的普通源码/资源、隐藏目录如 `.github/TEAM_MEMBERS`、workspace 清单、patches、锁文件和构建配置。若必要输入含秘密或被忽略，停止说明冲突，不静默漏掉构建输入或夹带秘密。
- 保持相对路径、文件字节及可执行权限；Windows 权限可参照 Git index mode。符号链接须核对目标留在快照内，不能链接回 Windows 依赖或快照外。记录输入文件清单和内容哈希，但不把源码或差异打进发布包；复制前后复核，源文件变化则停止，避免混合快照。
- 本方案不复制 `.git` 或 Git 配置/凭据。`packages/script/src/index.ts` 在显式设置 `OPENCODE_CHANNEL=local` 和 `OPENCODE_VERSION` 后跳过 `git branch --show-current` 与 npm 版本查询；所有安装/构建子进程必须继承这两个变量，`HUSKY=0` 禁用快照中的 Git hook 安装。核对当前其他构建步骤是否新增 Git 上下文需求；有则先解决/报告，不伪造分支或偷偷退回 HEAD 源码。

## 3. 冻结安装并构建

- 使用干净环境白名单，只继承必要 Linux PATH、locale 等操作系统信息，HOME、TMPDIR、Bun 缓存均指向本次目录。不要继承用户凭据、`SENTRY_*`、`VITE_*`、`BUN_OPTIONS`、其他编译/配置覆盖变量或 Windows 依赖路径，防止上传资源或把秘密编入 Web。确需网络设置时只允许经核实的非敏感设置，不打印秘密。
- 本次安装和构建统一设置 `OPENCODE_CHANNEL=local`、`OPENCODE_VERSION=<根 package.json.version>`、`HUSKY=0`；清除 `OPENCODE_BUMP`、`OPENCODE_RELEASE`、`BUN_COMPILE_RELEASE`。不自动升版、不使用 npm 查询结果决定版本。
- 在快照根目录执行 `bun install --frozen-lockfile`，使用独立 Linux 依赖；安装前后验证锁文件哈希与原始值相同，失败即停止，不改清单、不跑非冻结安装补救。
- 从快照 `packages/cli` 执行下面参数（用已核实的 Linux Bun 和本次目录的绝对路径替换占位值，不把尖括号原样传给 shell）：

  ```text
  bun run script/build.ts --target=opencode-linux-x64-baseline --skip-install --outdir=<本次私有目录>/compiled
  ```

- 必须给**独立、显式、绝对** `--outdir`：`build.ts` 开始即递归删除 outdir，不得传原仓库 `packages/cli/dist`、其 linux 发布目录或任何已有产物目录。不要传 `--skip-web-ui`，不要使用 Windows 的 `--single`；不构建 ARM64、musl、Desktop。现有 `app-assets.ts` 会执行 app build 并嵌入资源，无需另发 Web dist。
- 预期二进制为 `<outdir>/cli-linux-x64-baseline/bin/opencode`（目标名和输出子目录前缀不同）。检查存在、可执行、`file` 显示 Linux x86-64 ELF。再次验证原工作区和快照输入源码、package 清单及锁文件未变；构建产生的 node_modules、缓存和 dist 不算源码改动。任何输入变化都禁止发布。

## 4. 生成候选归档和中文说明

- 固定最终路径为原仓库 `packages/cli/dist/linux/opencode-<version>-linux-x64-baseline.tar.gz`，校验文件为同一路径追加 `.sha256`。文件名及包内顶层目录 `opencode-<version>-linux-x64-baseline/` 均不得添加时间戳或随机后缀；私有临时目录允许随机唯一名称。
- 在打包区创建该顶层目录，只放 Linux 可执行 `opencode`（权限 0755）、`使用说明.md`，可选仅含非敏感版本/目标/工具链信息的构建元数据。不得归档源码树、source.diff、开发依赖、配置、密码、注册文件、构建日志或冒烟测试数据库。先核对完整文件清单和符号链接安全性，再用 tar/gzip 生成**候选**包，不能直接写最终同名文件。
- 中文说明必须包含：
  - 解压后运行 `./opencode --version`、`./opencode --help`；`./opencode <项目目录>` 启动 CLI/TUI。运行时不要求 Bun/Node，但 Git、shell、项目工具链、模型网络/认证等外部能力并非全部内置。
  - Web 与 API 由同一程序提供：在可信本机终端运行 `./opencode serve --hostname 127.0.0.1 --port 4096`，前台保持运行，浏览器访问 `http://127.0.0.1:4096/`；端口冲突时选空闲端口，不停其他服务。默认要求认证：前台未提供密码环境变量时会在**用户本地终端**显示本次随机密码，妥善保密；Web 登录使用该密码，Basic Auth 用户名为 `opencode`。可由用户自行安全设置 `OPENCODE_PASSWORD`，不要把真实密码写入说明。Web HTML 可公开加载不表示 API 无需认证；不推荐关闭认证或绑定公网，不假定全局 `service get password` 能取得前台 serve 的密码。
  - 默认数据仍在用户目录，遵循 XDG：配置 `~/.config/opencode`、数据/会话 `~/.local/share/opencode`、状态 `~/.local/state/opencode`、缓存 `~/.cache/opencode`；不是全数据随包便携，不附带任何用户数据。
  - 本包目标是 Linux x64 glibc baseline，列出本次实测 Ubuntu、glibc、内核和架构；baseline 不等于任意旧 CPU/内核/glibc 可用，不适用于 musl/ARM，不宣称所有 Linux 通用。说明 SHA256 校验方式与尚未覆盖的交互测试。
- 在候选目录生成 `sha256sum <固定包名> > <固定包名>.sha256`，内容使用固定包文件名而非临时绝对路径；运行 `sha256sum -c`。然后将这个**最终打包内容**解压到全新验收目录，不以编译目录程序冒充成品验收。

## 5. 对最终归档解压后的程序隔离冒烟

- 所有命令使用解压后的 `opencode` 绝对路径，工作目录在本次隔离区、源码仓库之外，设置超时。使用干净环境（如 `env -i`/子进程显式 env 白名单），不能仅追加变量而继承用户 OpenCode/provider/proxy 凭据。借鉴 `windows-runtime.ts` 的隔离环境，但使用 Linux 路径：
  - HOME、`OPENCODE_TEST_HOME`、TMPDIR、`XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_STATE_HOME`、`XDG_CACHE_HOME`、`OPENCODE_CONFIG_DIR` 全部指向本次私有目录各自子目录，预先创建；Bun 缓存亦隔离。
  - `OPENCODE_DB=<本次隔离目录>/data/smoke.db`，`OPENCODE_CONFIG_CONTENT={"update":"disable"}`，`OPENCODE_CLI_CONFIG_CONTENT={}`，`OPENCODE_DISABLE_PROJECT_CONFIG=true`、`OPENCODE_DISABLE_CLAUDE_CODE=true`、`OPENCODE_DISABLE_AUTOUPDATE=1`、`OPENCODE_DISABLE_MODELS_FETCH=true`。不得继承 `OPENCODE_CONFIG`、密码、远程访问、外部数据库或服务地址覆盖。
- 执行成品 `--version` 和 `--help`，要求正常退出且版本严格等于本次根版本（允许当前 CLI 的 `opencode v` 展示前缀，不允许时间戳/预览版后缀）。记录解压后可执行文件 SHA256，与归档前程序比对。
- 使用同一隔离环境直接启动并持有子进程句柄：`<解压后程序> serve --service --hostname 127.0.0.1 --port 0`。随机端口避免碰撞；不使用默认共享服务发现，不启动自动登录、不设置隧道。stdout/stderr 留在隔离区且不回显秘密，不调用日常 `service restart/stop`，不按进程名 kill。
- 带截止时间等待本次注册 `$XDG_STATE_HOME/opencode/service-local.json`，只在内存读取，**禁止输出整个 JSON、password、Authorization 或带密钥 URL**。参照 `windows-runtime.ts::assertRegistration` 核对 pid 等于所启动进程、version 等于根版本、id 非空、password 非空、URL 为 `http://127.0.0.1:<实际端口>` 且无用户信息；用 `/proc/<pid>/exe` 的真实路径核对正在运行的确为解压后程序，不能仅凭同版本判断。
- HTTP 直连注册 URL，禁止环境代理、跨主机重定向或端口猜测。使用注册中的本次密码，在内存构造 `Authorization: Basic base64(opencode:<password>)`。不要把密码放入命令行参数、工具输出或报告；可用现有 Bun 的内存 HTTP 请求，不能让 curl 的详细日志泄密。
- 有界轮询认证 GET `/api/info` 至就绪，检查 HTTP 成功、JSON `pid`/`version` 与本次进程和根版本一致；另做不带认证的 GET `/api/info`，必须为 401。失败立即阻止发布，不能连到已有服务算成功。
- GET `/`，要求 200、HTML Content-Type、非空且含实际应用文档标识。从返回 HTML 的 `script src` 或 stylesheet `link href` 提取至少一个同源真实 `.js`/`.css` 资源（通常在 `/_assets/`），按 URL 解析后实际 GET；要求 200、正确 JavaScript/CSS MIME、非空正文且不是 HTML/不是 index.html 的 SPA fallback。可使用 `Accept-Encoding: identity` 简化正文校验；核对请求资源存在于本次快照新生成的 `packages/app/dist` 且内容哈希相符。不以随意路径 200 或仅 HTML 成功证明内嵌 Web 完整。Web 外壳/静态资源允许未认证访问，API 检查仍须认证。
- 成功或失败都在 finally 中清理冒烟环境：重新核对本次注册 id/pid/url 与持有句柄、进程映像，只终止自己启动且仍存活的进程（包括确认归属的子进程），等待退出；所有权不符则停止破坏性清理并报告。仅删除确认属于本次的冒烟子目录/注册/密码/测试数据库，候选包与后续发布必需材料保留到第 6 步完成，最后才清理本次构建目录；不触碰用户目录、已有服务或原发布包。不要把原始日志/注册文件作为发布证据。

## 6. 验证后替换与报告

- 只有完整构建、归档内容检查、解压成品 CLI/API/Web 冒烟和 SHA256 校验全部成功，才进入发布步骤；之前不删除、截断或替换已有包和校验文件，也不因同名存在再次询问。
- 将候选包与校验文件先复制到原发布目录下本次唯一的暂存位置，重新校验复制后的包，备份原有同名包/校验文件（包括仅一项存在的情况），再重命名替换固定名称。两个文件不是一次原子操作：替换及最终路径 SHA256/校验文件复核任一步失败必须回滚，恢复原有文件及其存在/缺失状态；全部成功前保留备份，若中断或回滚失败保留恢复材料并明确报告，不能宣称发布成功。全部成功后再移除本次暂存/备份，无需用户手动确认覆盖。
- 报告确切 Windows/WSL 路径、包 SHA256、程序版本/channel、目标、Bun 版本、源码/锁未变、实际 Ubuntu/WSL/内核/glibc/架构和 CLI/API/Web 检查结果。明确未覆盖交互式 TUI、浏览器完整交互、模型调用、所有 Linux/旧 CPU 兼容性及历史数据迁移；不得把静态检查或部分通过描述为完整运行验证。任何失败报告阶段、脱敏原因及旧产物保留/恢复情况。
