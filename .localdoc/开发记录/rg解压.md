# rg 冷安装 ZIP 解压

## 范围与基线
- 父 dev-workflow 阶段 5，Auto 已批准；仅实施 rg 子任务，不重启流程、不委派。
- 基线：`080b7671dea45a693b537c1e358e89ab14463d0d`。
- 阅读根 AGENTS、需求/测试用例 v2补丁整理，覆盖 TC-006。
- 旧 fork 的 `packages/core/src/ripgrep/binary.ts` 仅作只读参考；未迁入 download cache 优化。

## 根因与决策
1. 基线 ZIP 分支优先 `powershell.exe`，完整继承宿主环境。pwsh 宿主传入的模块路径可能导致 PS5.1 错误解析 Archive 模块。
2. 使用真实临时 Archive 模块污染复现：PS5.1 继承污染环境时非零退出（直接探测为 `poisoned PSModulePath`，Bun 测试为 Archive 模块无法加载）；相同 ZIP、相同进程路径在清理环境后成功。
3. 顺序为 `tar.exe → pwsh.exe → powershell.exe`。不能仅凭 tar 存在推断 ZIP 支持；必须退出码为零且存在预期 rg 文件才接受。启动失败、非零退出、缺失产物均回退。汇总全部尝试的错误。
4. 本机 `C:\Windows\System32\tar.exe` 为 bsdtar 3.8.8，实测 ZIP 支持成功；不是依赖所有 tar 都支持 ZIP 的假设。
5. PowerShell 使用 `-NoProfile -NonInteractive -EncodedCommand`；脚本编码 UTF-16LE，输出/错误明确 UTF-8，`ErrorActionPreference=Stop`，异常写 stderr 并 `exit 1`。路径保留单引号转义和 `Expand-Archive -LiteralPath`，不经过 shell 字符串命令插值。
6. 子进程环境复制后按大小写无关键名移除 PSModulePath，`extendEnv:false`，不写父 `process.env`。两代 PowerShell 均采用干净模块发现环境。
7. 保持官方下载路径、下载语义、tar.gz 分支、系统/缓存 rg 提前返回和最终 copy/chmod/产物检查不变。临时解压目录仍由原 scoped 生命周期清理。

## 修改文件
- `packages/core/src/ripgrep/binary.ts`：ZIP 分支接入 helper，传入已取得的 FSUtil 和 ChildProcessSpawner，避免 filepath 泄漏服务依赖。
- `packages/core/src/ripgrep/extract-zip.ts`：隔离且可实际注入路径验证的 ZIP extractor。
- `packages/core/test/ripgrep-extract.test.ts`：11 个真实进程/文件测试。
- 本文档。

## 验证结果（2026-09-22）
使用环境代理提供的 `D:\Program\bun-v2\node_modules\@oven\bun-windows-x64\bin\bun.exe`，版本 1.4.2；未自行安装依赖、未修改 lock。

从 `packages/core` 执行：
```powershell
& 'D:\Program\bun-v2\node_modules\@oven\bun-windows-x64\bin\bun.exe' test --timeout 30000 test/ripgrep-extract.test.ts
& 'D:\Program\bun-v2\node_modules\@oven\bun-windows-x64\bin\bun.exe' typecheck
```
- 最终测试：**11 pass / 0 fail，40 assertions，54.64 秒**。
- 最终 core typecheck：**通过**。
- `git diff --check -- packages/core/src/ripgrep/binary.ts`：通过。
- 早期依赖未就绪时系统 Bun 1.3.14 无法解析 effect/tsgo；工具链就绪后重新验证，已不再阻塞。
- 首轮类型检查发现 find 返回 null 和 helper 服务未闭合，已修正，最终检查通过。

测试覆盖：
- tar、pwsh、PS5.1 分别真实解压 ZIP，临时路径含中文、空格和单引号；archive 名额外包含方括号，验证 LiteralPath。
- 实际构建 ZIP、读取解压 rg.exe fixture 字节验证，而非仅比较命令字符串；fixture 不是真 rg 可执行文件，不执行它。
- PSModulePath 指向真实污染模块；PS5.1 原行为失败而 helper 成功；父环境及输入环境不被改写。
- tar 非零退出和启动失败回退到 pwsh，pwsh 失败回退到 PS5.1；均使用真实子进程。
- 解压成功退出但预期文件缺失，依次回退并最终拒绝。
- ZIP 损坏不能生成安装产物。
- pwsh / PS5.1 中文错误输出无替换字符，失败后同一临时目录可成功重试。

另在批准的 `D:\temp\systemp\opencode` 下运行真实 PowerShell/bsdtar 平台探测，验证上述编码、环境根因及 ZIP 支持。探测首次 120 秒超时，重试使用 360 秒上限完成；最终持久化测试全部在各用例 30 秒上限内通过。

