# 独立代码复审：V2 原生 Instructions（Core 与私有 HTTP，修复后）

## 范围与规则

- **技术栈**：Bun / TypeScript / Effect；已加载 `code-review`、团队 `code-review-base/guide.md`，适用需求正确性、通用检查项、通用测试及评审心态；Java 公共模块主业务影响**不适用**。同时遵守仓库及 CLI、网站文档目录的 `AGENTS.md`。Effect API 对照当前 effect-smol 的 `FiberMap.ts`，未使用旧版 API 推断资源释放。
- **需求依据**：`.localdoc/需求文档/需求-V2原生Instructions.md`、同目录测试用例、`决策记录-V2原生Instructions-20260924095636.md`（DEC-001～007）、本次明确的重审重点。以 `afcdb4426dde98ecc96b86948a27854c0eaa4049` 对指定三份 Core 文件及两份网站 MDX 的累计 diff 为范围，**额外全量读取未跟踪** `packages/cli/test/instructions-http.test.ts`；对照上轮 Core 审查和外部/网站独立通过报告。外部全局仓库的任务前用户改动不归责本轮。
- **验证**：本轮只读复跑 `packages/core` 下 `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts test/session-instructions.test.ts`：38/38、217 断言；`bun test ../cli/test/instructions-http.test.ts --timeout 180000`：1/1、134 断言，使用私有服务、临时 HOME/XDG、环回 URL/fake provider；指定累计 diff 的 `git diff --check` 通过。父流程记录最终根目录 `bun run check` 的 oxlint 0 / 35 包 typecheck 通过、网站 typecheck/generated/build 通过；本审查未重跑这些全量构建。外部全量 check 的既有范围外 launcher 失败/超时不归责此次变更。

## 1. 需求实现正确性（需求 → 实现 → 证明性测试 → 结论）

| 需求 | 实现及调用方 | 测试/复核结论 |
|---|---|---|
| 相对 glob 逐层到项目根、绝对 basename glob、`~/`、配置顺序/近到远与 AGENTS 路径去重 | `packages/core/src/config/plugin/instruction.ts:60-70,98-166,209-225`；`FSUtil.scan`；`InstructionDiscovery.load`→`SessionContext.select` | Core 路径测试、私服首次真实模型请求均通过；文件创建/编辑/删除/重建和跨项目移动可达。**正常路径通过**；glob 冷启动静默失败仍会错误撤销旧会话指令，见阻塞 1。|
| 项目关闭时排除项目配置，global/project AGENTS 跟随 Location | `instruction.ts:40-43,60-96,99-106` | Core opt-out、根/嵌套范围测试及私服 Session.move 验证通过。|
| URL 请求有界、失败保留、签名 URL 外部脱敏、同 URL 稳定/异 URL 区分 | `instruction.ts:113-139,200-206,232-235`、`instruction-discovery.ts:10-15,134-172`；URL SHA-256 身份、清除 userinfo/query/fragment 的 label、日志仅安全 label | Core 双签名 URL、userinfo 实际请求、变更/撤销/diff/失败日志测试，私服真实模型消息及 SQLite blob/state 断言通过；`Effect.timeout("5 seconds")` 同时覆盖请求与读取 body。**原应改项已修复**；真实挂起 5 秒未单独实测，不能将其等同失败。DEC-007 不承诺 Basic，不把未发送 Basic 误报为缺陷。|
| 临时文件读取/目录遍历故障不误删，确认删除应撤销，包括重启后活动会话 | `instruction.ts:166-196` 保存本插件进程内的 `matched`，旧路径缺席时检查 `stat` 和目录可读性 | 同一插件持续运行时，模拟空匹配但文件存在、目录不可读、确认删除的 Core 用例通过；**跨插件重建/服务重启缺口见阻塞 1**。|
| 配置切换及时卸载旧 watcher、新路径仍刷新，长期无资源增长 | `instruction.ts:48-56,110-111,192-196`；`Watcher.layer` 的 scoped 原生订阅由 `FiberMap.remove` 中断释放 | 12 次正常切换的活跃订阅数、旧路径事件无刷新、新路径可更新均通过；**原无界累积阻塞已修复**。但配置读取因 URL/文件故障中途返回时没有执行协调，见应改 2。|
| 全局配置移除兼容桥、文档更新 | 外部仓库及 `services/www/src/docs/content/{config,instructions}.mdx` | 外部迁移/网站由此前独立审查通过且此轮未再修改；仅交叉比对文档描述与 Core 实现一致，不把已安装旧二进制当作当前实现的模型验证。|

## 2. Java 公共模块主业务影响

**不适用**：此仓为 Bun/TS，没有 Java 公共模块。按通用稳定性基线额外核查：每次配置扫描的本地遍历随候选祖先/匹配数增长；每次模型边界对每条配置 URL 最多一次顺序抓取，每条最多 5 秒，合计上界随用户配置 URL 数增长；无此次新增的数据库/Redis/MQ 调用或跨资源写入，InstructionState 沿用已有本地数据库事件/投影。正常配置切换通过 Effect scoped `FiberMap` 释放 native watcher；故障分支存在暂留旧订阅（应改 2）。未提供真实高并发量与配置 URL 数，不能虚构吞吐量；不据用户显式配置的多 URL 推定无界后台队列。

