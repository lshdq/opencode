# 独立代码审查：V2 原生 Instructions（Core / Util / 私有 HTTP，二次修复后）

## 范围、规则和证据

- **技术栈**：Bun / TypeScript / Effect；已加载 `code-review`，读取团队 `code-review-base/guide.md` 与仓库 `AGENTS.md`。适用需求正确性、通用检查项、通用测试及评审心态；Java 专项及 Java 公共模块主业务影响**不适用**。仓库另要求保持分层依赖、Location/Session 指令归属及包内运行测试。
- **需求来源**：`.localdoc/需求文档/需求-V2原生Instructions.md`、`.localdoc/测试用例/测试用例-V2原生Instructions.md`、同功能决策记录 DEC-001～009，特别是 DEC-004～009，以及本次阶段 7 委派。基线为 `afcdb4426dde98ecc96b86948a27854c0eaa4049`。按指定命令核对七份已跟踪文件的**累计 diff**，完整阅读未跟踪的 `packages/cli/test/instructions-http.test.ts` 与 `packages/util/test/glob.test.ts`，完整阅读 Core 指令发现测试、生产文件，并追踪 `Watcher`、`Config`、`State`、`InstructionState` 和所安装的 glob/path-scurry 实现。外部配置与网站此前由独立报告通过，本轮只交叉核对文档与代码，没有将外部原有未提交工作归责本功能。
- **本审查只读执行**：从 `packages/util` 跑 `bun test test/glob.test.ts`（1/1，10 断言）；从 `packages/core` 跑三个指令测试文件（41/41，243 断言）及 `bun test ../cli/test/instructions-http.test.ts --timeout 180000`（1/1，134 断言）；共 **43/43、387 断言**。本审查 `git diff --check` 通过。最新独立测试报告还记录 Core/Util/CLI 包级 typecheck 和仓库根 `bun run check`（35/35 包、lint 零诊断）通过；**本审查未重跑**全仓检查。

## 1. 需求实现正确性（需求 → 实现/调用方 → 证明性测试 → 结论）

| 要求 | 实现及真实入口 | 测试、复核及结论 |
|---|---|---|
| V1 相对路径逐层到项目根、绝对 glob、`~/`、配置保序且与自动 AGENTS 去重；项目关闭不读项目规则 | `packages/core/src/config/plugin/instruction.ts:38-43,60-70,98-120,177-205,217-233` → `InstructionDiscovery.load` → Session 指令状态；与 `services/www/src/docs/content/{config,instructions}.mdx` 描述对照 | Core 路径/去重/关闭项目用例及 CLI 真实 HTTP Session→fake provider 首次请求的顺序、仅一次注入断言通过；全局配置、网站此前已独立审查。本轮未发现来源顺序或项目作用域回归。 |
| glob 遍历故障不能当删除；冷插件中已有 Session 规则也应保留，故障恢复与真删除分别处理 | `packages/util/src/glob.ts:31-49` 的 `fs.readdir` callback 在 glob 返回后上报非 ENOENT/ENOTDIR；`fs-util.ts:186-190` 包装错误；`instruction.ts:177-205,208-235` 将失败批次置 unavailable。已核对安装依赖 `glob/dist/commonjs/walker.js:221-226` 的 `readdirCB` 及 `path-scurry@2.0.2/dist/commonjs/index.js` 调用 `this.#fs.readdir(fullpath,{withFileTypes:true},...)`，不是假设 hook 生效 | Util 使用真实 glob 异步遍历、注入 EACCES/ENOENT/ENOTDIR，对照原 `Glob.scan`，再测无匹配和真删除；Core 用真实 `InstructionState` SQLite 投影跨插件 scope 重建，在新插件首次 EACCES 扫描时验证 preview/提交旧哈希不变，恢复更新与真删除撤销。**通过**。此测试在同一测试进程重建插件，不是 OS 进程重启。原 `Glob.scan` 仍用原实现，默认调用方未改。 |
| 配置切换即使 URL 503、扫描或文件读取失败，也须退订旧动态 watcher、订阅当前本地路径；固定 AGENTS watcher 不应丢失 | `instruction.ts:48-70,123-145` 在任何本地扫描/远端请求之前计算完整 watcher plan 并以 `FiberMap.remove`/`run` 协调；`Watcher` 的 Scoped 订阅在 fiber 中断时释放，固定 watch 使用独立 `fixed` map | Core 12 次正常替换及 A→[B/C,失败 URL] 替换验证活跃数/峰值有界、旧路径事件不再重抓远端、新路径仍触发；`instruction-discovery.test.ts:1000-1072` 验证固定 AGENTS 更新/删除。这同时排除了前两轮报告的正常配置泄漏及故障分支早退。**通过**。本审查未直接测量 native OS 句柄或真实权限恢复事件。 |
| URL 请求、失败保留、脱敏身份及旧 URL diff，不隐式发送 Basic | `instruction.ts:148-173,208-244` 请求使用原 URL、5 秒 Effect timeout；来源键用完整配置字符串 SHA-256，label 清除 userinfo/query/fragment，失败日志只记录安全 label；`instruction-discovery.ts:138-170` 初始、变化、移除与旧持久化 URL diff 均使用脱敏 label；`InstructionState.observe/preview/commit` 保留 unavailable 之前的值 | Core 的双签名 URL、userinfo/no Basic、故障/恢复及旧 URL diff 用例，CLI 的真实模型 messages、私有 SQLite blob/state、503 与签名 URL 切换用例通过。不同签名不合并，删除/更新可达；与 DEC-006/007 一致。**通过**；私有测试没有模拟真正持续挂起 5 秒的远端。 |
| 会话状态、更新、移动与兼容性 | `InstructionDiscovery.load` → `SessionContext`/`InstructionState`；本次未改变 Schema/Protocol/Server HttpApi，也未引入新依赖 | CLI 私服测试调用真实 checkout CLI `serve`，独立 HOME/XDG/项目/环回 fake provider，检查实际模型消息的创建、编辑、删除、配置切换及 `session.move`，不是只检查配置 API；既有状态/压缩/回退单元测试通过。本轮未运行私服压缩/回退组合，见边界。**通过**。 |

