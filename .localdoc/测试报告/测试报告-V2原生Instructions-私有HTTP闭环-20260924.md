# 测试报告：V2 原生 Instructions（阶段 6，第二轮独立测试）

## 范围、环境与制品

- 需求：`.localdoc/需求文档/需求-V2原生Instructions.md`；用例：`.localdoc/测试用例/测试用例-V2原生Instructions.md`；本报告补充首轮报告中缺失的私有服务真实闭环，不替代首轮全部单元测试记录。
- 框架/接口测试环境：Windows、Bun 1.3.14；直接从**当前未提交工作区**执行 `bun --cwd packages/cli src/index.ts serve --stdio --hostname 127.0.0.1 --port 0`（测试用 `process.execPath` 指向 Bun），解析私有 stdout 握手 URL，经 `@opencode/client` 发起 `session.create`、`session.prompt`、`session.wait`、`session.move`。未调用已安装的 `opencode.exe`，未连接或重启共享服务。
- 每次测试在 `D:\temp\systemp\opencode` 下创建隔离目录，单独设置 HOME、USERPROFILE、XDG_CONFIG_HOME、XDG_DATA_HOME、XDG_STATE_HOME、XDG_CACHE_HOME、OPENCODE_CONFIG_DIR、TEMP/TMP 及私有密码；两个独立 `git init` 项目；Bun.serve 仅绑定 127.0.0.1，分别响应规则 URL 与 OpenAI-compatible 模型请求。无付费提供者和真实用户配置；结束时终止私服、停止 fake provider、清理临时目录。
- 预期制品/实际制品：当前仓库未提交的 V2 CLI + Server + Core 源码；就绪：私有 HTTP 服务握手、SDK 调用与模型请求捕获均通过。未经构建/部署的二进制不作为验证对象。

## 执行与结果

| 执行目录 | 命令 | 结果 |
|---|---|---|
| `packages/core` | `bun test ../cli/test/instructions-http.test.ts test/instruction-discovery.test.ts test/instruction-state.test.ts test/session-instructions.test.ts --timeout 180000` | **34 通过、0 失败，180 断言**，含 1 条新增真实 CLI/HTTP 集成测试及原有 Core 单元/组件测试 |
| `packages/core` | `bun test test/session-runner.test.ts --test-name-pattern 'moves the epoch at compaction and narrates later changes'` | **1 通过、0 失败，209 条因模式过滤，7 断言**；命中压缩指令 epoch 测试 |
| `packages/core` | `bun test ../cli/test/instructions-http.test.ts --timeout 180000` | 最终单独复跑 **1 通过、0 失败，49 断言**（含此前的连续成功复跑）；约 27 秒 |
| `packages/core` | `bun typecheck` | 通过，`tsgo -b tsconfig.json tsconfig.tests.json` |
| `packages/cli` | `bun typecheck` | 通过，`tsgo --noEmit` |

最终测试去重统计：**35 条通过、0 失败**（34 条集合 + 1 条独立 runner 压缩用例）；新增持久化测试 **1 条**。其中 `209 filtered out` 是使用名称过滤执行 runner 测试的预期行为，不是失败或产品跳过。

### 集成/接口验收