## 边界、风险与未完成项
- 未访问或破坏全局 rg cache；测试仅使用 scoped 临时目录和实际路径注入，没有启动全局 RipgrepBinary 服务。
- 无网络下载整链路测试；本子任务验证冷安装的实际解压链路。系统/缓存 rg 绕过分支保持逐行不变，未为测试改动其行为。
- 非 Windows 的 tar.gz 分支未修改；未在非 Windows runner 实测。
- 已知平台限制：PowerShell Expand-Archive 的 DestinationPath 对包含方括号的目标目录可能报错；本次要求的中文/空格/单引号目标路径均实测通过，tar 不受此限制。未扩展为另一套 ZIP 实现。
- 根 `bun run check`、独立测试与审查由父流程统一执行；本开发子任务未替代独立验收。
- 本次范围内未解决阻塞：无。未 commit/push。

## 退役条件
官方 ZIP 冷安装同时具备 Windows 解压器真实成功判定/回退、pwsh 优先及 PSModulePath 子进程隔离，并通过本组真实临时 ZIP 回归后，可移除对应 fork 实现。

---

## 阶段 5 补修：官方 grep 用例失败闭环（2026-09-22）

### 请求与结论
- 对应独立报告 `测试报告-v2权限与平台.md` 的 `ripgrep.test.ts:132`。
- **确认是 fixture 依赖宿主 Git global ignore 的环境隔离缺陷，不是本次 ZIP installer、Windows 路径规范化、CRLF 或 rg 15.0/15.1 版本差异引入的生产问题。**
- 仅修 fixture，未修改生产 grep；原 `.opencode/config` 必须出现和 `.git/config` 不得出现两个断言均原样保留，没有 skip 或放宽断言。

### 根因证据
1. 直接在独立临时目录调用真实 rg，参数与生产一致：`--no-config --json --hidden --no-messages --glob=config --glob=!**/.git/** -- needle .`。
2. `--debug` 明确显示全局 Git ignore 规则 `**/.opencode/` 在目录遍历阶段排除了 `.opencode`。`--no-config` 只禁用 rg 配置文件，不等于禁用 Git global ignore；`--hidden` 也不覆盖 Git ignore。
3. basename include `config` 只能匹配文件，不能让已经排除的父目录进入遍历。因此 grep 返回空；find 的 `**/*` 同时白名单了父目录，所以此前的 find 断言通过。诊断时临时添加 `--no-ignore-global` 即可得到匹配，**没有把该选项加入生产代码**。
4. `GIT_CONFIG_GLOBAL` 单独设置为空配置不能隔离这两个 rg 版本的 global ignore 发现。真正对照使用独立 `HOME/USERPROFILE/XDG_CONFIG_HOME`，其中 `.gitconfig` 指向我们创建的独立 ignore 文件，没有修改用户配置。
5. 新回归使用 CRLF 文件，仍能得到精确 `.opencode/config` 和 submatch `{text:'needle',start:0,end:6}`，排除 CRLF/反斜杠解析因素。

### 干净固定基线的实际运行方式
- 通过 `git archive 080b7671dea45a693b537c1e358e89ab14463d0d` 导出到 `D:\temp\systemp\opencode\rg-base-080b7671`，未 checkout/stash 工作树。
- 只复用已经安装的外部依赖，通过临时 junction 提供 `node_modules`；`rg-base-preload.ts` 将所有 `@opencode/` workspace 导入重定向到固定快照源码，**不是只把旧测试跑在新生产代码上来冒充基线**。
- 基线命令在快照的 `packages/core` 运行：`bun test --preload D:\temp\systemp\opencode\rg-base-preload.ts --timeout 30000 test/ripgrep.test.ts`。
- 临时辅助脚本均在批准的 temp 根：`rg-base-links.ts`、`rg-base-preload.ts`、`rg-grep-probe.ts`、`rg-cold-probe.ts`。没有将它们放入仓库或修改依赖/lock。
- `git hash-object` 验证快照文件与固定 commit blob 一致：
  - `packages/core/src/ripgrep.ts`：`4f2317e0d82068c3903ccbde6f571e465d02f62e`。
  - `packages/util/src/cross-spawn-spawner.ts`：`a8f8623d0a583c5c6cf9aab85363a5c84b7bfdec`。

