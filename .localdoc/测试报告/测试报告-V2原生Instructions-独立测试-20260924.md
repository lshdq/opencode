# 测试报告：V2 原生 Instructions（阶段 6 独立测试）

## 范围及环境

- 需求：`.localdoc/需求文档/需求-V2原生Instructions.md`；用例：`.localdoc/测试用例/测试用例-V2原生Instructions.md`。
- 场景：框架代码，当前工作区 Core；Windows/Bun；使用 `testEffect` 的隔离测试层、临时文件/数据库、环回 `Bun.serve` 和 `TestLLM` fake provider。不连接、不重启共享服务；不访问外部 URL。
- 预期制品/实际制品：当前工作区源码（未构建部署）；就绪状态：上述测试层就绪。独立 V2 CLI 私有进程**未启动**，不能把单元测试层解释成真实 CLI/HTTP 服务验收。
- 对照代码：真实 `ConfigInstructionPlugin`/`InstructionDiscovery` 用例验证来源；已有 `SessionRunnerLLM` 用例以 fake provider 验证模型请求及通用指令状态，但它把 `InstructionDiscovery.Service` 替换为 mock。故“**原生配置来源 → 真实 SessionRunner 模型请求**”端到端闭环以及不同 Location 的移动仍未获得验证，不应报为通过。

## 单元测试

| 执行目录 | 命令 | 结果 |
|---|---|---|
| `packages/core` | `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts` | 最终通过：26/26，0 失败 |
| `packages/core` | `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts test/session-instructions.test.ts` | 最终通过：33/33，0 失败，131 次断言 |
| `packages/core` | `bun test test/session-runner.test.ts test/session-instructions.test.ts` | 通过：217/217，0 失败，1060 次断言；在补充用例前运行，之后未修改生产代码或此文件 |
| `packages/core` | `bun typecheck` | 最终通过（`tsgo -b tsconfig.json tsconfig.tests.json`） |

- 最终去重统计：243 条通过、0 条仍失败、0 条跳过（33 条与 217 条中有 7 条 `session-instructions` 重合）。新增持久化测试：1 条；增强 URL 故障断言：1 条。
- 迭代中新增用例曾期望删除最后一份规则时返回路径级撤销提示，实际返回现有通用提示 `Previously loaded instructions no longer apply.`；对照当前 `InstructionDiscovery` 的空列表渲染契约后修正用例，重跑通过。此为测试预期错误，非生产缺陷。
- 曾尝试把真实发现服务直接替换进现有 runner 测试夹具；因夹具使用虚拟 Location 且缺少对应真实激活上下文，试跑在首次请求报 `Instructions.InitializationBlocked: core/instructions`，并产生测试夹具类型错误。未把这一试验当作产品缺陷；已经**全部撤销**该夹具改动，最终 `bun typecheck` 和上述测试通过。仍须用正确的隔离 Location/服务夹具补全端到端验证。

## 集成测试/接口测试：用例结果

| 用例 | 状态 | 已核验证据与剩余缺口 |
|---|---|---|
| TC-001 近到远 | **部分通过** | 真实目录中的 `.opencode/AGENTS.md` 近远顺序及路径去重由 discovery 测试覆盖，越界文件排除；未在同一个实际 runner 模型请求中检查这些来源。 |
| TC-002 绝对 glob、`~/`、去重 | **部分通过** | 同一目录测试验证绝对 glob、home 展开及与自动 AGENTS 重合路径仅注入一次；尚无这些配置来源的真实模型请求断言。 |
| TC-003 URL 更新及失败 | **部分通过** | 独立环回 HTTP 服务测试初次、更新、已更新规则故障保留及恢复不重发；`discovery.load()` 刷新边界有效。未验证 URL 规则出现在实际 runner 模型请求，也未覆盖真实超时 5 秒情形。 |
| TC-004 创建、编辑、删除、配置变化 | **部分通过** | 新增 `instructions.md` 从缺席→创建→编辑→删除→重建的持久用例；已有 `config.updated` 改来源、读取短暂失败保留测试通过。尚未通过同一活动 Session 模型请求及持久化状态联动验证这些变化。 |
| TC-005 移动、压缩、回退 | **部分通过** | 通用 runner fake provider 用例验证指令持久化及移动中断、压缩/回退/epoch；并非两处真实项目配置/嵌套规则的 Session.move 端到端切换，未验证旧规则撤销和目标规则生效。 |
| TC-006 全局配置迁移 | **未执行** | 本次职责明确禁止触及全局外部仓库与服务；本仓库隔离测试不构成全局配置迁移验收。 |

## 测试代码变更

| 所属仓库 | 文件 | 变更 |
|---|---|---|
| `D:\works\thirdparty\opencode` | `D:\works\thirdparty\opencode\packages\core\test\instruction-discovery.test.ts` | 修改：新增文件全生命周期回归用例，强化 URL 故障发生在已更新值之后的保留断言；同一文件此前已有父任务未提交变动，未改写生产文件 |

其他新增/修改测试文件：**无**。生产代码修改：**无（本测试智能体）**。报告文件：本文件（非测试代码）。

## 未执行项与结论

- 未启动私有 V2 CLI `serve --stdio --port 0`：要在私有服务里以 fake provider 捕获实际模型请求及真实跨 Location 移动，现有 runner 测试虚拟 Location 夹具不适用，未在本次迭代建立完整私有服务/提供者夹具。不得据此宣布 TC-001～005 的模型端到端验收完成。
- 未执行根目录 `bun run check`：按父任务明确分工由父智能体执行；未使用仓库根目录跑测试。外部全局配置仓库的 `bun run check` 与其隔离集成测试未执行：明确禁止触及该仓库。
- 最终自动化命令无失败；实质阻塞：TC-001～005 尚缺真实配置到模型请求的闭环及移动项目切换，TC-006 归属父任务/外部阶段。建议父任务补齐这些覆盖后再判定整体验收；不可仅凭现有 243 条单元/runner 测试判定需求全部通过。
