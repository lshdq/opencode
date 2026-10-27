# 代码审查：V2 原生 Instructions（Core 与私有 HTTP）

## 范围与依据

- **技术栈**：Bun / TypeScript / Effect；适用 `code-review` 和团队 `code-review-base/guide.md` 的需求正确性、通用检查项、通用测试及评审心态；Java 公共模块专项**不适用**。仓库 `AGENTS.md` 额外约束运行时依赖方向、Location 所属服务及指令状态持久化。
- **需求来源**：`.localdoc/需求文档/需求-V2原生Instructions.md`、同名测试用例、`决策记录-V2原生Instructions-20260924095636.md`，以及本轮明确的 V1 解析语义和阶段 7 范围。基线为 `afcdb4426dde98ecc96b86948a27854c0eaa4049`；审查三份指定 Core 文件对该基线的 diff，另全量读取未跟踪的 `packages/cli/test/instructions-http.test.ts`。会话 runner 的已撤销临时修改不计入范围。
- **交叉核验**：对照 `dev:packages/opencode/src/session/instruction.ts` 的相对 `globUp`、绝对 basename glob、`~/` 和 URL；追踪当前 `Config`/`ConfigDiscovery`、`Watcher`、`FSUtil.scan`、`InstructionDiscovery.load`、`SessionContext.select`、`InstructionState`、插件激活和 `glob` 依赖实现。独立测试报告证明了私有 CLI→真实 Session→fake provider 请求，但不能替代异常分支审查。既有报告的 Core/CLI 类型检查和根检查通过；本次只读复跑 Core 两份针对性测试：**26 通过、0 失败**。

## 1. 需求实现正确性（需求 → 实现 → 证明性测试 → 结论）

| 可验证需求 | 实现/调用链 | 证明性测试与审查结论 |
|---|---|---|
| V1 相对 glob 从会话目录到项目根；绝对 glob 在目标目录；`~/` 展开；稳定顺序与同一路径去重 | `config/plugin/instruction.ts:98-156,176-185`，`FSUtil.scan`；自动 global/project 来源先加入，再按配置条目扫描 | `instruction-discovery.test.ts` 的路径组合用例、CLI 私服首次模型请求断言通过；绝对 basename 和相对逐层扫描与 V1 实现吻合。**正常路径通过**；不可读的匹配目录被误判为删除，见发现 1。 |
| 全局及项目 AGENTS.md，项目关闭时排除项目来源 | `instruction.ts:38-95,99-106`；`Instance.layer` 的 vanilla 双节点替换 | Core 的 opt-out/路径边界测试、私服嵌套/根文件及移动测试通过；未发现正常路径的越界或重复注入。 |
| URL 读取、5 秒超时、失败保留历史值 | `instruction.ts:110-123,169-190,222` → `instruction-discovery.ts:113-118` → `InstructionState.observe` | Core 环回 URL 失败/恢复用例和私服 503 用例通过；`Effect.timeout` 包住请求与 body 读取；初次失败按仓库既定契约阻止不完整 baseline，既有值保持。**正常/503 分支通过**；真实 5 秒卡住连接的私服超时尚无证明性测试，属于验证缺口，不据此推定代码缺陷。URL 日志敏感信息见发现 3。 |
| 创建/修改/删除、配置更新和移动；状态进入持久化链路 | `instruction.ts:50-56,169-222` → `InstructionDiscovery.load` → `SessionContext.select` → `InstructionState` | Core 文件生命周期与 config.updated 用例、CLI 真实配置/移动的相邻模型请求断言通过；压缩/回退有既有 Core 状态测试，**私服压缩/回退组合未单独运行**。正常路径通过；配置 watcher 退订问题见发现 2。 |
| 全局配置/网站迁移 | 本次职责外的全局仓库和网站文件 | 仅核对三份测试报告给出的定向通过记录，不把旧安装二进制当作当前 Core 验证，也不对全局仓库另下独立结论；由并行审查负责。 |

## 2. Java 公共模块主业务影响

**不适用**：本仓库是 Bun/TS，非 Java；但对通用稳定性要求仍核查：每次 model-boundary 最多对每个配置 URL 作一次顺序 HTTP 请求，各请求含 5 秒超时；一次本地 glob 扫描与目录数量/匹配文件数成正比；Watcher 持有的 native 订阅在整个 Location/plugin scope 存活。无本次变更引入的数据库、Redis、MQ 或跨资源事务写操作；InstructionState 数据库操作沿用既有状态链路。并发多个 Session 共享同一 Location 的 refresh 锁，慢 URL 会串行化等待，URL 数量来自用户配置而无全局总时限；目前无现实负载数字，暂不虚构吞吐结论。

## 3. 依赖、兼容性与优化机会

- `HttpClient`、`glob`、`Config` 和 `Scope` 均为仓库现有依赖，无新增第三方版本或生成客户端表面；Schema→Core→Server 方向未逆转，`File.path` 改为字符串后本地路径序列化结构未变，URL 可原样作来源键。
- 现有读取策略有意在每个模型边界重新抓取 URL，本次不建议不带失效契约地缓存；也不建议把 URL 拉取异步化而改变指令可见顺序。应避免移除配置项后遗留的旧 watcher（发现 2）。未发现需要新增数据库/Redis 缓存或异步队列的适用场景。
- CLI 集成测试使用私有 HOME/XDG、临时项目、环回提供者及最终清理；断言实际模型 messages 的首次和新增更新、而非只检查配置读取。它的 `Bun.sleep(200)` 仅在已观察真实 `config.get` 切换后调用，不单独构成配置就绪证明；核心断言仍依赖随后真实请求。暂未发现可证实的私服测试假阳性。