### 真实二进制选择及完整冷安装补验
- 现有可执行文件：`D:\Program\marktext\resources\app.asar.unpacked\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe`，实际 `ripgrep 15.0.0 (rev 3a612f88b8)`。只读复用，以进程级 PATH 前置显式选择。
- 冷安装：当前 `RipgrepBinary.node` 注入完整独立 `Global.Service`，初始 bin 为空，宿主 PATH 无 rg；实际通过生产下载和 ZIP 分支从 GitHub 下载 15.1.0，使用系统 tar 解压、copy 成功，并执行所得 `rg.exe --version`。
- 安装产物：`D:\temp\systemp\opencode\rg-real-cold-TWqDOp\bin\rg.exe`。
- 实际版本：`ripgrep 15.1.0 (rev af60c2de9d)`。
- SHA-256：`decdd4992f3f1b9a5ef9898f1b40ab16886d579d6516b4efd3d5eaa19364e408`。
- 此次已经补齐实际网络下载→解压→复制→执行链路，取代上文初始阶段“未执行网络下载整链路”的历史状态；没有访问、清空、覆盖全局 rg cache。
- 独立报告当时使用的日常缓存二进制版本仍未读取，不猜测其版本；本次两种明确版本均有同根因实证。

### 实跑矩阵

所有测试使用 Bun **1.4.2**。污染环境为自建 `rg-diagnostic-home`，唯一 ignore 规则 `**/.opencode/`；干净对照为自建 `rg-clean-home`，ignore 文件为空（仅注释）。两者全部 data/config/cache/state/home/TEMP 指向批准临时目录，rg 所在目录前置到子进程 PATH。

| 源码/测试 | rg | 全局忽略 fixture | 实际结果 |
|---|---|---|---|
| 固定基线源码 + 原测试 | 15.0.0 | 排除 `.opencode/` | **10 pass / 1 fail**，原第 132 行同样返回 `[]`，22 assertions |
| 固定基线源码 + 原测试 | 15.0.0 | 空 | **11 pass / 0 fail**，23 assertions |
| 当前源码 + 修前原测试 | 15.0.0 | 排除 `.opencode/` | **10 pass / 1 fail**，相同断言、相同返回值 |
| 固定基线源码 + 原测试 | 15.1.0 冷安装产物 | 排除 `.opencode/` | **10 pass / 1 fail**，相同断言、相同返回值 |
| 固定基线源码 + 原测试 | 15.1.0 冷安装产物 | 空 | **11 pass / 0 fail**，23 assertions，1.454s |
| 当前源码 + 快照内原测试（不启用基线 workspace 重定向） | 15.1.0 冷安装产物 | 排除 `.opencode/` | **10 pass / 1 fail**，确认修前 fixture 在当前生产代码上也失败 |
| 当前源码 + 修后测试 | 15.0.0 | 排除 `.opencode/` | **12 pass / 0 fail**，26 assertions，1.91s |
| 当前源码 + 修后测试 + ZIP 解压套件 | 15.1.0 冷安装产物 | 排除 `.opencode/` | **23 pass / 0 fail**，66 assertions，57.54s |

最终相关命令（在当前 `packages/core`，继承上述临时环境）：
```powershell
& 'D:\Program\bun-v2\node_modules\@oven\bun-windows-x64\bin\bun.exe' test --timeout 90000 test/ripgrep.test.ts test/ripgrep-extract.test.ts
& 'D:\Program\bun-v2\node_modules\@oven\bun-windows-x64\bin\bun.exe' typecheck
```
- core typecheck：**通过**。
- 根定向 lint：`bun run lint -- packages/core/test/ripgrep.test.ts`，**0 warnings / 0 errors**。
- `git diff --check -- packages/core/test/ripgrep.test.ts`：通过。

### 本轮实际修改与精确清单
1. **修改** `packages/core/test/ripgrep.test.ts`：
   - 原 metadata fixture 新增 `.ignore`，仅对白名单目录 `.opencode/` 显式允许遍历。
   - 新增真实文件回归：本地 Git ignore 排除父目录时 basename include 仍无结果；本地 `.ignore` 白名单后精确返回 `.opencode/config`，`.git/config` 仍排除；内容使用 CRLF。
2. **修改** `.localdoc/开发记录/rg解压.md`：本次基线证据、版本选择、修复及验证记录。

本轮生产代码修改：**无**。与首轮累计的仓库文件为以上两个文件，加 `packages/core/src/ripgrep/binary.ts`、`packages/core/src/ripgrep/extract-zip.ts`、`packages/core/test/ripgrep-extract.test.ts`，合计五个文件。

### 风险与未完成项
- 本失败已定位并修复，未解决阻塞：**无**。
- 未修改其他 agent 模块或独立测试报告，不替独立测试者更新其历史结果；父流程可据此安排独立复验。
- 未读取日常凭证，未修改全局 Git/rg 配置，未改并行工作树快照，未安装依赖、commit/push。
- 非 Windows 实测及 PowerShell 目标目录方括号边界仍按上文限制保留；本轮没有新增生产行为风险。
