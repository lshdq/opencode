# 测试报告：V2 原生 Instructions（DEC-007 独立复测）

## 范围与环境

- 依据：`需求-V2原生Instructions.md`、`测试用例-V2原生Instructions.md`、决策记录 DEC-007、上一轮审查修复后独立测试报告。
- 本轮仅修正 Core 既有 userinfo URL 测试对 HTTP Basic 的超范围断言，保留整条测试：确认请求抵达隔离环回 HTTP 服务器并携带查询串、所有实际请求均未意外添加 Authorization、初始来源说明/状态不包含用户名、密码、查询令牌、fragment 四个私密标记。
- 环境：Windows，Bun 1.3.14；当前未提交的 V2 Core/CLI 工作区源码；隔离 `127.0.0.1` HTTP 与 CLI 私有服务、fake provider。不接入或重启共享服务；无部署制品，预期与实际均为当前工作区源码；私有 HTTP 集成用例启动并完成，环境就绪。

## 单元测试

| 目录 | 命令 | 结果 |
|---|---|---|
| `packages/core` | `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts test/session-instructions.test.ts` | **38 通过、0 失败、0 跳过、217 次断言**；其中修正后的 userinfo 用例通过 |

本轮没有新增测试方法；修正 1 条既有用例的名称和断言。TC-001/002 的来源/去重、TC-003 的 URL 加载/刷新/失败保留/脱敏、TC-004 的文件生命周期、glob 故障、watcher 切换以及 TC-005 的指令状态单测均已在该组执行。上轮历史失败不计入本轮最终结果。

## 集成/接口测试与静态检查

| 用例/检查 | 目录与命令 | 结果 |
|---|---|---|
| TC-001～005 私有 V2 HTTP 会话、真实模型请求与跨项目移动（含签名 URL 来源） | `packages/core`: `bun test ../cli/test/instructions-http.test.ts --timeout 180000` | **1 通过、0 失败、134 次断言**；私有服务与 fake provider |
| Core 类型检查 | `packages/core`: `bun typecheck` | 通过 |
| CLI 类型检查 | `packages/cli`: `bun typecheck` | 通过 |
| 差异空白检查 | 仓库根：`git diff --check` | 通过 |

## 测试代码变更（本轮全部）

| 所属仓库 | 测试文件绝对路径 | 类型 |
|---|---|---|
| `D:\works\thirdparty\opencode` | `D:\works\thirdparty\opencode\packages\core\test\instruction-discovery.test.ts` | 修改既有测试名称及断言 |

本轮新增测试文件：无。生产代码、CLI 测试、全局配置及需求/用例文档修改：无；另仅新增本测试报告（非测试代码）。

## 总结与边界

- 本轮最终合计：**39 通过、0 失败、0 跳过；351 次断言，通过率 100%**。失败用例：无；阻塞项：无。
- DEC-007 边界：支持签名查询串 URL 的读取与来源脱敏，但不会把 URL userinfo 自动转成 HTTP Basic Authorization；需要 HTTP Basic 的规则 URL 不属于本次兼容/认证承诺。
- 未执行：TC-006 外部全局配置迁移与测试（本轮仅允许改动单个 Core 测试，交父流程已有独立验证）；真实 5 秒网络超时、真实系统权限故障、私服压缩/回退端到端（本次为单条错误断言修正，已有测试层覆盖相关状态/可控故障）；根 `bun run check`（按委派由父任务执行）。
