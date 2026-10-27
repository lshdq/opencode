# 测试报告：V2 原生 Instructions（DEC-008/009 二次修复独立复测）

## 范围、环境与制品

- 依据：`.localdoc/需求文档/需求-V2原生Instructions.md`、`.localdoc/测试用例/测试用例-V2原生Instructions.md`、DEC-008/009 和上轮独立复审报告。
- Windows / Bun 1.3.14；测试当前未提交的 V2 Core、Util、CLI 工作区源码，无部署。预期与实际制品均为本工作区源码（不是已安装的共享服务）。
- 集成测试实际启动 checkout 中 `packages/cli/src/index.ts serve --stdio --hostname 127.0.0.1 --port 0` 私有子进程，使用临时 HOME、XDG、配置、SQLite 和 `127.0.0.1` fake provider。成功建立 HTTP Session、执行 prompt/wait/move 并读取模型请求及本地 SQLite；结束后释放子进程与临时资源。未访问付费模型或接入、重启共享后台服务。环境就绪：通过。

## 单元测试

| 工作目录 | 命令 | 结果 |
|---|---|---|
| `packages/util` | `bun test test/glob.test.ts` | **1 通过 / 0 失败 / 0 跳过；10 次断言**。真实 `glob`/path-scurry 异步 readdir 注入 EACCES：原 glob 吞错返回空，`Glob.scanChecked` 报错；ENOENT、ENOTDIR、缺失目录、无匹配和真实删除返回空；原 `Glob.scan` 的正常匹配及删除语义不变。 |
| `packages/core` | `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts test/session-instructions.test.ts` | **41 通过 / 0 失败 / 0 跳过；243 次断言**。覆盖冷插件初次 glob 失败、故障期 watcher 协调、URL 失败保留与脱敏、状态与会话指令已有回归。 |

本阶段补充：Core 新增 1 条真实投影状态用例：先用旧插件将规则写入 Session 的 `instruction_state`/blob，关闭插件 scope，构建新插件并在它**第一次**扫描时通过真实 `Glob.scanChecked` 的 readdir 回调注入 EACCES；使用 `InstructionState.preview`（模型请求组装前的状态观察/渲染边界）读取数据库投影，断言旧规则仍可见、无撤销；提交失败观察后投影哈希不变；恢复读取后规则更新，真正删除后预览出现撤销并提交至空 current_values。此前仅以手工 `state(previous.values)` 模拟旧状态的测试不能替代本条。Util 既有测试补 ENOTDIR、删除和原扫描对照断言。

## 集成/接口测试与静态检查

| 用例 / 检查 | 工作目录与命令 | 结果 |
|---|---|---|
| TC-001～005：私有 V2 HTTP Session 到真实 fake-provider 模型消息、URL/本地规则、文件与配置变更、失败保留、签名 URL 脱敏、跨项目 move | `packages/core`: `bun test ../cli/test/instructions-http.test.ts --timeout 180000` | **1 通过 / 0 失败 / 0 跳过；134 次断言**，约 24 秒。CLI 测试文件为此前新增、目前仍未跟踪；本阶段未改。 |
| Util 类型检查 | `packages/util`: `bun typecheck` | 通过（`tsgo --noEmit`）。 |
| Core 类型检查 | `packages/core`: `bun typecheck` | 通过（`tsgo -b tsconfig.json tsconfig.tests.json`；新增测试后复跑）。 |
| CLI 类型检查 | `packages/cli`: `bun typecheck` | 通过（`tsgo --noEmit`）。 |
| 工作区差异空白检查 | 仓库根：`git diff --check` | 通过。 |
| 仓库全量 lint/typecheck | 仓库根：`bun run check` | **本阶段补充重跑通过**；oxlint 0 错误/0 警告，Turbo typecheck 35/35 包通过（约 1 分 14 秒）。这不是在仓库根执行 `bun test`。 |

## 本阶段测试代码变更（所属仓库：`D:\works\thirdparty\opencode`）

| 文件绝对路径 | 本阶段变更类型 |
|---|---|
| `D:\works\thirdparty\opencode\packages\core\test\instruction-discovery.test.ts` | 修改既有测试文件，新增 1 条持久化 Session 投影 / 冷插件故障 / 恢复及删除用例 |
| `D:\works\thirdparty\opencode\packages\util\test\glob.test.ts` | 修改工作区先前新增、当前未跟踪的测试文件；补原 Glob.scan、ENOTDIR、真实删除断言 |

`D:\works\thirdparty\opencode\packages\cli\test\instructions-http.test.ts` 为此前已新增、目前未跟踪的集成测试文件，本阶段完整读取并执行、**未修改**。本阶段仅另新增本报告；生产代码、网站和外部配置修改：无。

## 结论与限制

- 本阶段最终合计 **43 通过、0 失败、0 跳过；387 次断言，通过率 100%**。失败用例：无；环境阻塞：无；发现需返回生产修复的缺陷：无。
- DEC-008：可控 EACCES/ENOENT/ENOTDIR 的 glob/path-scurry 路径和 Core **真实 Session 投影 + 重建插件**的模型组装预览通过。Core 的测试数据库生命周期跨插件重建、使用真实投影读写，但**不是操作系统进程重启后重新打开磁盘 SQLite**；私服确实执行了真实 HTTP Session/SQLite/模型请求，但未在私服进程里注入 readdir 故障，也未做实际进程重启。不能宣称端到端重启+内核权限故障已验证。
- DEC-009：Core 用可控 Watcher 事件、活跃订阅数与环回 503 验证 A→[B/其他本地规则,失败 URL] 期间旧路径不触发重抓、新路径触发、历史值保留、恢复后正确更新；未用 OS 原生 watcher 句柄或真实系统权限故障直接测量。
- DEC-007：userinfo URL 不自动生成 HTTP Basic；签名查询串可用于请求，来源显示和持久化标识仍脱敏。需要 HTTP Basic 的远端不在本次认证承诺范围。
- 未执行：TC-006 外部全局配置迁移独立复跑，私服压缩/回退端到端与真实 5 秒挂起超时、真实 OS 权限拒绝/进程重启故障注入。原因分别为本轮委派仅 Core/Util/CLI 测试范围，以及现有私有服务 fixture 不提供服务内 readdir 故障入口；不要将现有单元/投影覆盖描述为这些路径的端到端通过。