## 2. Java 公共模块主业务影响

**不适用**：此仓及变更是 Bun/TS，没有 Java 公共模块。通用稳定性仍已核查：watcher 随插件/Location scope 关闭，动态部分每次按**当前**配置 plan 收敛，固定部分随所在 scope 保留；每模型边界可按配置重扫来源并顺序请求 URL，每 URL 超时 5 秒，URL 数目/匹配规模由用户配置决定；故障时不提交错误删除。此次不新增数据库/Redis/MQ 或跨资源远端写入，持久化仍通过既有 Session 事件投影。缺少真实生产配置规模和并发量，不能虚构吞吐上界或声称做过长期压测。

## 3. 依赖、兼容性与优化机会

未升级/新增 `glob` 或 path-scurry 依赖：新增 `scanChecked` 仅由配置指令来源使用，`scan` 的 matcher/默认语义保持原形；Util 定向测试实测了这一兼容性。没有更改 HttpApi 或客户端生成面。既有本地路径状态字段格式不变，新的 URL 来源用不透明键；旧 URL 身份的渲染走兼容脱敏分支。每模型边界重新读取是已批准的更新契约，无明确失效策略时缓存或异步化会改变指令可见时序；本范围没有需优化的 SQL/Redis 或 MQ 调用。文档本轮无追加修改，内容与本次实现交叉一致。

## 4. 其他发现、复核与结论

- **阻塞：0；应改：0；可选：0。** 没有发现经代码、调用链及可执行测试复核成立的本范围问题。前两轮报告的冷插件 glob 漏报和故障期 watcher 早退已由上述 DEC-008/009 实现及新测试覆盖；原 watcher 无界增长与 URL 凭证明文输出也已逐项复核为修复。未把不发送 Basic（明确非合同）、未跟踪测试未进入普通 `git diff`、或者仓库外原有修改当成缺陷。
- **必要验证边界**：真实 OS 进程退出后重新打开磁盘 SQLite 并注入内核 EACCES 的组合、native watcher 句柄现场测量、私服实际 5 秒挂起 URL、私服压缩/回退模型组合，本轮和最新独立测试都没有执行。已有真实依赖 hook / DB 投影 / 私服请求分层证据，但不能将同进程插件重建写成服务进程重启。外部全局仓库全量 `bun run check` 曾在本任务未改的 launcher 模型断言失败且 120 秒超时；迁移定向测试另有通过记录，不宣称其全量通过。

**总体结论：通过（限指定累计 Core/Util/CLI 测试及文档交叉核对范围）。** 实际修改：仅新增本中文审查报告；生产代码、测试、网站与外部配置均未修改。未完成项：上述端到端/系统级残余验证边界，无本轮职责内待修问题。