| 用例 | 结果 | 可核验证据与边界 |
|---|---|---|
| TC-001 近到远及越界 | **通过** | 首次私服模型请求的 system/developer 消息中，嵌套 `.opencode/AGENTS.md` 标记 `NESTED_RULE_ONE` 在项目根 `.opencode/AGENTS.md` 标记 `ROOT_RULE_ONE` 前，各仅 1 次；另一项目 `OTHER_RULE_ONE` 不在首次请求。普通 `AGENTS.md` 的 `BUILTIN_RULE_ONE` 仅 1 次。 |
| TC-002 绝对 glob、`~/` 与去重 | **通过** | 同一首次请求包含绝对 glob 的 `ABSOLUTE_RULE_ONE`、home 展开的 `HOME_RULE_ONE`，各 1 次；配置 `.opencode/AGENTS.md` 与自动发现同一路径重合时近、远标记仍各仅 1 次。 |
| TC-003 URL 更新、失败 | **通过（超时分支未单独测）** | 本地 HTTP `/instructions` 首次 `REMOTE_RULE_ONE` 在 system/developer 消息仅 1 次；响应改为 `REMOTE_RULE_TWO` 后模型新增 user 指令更新包含新值；改为 503 后后续请求保留此前值且新增消息没有误撤销。已有 `instruction-discovery.test.ts` 的 URL 刷新/故障保留测试也通过。**未真实等待 5 秒超时**，仅验证失败响应路径；超时是剩余风险。 |
| TC-004 创建/编辑/删除与配置变化 | **通过（短暂文件故障由组件测试覆盖）** | 同一活动 Session 模型请求新增 user 指令依次看到 `DYNAMIC_RULE_CREATED`、`DYNAMIC_RULE_EDITED`、删除撤销；嵌套 `.opencode/AGENTS.md` 更新为 `NESTED_RULE_TWO`、删除撤销、再创建 `NESTED_RULE_THREE`；修改隔离全局 `opencode.json` 的 instructions 数组添加 `config-new.md`，等待实际 `config.get` 观察到新配置后模型新增 user 指令出现 `CONFIG_RULE_NEW`。现有 discovery 用例覆盖文件暂不可读时保留已加载值，非本私服脚本的真实 EISDIR 注入。 |
| TC-005 跨项目移动、持久化边界 | **通过（压缩由已有 Core 用例覆盖）** | 对同一真实 Session 调用 SDK `session.move` 到另一个 git 项目，后续模型请求的**新增 user 更新**出现 `OTHER_RULE_ONE`，对旧嵌套、旧根 `.opencode/AGENTS.md`、普通 `AGENTS.md`、旧项目 `config-new.md` 四个路径分别断言 `no longer apply`；新增更新不再包含旧规则正文。`session-runner.test.ts` 的“moves the epoch at compaction and narrates later changes”用例实际执行并通过，`session-instructions.test.ts` 的“re-injects nested instructions dropped from history by compaction”亦在 34 条中通过。私服未主动执行模型压缩/回退，本项将**私服跨项目移动**与 **Core 持久化压缩边界**联合验收，不声称单条 HTTP 测试覆盖两者。 |
| TC-006 全局配置迁移 | **未执行（职责外）** | 禁止修改/测试既有全局配置目录与外部仓库；交父流程处理。 |

模型协议证据：私服不是 mock runner；`Bun.serve` 收到 OpenAI-compatible `/v1` JSON `messages`，首次请求按 role 筛选 system/developer 断言；生命周期后续更新按消息 role=user 断言**相邻请求新增消息**，避免把旧历史误判为更新成功。这样符合会话初始规则与后续持久化更新的真实请求表示。

## 技术障碍与处置

1. 首次实际尝试执行上述私服命令时，显式设置 `OPENCODE_DB=<临时根>/opencode.db` 导致启动失败：`Unsafe custom SQLite directory: configure a protected current-user FullControl (OI)(CI) ACL or use the default database location; no directory permissions were changed`。取消自定义 DB 路径，改用已隔离的 XDG_DATA_HOME 下应用自有默认 DB（自动私有 ACL）后握手/HTTP 流程成功；未降低生产数据库权限检查、未编辑生产代码。
2. 最初测试错误地把**后续**指令更新限定为 system/developer，实际模型请求的时间顺序更新位于 role=user；改为首次检查 system/developer、后续检查新增 user 消息。配置文件 watcher 存在异步时差，使用 `config.get` 观察真实重载完成并短暂等待 discovery 通知后发起请求；无固定假成功断言。

## 变更与未执行事项

| 所属仓库 | 测试文件绝对路径 | 本轮变更 |
|---|---|---|
| `D:\works\thirdparty\opencode` | `D:\works\thirdparty\opencode\packages\cli\test\instructions-http.test.ts` | **新增**持久化私有 CLI/HTTP、fake provider 和跨项目指令集成测试 |

- 本轮其他新增或修改测试文件：**无**；`packages/core/test/instruction-discovery.test.ts` 及 `session-runner.test.ts` 的工作区改动属于父任务/第一轮，本轮仅运行、不编辑。
- 本轮生产代码修改：**无**。本轮另新增本测试报告（非测试代码）。
- 未执行根 `bun run check`：父流程负责；未执行全局配置仓库的隔离验证与 TC-006：当前职责禁止访问/修改既有全局配置。未真实验证 HTTP 5 秒超时、真实文件暂不可读的**私服**请求及私服压缩后重载；对应可执行组件/runner 测试已运行，剩余端到端差异风险仍需如实保留。

**结论**：首轮报告指出的“原生配置来源 → 私服真实 SessionRunner → fake provider 模型请求”与两个真实项目 `session.move` 缺口已由可重复的持久测试补齐；此次没有发现生产缺陷。TC-001～005 的已列组合用例均通过，TC-003 超时独立分支和 TC-005 私服压缩端到端仍是未执行细分项；TC-006 不在本测试任务权限范围。阻塞项：**无**（对当前唯一目标）；全局迁移验收由父流程负责。