## 4. 其他发现（已逐条对照活动代码与调用路径复核）

1. **[阻塞] 暂时不可用与删除的区分：glob 扫描会把暂不可遍历的目录当作文件删除** — 证据 `packages/core/src/config/plugin/instruction.ts:148-157,176-189`；`packages/util/src/glob.ts:23-25` 使用 npm `glob`，其实际 `node_modules/glob/dist/commonjs/walker.js:221-226` 调用 `t.readdirCB((_, entries) => ...)` **忽略 readdir 的错误**。根因是只在扫描返回的匹配文件上调用 `read`，`[]` 无论代表真正删除还是遍历目录 `EACCES`/短时网络挂载故障，都会作为成功结果进入 `loaded.current`；已有 `instruction-discovery.test.ts` 的不可读测试把 `scan` 固定为仍返回原路径，未覆盖这一分支。触发：配置 `rules/*.md` 或 `.opencode/AGENTS.md` 所在子目录暂时不能列目录，之前已经有规则；本轮 `load()`/watcher 刷新返回空匹配，`discovery.reload()` 经 `InstructionState` 发表撤销，后续模型请求失去仍实际存在的安全/项目指令。项目明确规定**暂时不可读不能误删规则**。建议给扫描增加可区分「确认无匹配」与「遍历失败」的边界（至少在已知曾匹配的路径上做存在性/错误原因核实；无法核实时标记 `Instructions.unavailable`），并用无法遍历匹配目录的用例断言保留已持久化规则；否则部署后一次权限/网络共享瞬断即可撤销指令。

2. **[阻塞] 资源生命周期：配置增删来源时 watcher 永不退订** — 证据 `packages/core/src/config/plugin/instruction.ts:48-56,98-108,139-148,209-222`；`packages/core/src/plugin.ts:108-120` 对相同 plugin ID/revision 的配置重新激活保留原作用域，故单纯 `config.updated` 不会清空 `watched`。根因：`watched.add(key)` 后 `Effect.forkIn(scope, ...)` 只随整项插件/Location scope 关闭；新的 configured pattern 在 `refresh()` 时不断添加监控，删除/替换 pattern 没有相应删除或关闭；`Watcher.nativeLayer` 对 file 使用 `fs.watch`、对 directory 使用 native recursive 订阅。触发：长时间开启某项目的服务，多次修改配置，把 `instructions` 逐次切换到不同本地路径；每个不同文件/目录（相对 glob 还乘以祖先目录数）额外保留 watcher/句柄及回调，即使只保留最后一个当前来源；旧路径的事件还继续触发全量刷新。增长随历史不同 watch key 数无界，只有最终销毁 Location 才释放，持续编辑最终可耗尽系统 watcher/句柄并损害当前有效规则的更新。建议像 `Config.reconcileWatches` 那样对每次配置来源计算当前 watch plan，并释放不再使用的订阅（保留自动 AGENTS watch），增加连续配置切换后活跃订阅数量保持有界的测试；否则真实长驻私服无法靠即时配置刷新自愈。

3. **[应改] 敏感信息：失败日志直接记录完整的配置 URL** — 证据 `packages/core/src/config/plugin/instruction.ts:110-118`；支持 HTTP(S) 输入，常见带 `?token=...` 的签名规则 URL 在 503、网络失败或 5 秒超时后以 `source: pattern` 原文进入 warning 日志（`cause` 也可能含 URL）；`InstructionDiscovery.render` 在 `packages/core/src/instruction-discovery.ts:133-135` 还把原始 URL 标识送进模型上下文。触发：用户把私有远端规则作为 URL 指令来源并通过查询串鉴权；一次短暂故障就把可复用 URL/token 落进服务日志，而成功路径也暴露给模型供应商及持久化 instruction blob。这与通用基线的「不打印密钥/token」相冲突；V1 的来源显示语义不足以批准新原生持久化对凭证的明文传播。建议 URL 仍使用完整字符串作内部稳定键，但输出/日志显示去除 userinfo 和敏感 query（必要时用不含凭证的稳定别名），对签名 URL 的失败日志及模型请求加回归测试；否则日志读者和模型提供方可取得凭证。若需求明确允许完整 URL 对外可见，应在配置契约中明确声明并按已批准风险决定是否保留。

### 复核与剩余风险

- 发现 1 的 `glob` 忽略目录 readdir 错误、发现 2 的 watcher 持有路径及插件稳定代际、发现 3 的原样 URL 输出均为**活动代码**，并非注释或测试桩；已排除已有测试覆盖的「扫描已找到文件但读取失败」和既定「初始不可用阻塞 baseline」两个不同场景。
- 尚无本审查新增的测试代码；5 秒超时仅静态确认 `Effect.timeout`，没有执行故意挂起服务器的私服端到端用例。私服压缩/回退组合亦未实测；不把上述测试空白冒充已证明的代码错误。

**汇总：阻塞 2 项，应改 1 项；总体结论：需修改后重审。**
