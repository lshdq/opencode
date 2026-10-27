# 独立审查报告：V2 原生 Instructions（全局配置与网站文档）

## 审查依据和边界

- 技术栈：Bun/TypeScript、Astro/MDX；适用团队 `code-review-base/guide.md` 的需求实现正确性、通用检查项、测试与评审心态，Java 专项及公共模块主业务影响**不适用**。网站子目录的文档格式及验证要求比通用基线更具体，亦已核对。
- 需求来源：`.localdoc/需求文档/需求-V2原生Instructions.md`、`.localdoc/测试用例/测试用例-V2原生Instructions.md`、`.localdoc/决策项/决策记录-V2原生Instructions-20260924095636.md`。本报告只审查父任务指定的**外部全局配置迁移和网站文档**；Core/CLI 实现及新增 HTTP 测试由另一独立审查负责，本报告仅在核对文档和迁移语义时交叉阅读相关代码/测试。
- 主仓文档以 `afcdb4426dde98ecc96b86948a27854c0eaa4049` 对两份 MDX 的精确 diff 为基线；外部仓库以 `D:\temp\systemp\opencode\instructions-baseline-20260924095636\` 中九份原样文件逐一比对，**没有**用其 `git diff HEAD` 推定本次改动。外部仓库其余起始用户修改、历史 `.localdoc` 和备份不在本次变更范围。

## 1. 需求实现正确性

| 需求与约束 | 实现 / 调用方 | 证明性测试与结论 |
|---|---|---|
| 全局配置启用 `.opencode/AGENTS.md`，取消服务器兼容插件注册，保留用户既有设置 | 外部 `opencode.jsonc:3-5` 替换旧 `plugins`；逐文件 diff 表明 `default_agent`、`update`、`references`、`permissions`、`agents` 及原注释尾部未变化。Core `config/plugin/instruction.ts:98-156` 将配置条目按来源加载；`test/global-plugin.integration.test.ts:72-106` 断言服务加载的全局文档、权限及无外部服务器插件 | **通过**：静态迁移测试与私有服务配置 API 测试；真正模型可见性由隔离源码 HTTP 测试 `packages/cli/test/instructions-http.test.ts:63-72,124-130` 证明相同指令键的行为，但该测试使用自己的私有配置，不能宣称外部仓库真实文件曾发起模型调用。 |
| 删除的目录、代码、测试仅服务于旧桥接，且无活跃孤儿引用 | 原样快照 `extensions/server/index.ts:1-2` 只转发 `v1-compat.ts`；`v1-compat.ts:10-64` 仅注册旧指令与已获准取消的 debate 温度补丁；两份 `v1-compat` 测试仅验证该插件。外部 `package.json:9` 指向仍存在的 `test/global-plugin.integration.test.ts`；当前 `extensions/` 下仍保留 `cli/`，活跃配置/脚本/源码搜索无旧插件或测试路径引用 | **通过**：目录存续、脚本目标及外部定向测试均核对。旧 `.localdoc` 的历史回顾仍提及桥接，但不是运行入口且属于任务前资料，不误认成活动引用。 |
| 允许删除 debate 温度补丁，但其他 agent、命令与权限保留 | 快照 `v1-compat.ts:31-40` 只修改三名 debate agent 的温度；当前 `test/global-plugin.integration.test.ts:48-104` 仍逐项核对六名 agent、debate 命令、技能、引用及关键权限，移除了旧温度断言 | **通过**：删改符合需求明确豁免；不将失去温度断言误判为缺陷。 |
| 网站文档不再说 `instructions` 无效；描述来源、顺序、生命周期与去重 | `services/www/src/docs/content/config.mdx:415-426` 和 `instructions.mdx:65-80,101-115`；与 Core `config/plugin/instruction.ts:60-67,98-156,169-222` 对照：全局/自动发现与配置共同加载，配置内保序，近到远扫描，同源按路径去重，URL 随模型边界刷新 | **通过**：文档修改与契约、实现、隔离源码 HTTP 测试 `packages/cli/test/instructions-http.test.ts:124-173` 一致；网站 Astro typecheck、生成检查及 build 均有独立测试记录。 |

测试断言核查：外部静态测试 `test/migration-config.test.ts:21-35` 能在配置误删/旧插件回归时失败；外部私服 `test/global-plugin.integration.test.ts:72-106` 断言的是解析出的配置及真实插件目录而非只测启动。但该外部私服默认用 PATH 上的已安装二进制，`prompt(..., resume:false)` 不调用模型；原生模型链路的证明来自主仓隔离源码测试，**两者不可混同为一个真实外部配置模型闭环**。该组合已分别覆盖本次受审行为，未据此虚报发布阻塞。

## 2. Java 公共模块主业务影响

不适用：本轮是 TS/MDX 配置、测试与文档迁移，不存在 Java 公共模块、Spring/Dubbo、SQL、Redis 或 MQ 链路。

## 3. 依赖、兼容性与优化机会

- 未新增或升级第三方库；`package.json` 与原样快照唯一差异是集成测试脚本路径。删除插件后不存在其 hook 的监听/资源持有，未发现新的启动网络依赖、无界队列、远端访问扇出或跨资源写入。缓存/异步化和数据库访问优化不适用本范围。
- 配置行为变化属于需求指定的迁移，唯一旧行为损失是三个 debate agent 的温度 overlay，已明确获准取消。旧桥接下的项目规则、去重、更新和移动对应的 V2 来源/状态行为由独立源码测试验证；外部真实配置与已安装二进制的集成测试仅保证配置解析/插件取消，不证明已安装程序含新 Core 实现。
- 独立测试报告记录主仓最终 `bun run check` 35/35 包、网站 `bun typecheck`/`bun run check:generated`/`bun run build`、外部定向 5 例及 `test:integration` 1 例成功。外部全量 `bun run check` 在既有范围外 `launcher.test.ts` 模型断言失败并于 120 秒超时，**不宣称全量通过，也无证据将其归咎于本次迁移**。本审查额外执行主仓两份文档 `git diff --check`（通过）及外部 `bun test ./test/migration-config.test.ts`（4 通过、0 失败、90 次断言）。

## 4. 其他发现与结论

复核删除文件是否包含非桥接行为、目录残留、活跃脚本引用、错误/权限边界及测试证明后，**无可证实的本范围问题**；没有仅依据已安装二进制或已通过的编译作行为正确性结论。

**阻塞 0 / 应改 0 / 可选 0；总体结论：通过（限本报告审查范围）。** 未完成：本次审查未重跑外部全量 check，也未测试外部仓库真实全局文件在当前源码服务上的模型请求；两项验证边界已明示。实际修改：仅新增本审查报告，无生产/测试代码变动。