## 3. 依赖、兼容性与优化机会

- 未新增/升级第三方依赖，也未变更 Protocol/Server HttpApi；`File.path` 从本地绝对路径变为字符串支持不透明远程身份，本地路径 JSON 保持原形。URL 不透明 key 与去凭证 label 分离，更新、移除与旧 URL 来源的 diff 都经 `label` 渲染，已有持久化数据读取兼容。
- 每模型边界同步重读 URL 是更新语义，缓存可能导致旧指令；异步化可能改变 admission 时的规则可见性，不在没有缓存失效/同步契约的情况下建议。无本次新增的可优化 SQL/Redis、MQ 或适用的异步队列。
- 私服测试使用真实 checkout CLI/HTTP Session/SQLite 和隔离网络端点，检查实际发送到 fake provider 的 messages；并非仅断言 config 返回。但它不覆盖重启时 glob 遍历失败，也不覆盖故障期间配置 watcher 退订；已有 Core 测试只在同一个插件实例上先成功扫描，再令 `scan` 返回空。

## 4. 其他发现（均已核对活动代码、调用链及既有测试）

1. **[阻塞] 需求正确性：glob 静默扫描漏报在服务重启后仍会撤销已持久化的规则** — 证据 `packages/core/src/config/plugin/instruction.ts:44-51,166-184,192-197`、`packages/core/src/instruction-discovery.ts:114-119`、`packages/core/src/session/instruction-state.ts:21-35,210-215`。根因：修复仅在当前插件的内存 `matched` 中保存上次匹配；重新激活时该 Map 为空，即使既有 Session 的 `instruction_state.current_values` 仍通过哈希引用 `instruction_blob` 中的旧文件列表。`glob` 遍历错误可静默返回 `[]`（`packages/util/src/glob.ts:23-25`），于是 `for (const previous of matched.get(bucket) ?? [])` 不执行存在性/可遍历性核对，`configSource()` 返回成功空列表，`load()` 将零文件判作 `Instructions.removed`，持久化的已有值被写入撤销事件。触发路径：先有活动会话和 `rules/*.md` 规则 → 重启服务/重建 Location 插件 → 首次扫描匹配目录暂时无法列目录 → 用户继续该 Session。影响：磁盘上的仍有效规则在后续模型请求消失，违反需求 20、44、46 行及 DEC-002/004 的“故障保留”，并可能造成安全/项目约束丢失。建议在确认删除前把旧匹配身份从已持久化 instruction 值带入观测边界，或改用可报告目录遍历错误的扫描；新插件无内存历史时也必须区分“无匹配”和“扫描未知”，且补重启已有会话+扫描静默漏报的证明性测试。不修复则同一故障在重启/移动后的首个模型请求仍可误撤销，现有热实例测试不能证明恢复路径。

2. **[应改] watcher 生命周期：配置源读取中途不可用时退订协调被跳过** — 证据 `packages/core/src/config/plugin/instruction.ts:110-112,122-131,185-197,209-226`。根因：旧/新 watch plan 的 `FiberMap.remove`/`watch` 位于完整 `for (const pattern of patterns)` 之后；配置改为失败 URL 时 `return Instructions.unavailable` 在循环中提前退出（文件读取或扫描核对失败同理），旧配置来源的 native 订阅继续存活，直至后续某次**成功**刷新或整个插件关闭。例如从 `[A.md]` 成功加载切换为 `[B.md, 503 URL]`，A 的 watcher 未退订而 B 的 watcher 未订阅；旧 A 的文件事件仍触发刷新和失败 URL 请求（最多每事件一轮 5 秒等待）。`FiberMap.remove` 自身可中断释放订阅，正常切换 12 次的测试已证实；此处不是原审查所指的随切换次数无界增长，而是**故障期间当前配置与活跃 watcher 长期不一致**，且已有 503 故障/在线配置变化均为真实支持场景。建议即使读到不可用，也按已解析出的当前有效配置路径先协调订阅，保留“不可用不删除 instruction 值”语义，并增补“切换配置+URL 503+旧路径事件/活跃订阅数”的用例；不修复会持续监控已被删除的旧来源，并把旧路径写入放大成无意义重扫与远端访问，直至故障恢复。

原审查的三项核对：正常运行的 glob 漏报保留与确认删除**已修**、无限累计 watcher **已修**、URL 日志/模型/新持久化字段泄漏 **已修**；上述阻塞是首项在冷启动/重启边界的残余，第二项是 watcher 的故障分支残余，并非重报正常路径。没有将 URL userinfo 不发送 Basic（DEC-007）或外部用户已有修改列为问题。

**汇总：阻塞 1 / 应改 1 / 可选 0；总体结论：需修改后重审。** 实际修改：仅新增本审查报告，无源代码、测试或网站文档修改。未完成：没有新增重启故障或故障期 watcher 的可执行回归测试（审查职责限制）；真实 5 秒挂起 URL、私服压缩/回退组合未在本轮单独运行。
