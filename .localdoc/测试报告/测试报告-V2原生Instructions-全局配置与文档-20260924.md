# 测试报告：V2 原生 Instructions（全局配置与文档）

## 测试范围与环境

- 依据：`.localdoc/需求文档/需求-V2原生Instructions.md`、`.localdoc/测试用例/测试用例-V2原生Instructions.md`、`.localdoc/审查记录/审查范围-V2原生Instructions-20260924095636.md`。
- 本轮承担通用/框架中的**全局配置迁移与网站文档**验证；核心真实会话请求及完整指令生命周期由并行的阶段 6 独立测试负责，不将配置解析等同于模型上下文断言。
- 环境：本地，无部署和模型请求；隔离私有服务使用独立 HOME/XDG 状态、真实全局配置，`prompt(..., resume: false)` 只入队不执行模型；没有重启共享服务。
- 预期制品：工作区 `D:\works\thirdparty\opencode` 当前未提交实现、全局配置 `C:\Users\lshdq\.config\opencode` 当前文件。集成测试默认调用 `PATH` 上 `D:\Program\opencode\opencode.exe`（`OPENCODE_TEST_BINARY` 未设置），因此其服务运行时**不证明**使用了本工作区 Core 代码；本工作区 Core 单测直接运行源码。就绪状态：私有服务握手与 API 请求通过。

## 单元测试

| 命令（工作目录） | 结果 |
|---|---|
| `bun run typecheck`（全局配置仓库） | 通过 |
| `bun test ./test/migration-config.test.ts ./test/global-plugin.integration.test.ts`（全局配置仓库） | 5 通过，0 失败，156 次断言（其中迁移静态检查 4 例，私有服务集成检查 1 例） |
| `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts`（`packages/core`） | 25 通过，0 失败，95 次断言；涵盖路径、glob、URL、故障保留、更新和状态基础能力 |

单元测试合计：29 通过、0 失败、0 跳过（不重复计入其中的 1 条私有服务集成用例）；本轮补充测试：0 条，已有持久化测试覆盖本轮职责。完整会话级用例由另一独立测试负责。

## 集成测试/接口测试

| 用例编号 | 名称 | 结果 | 备注 |
|---|---|---|---|
| TC-006 | 全局配置与插件迁移 | 通过 | `bun run test:integration`（全局仓库）：1 通过，0 失败，66 次断言；私有服务加载真实全局文档，返回 `instructions: [".opencode/AGENTS.md"]`、无 `plugins`，非内置插件为空；自定义 agent、skills、references 和权限断言通过。只入队，不发送模型请求。 |
| TC-001～TC-005 | 原生来源和真实会话生命周期 | 部分覆盖，待独立测试 | 本轮运行 Core 来源/状态测试 25 例；模型可见上下文、移动、压缩、回退及工作区源码实际私有服务运行不在本子任务验证范围。 |

## 文档与迁移边界验证

| 项目 | 结果 | 依据 |
|---|---|---|
| 全局配置改动隔离 | 通过 | 与 `D:\temp\systemp\opencode\instructions-baseline-20260924095636\opencode.jsonc` 逐文件比较：仅移除失效说明及 `plugins: ["./extensions/server"]`，新增 `instructions: [".opencode/AGENTS.md"]`；原有 default_agent、update、references、permissions、agents 未变。 |
| 孤儿测试脚本及桥接清理 | 通过 | `package.json` 与原样快照比较只改 `test:integration` 指向现存 `test/global-plugin.integration.test.ts`；`extensions/server/index.ts`、`v1-compat.ts` 与两个 `v1-compat` 测试现均不存在；活跃配置、脚本、文档无旧插件/脚本引用。迁移测试文件与各自快照比较，只有预期断言更新。 |
| 网站文档 | 通过 | `services/www/src/docs/content/{config,instructions}.mdx` 存在，记录 instructions 的文件/glob/HTTP(S)、相对及家目录解析和更新规则；活跃文档不再称 V2 不加载 instructions。 |
| `bun typecheck`（`services/www`） | 通过 | Astro check：29 文件，0 error/warning/hint。 |
| `bun run check:generated`（`services/www`） | 通过 | 生成资源检查无差异。 |
| `bun run build`（`services/www`） | 通过 | 构建、Pagefind（52 页）和链接校验通过。 |

## 未执行项、风险与结论

- 本轮未重跑外部仓库全量 `bun run check`：父任务已运行，`typecheck` 与本次迁移相关测试通过，之后在**未修改且本轮范围外**的 `test/launcher.test.ts` 出现多个 model 参数断言失败并于 120 秒超时；原始失败仍是全量门禁未通过，不能称之为全面成功，交父任务决定。
- 根目录 `bun run check` 由父任务负责；本轮未重复。`packages/core` 的 `bun typecheck` 与真实请求完整生命周期由并行测试/父任务核验。未对真实收费模型发请求。
- 本轮测试代码新增或修改：**无**（两个仓库均无）。本轮仅新增本报告，路径：`D:\works\thirdparty\opencode\.localdoc\测试报告\测试报告-V2原生Instructions-全局配置与文档-20260924.md`。
- 总结：本轮职责内 30 条定向执行记录（29 单元/静态 + 1 私有服务集成）全部通过；工作区源码的端到端模型上下文和外部全量门禁不在本报告内宣称通过。当前无本轮测试新发现的生产缺陷；全量门禁既有失败与源码集成局限交父任务处理。
