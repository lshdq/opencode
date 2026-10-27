# 测试报告：V2 原生 Instructions（审查修复后，全新独立阶段 6）

## 范围、环境与制品

- 依据：`.localdoc/需求文档/需求-V2原生Instructions.md`、`.localdoc/测试用例/测试用例-V2原生Instructions.md`、DEC-004～006。针对**本轮未提交** V2 Core/CLI 工作区源码测试；旧报告只作背景，不作为本轮通过证据。
- 环境：Windows、Bun 1.3.14；Core 使用 Effect 测试层、真实临时文件、环回 HTTP 与路径过滤测试 watcher；CLI 集成测试通过当前 `packages/cli/src/index.ts serve --stdio --port 0` 启动**私有服务**，隔离 HOME、USERPROFILE、OPENCODE_CONFIG_DIR、XDG_CONFIG/DATA/STATE/CACHE、TEMP/TMP、私有密码和两个 git 项目。fake provider 只监听 `127.0.0.1`，不使用收费模型、不接触共享后台服务；测试结束关闭子进程、HTTP server 并清理临时目录。
- 预期/实际制品：当前未提交源码（不是已安装二进制）；私服握手、SDK `session.create/prompt/wait/move`、OpenAI-compatible 模型请求与临时 SQLite 数据均已确认就绪。

## 执行命令与单元测试

| 执行目录 | 命令 | 本轮结果 |
|---|---|---|
| `packages/core` | `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts`（修改前） | **30 通过，0 失败**；基线复核，不作为最终结果 |
| `packages/core` | `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts`（新增 userinfo 网络断言前） | **31 通过，0 失败**，证明新增基础来源/隐私断言可运行 |
| `packages/core` | `bun test test/instruction-discovery.test.ts --test-name-pattern 'loads a URL containing userinfo'` | **0 通过，1 失败**：userinfo Basic Authorization 未发送 |
| `packages/core` | `bun test test/instruction-discovery.test.ts test/instruction-state.test.ts test/session-instructions.test.ts`（最终） | **37 通过，1 失败，213 断言**；失败同上；其余 glob/watcher/URL、状态与会话指令用例通过 |
| `packages/core` | `bun test test/session-runner.test.ts --test-name-pattern 'moves the epoch at compaction and narrates later changes'` | **1 通过，0 失败**；209 条按名称过滤、不计失败 |
| `packages/core` | `bun typecheck` | 通过（最终测试修改后） |
| `packages/cli` | `bun typecheck` | 通过（最终测试修改后） |
| `packages/core` | `bun test ../cli/test/instructions-http.test.ts --timeout 180000`（最终） | **1 通过，0 失败，134 断言**；测试修改前也先复跑原私服用例 1 通过 |
| 仓库根 | `git diff --check` | 通过 |

最终去重统计：**40 条，39 通过，1 失败，0 跳过**（runner 的 209 条仅被名称筛选）。本轮新增持久化测试方法 1 条；现有测试中增补多处断言和真实私服 HTTP 交互。根 `bun run check` 已由父流程在生产修复后通过，本子任务未重跑，不能把先前结果当作本轮修改后检查。

## 集成/接口与审查修复重点

| 用例/边界 | 结果 | 本轮证据 |
|---|---|---|
| TC-001/002 来源和去重 | **通过** | 私服首次真实模型请求包含嵌套与根 `.opencode/AGENTS.md`、本地绝对 glob、`~/`，各指令只出现一次；项目外来源未混入。 |
| TC-003 URL 生命周期与签名秘密 | **部分通过，userinfo 鉴权失败** | 私服模型请求的初始、URL 更新、长文本 diff、撤销均断言真实相邻请求的新增消息；503 不误撤销。带 userinfo、`?token=`、`#fragment` 的 URL 查询串抵达环回规则服务器，模型消息及临时 SQLite `instruction_blob.hash/value`、`instruction_state.initial_values/current_values` 均不含上述四类明文标记；Core 单测验证两个不同 URL 的两个不透明来源键、更新/撤销/diff 标签和 warning 脱敏。**额外发现** HTTP server 从未收到 userinfo 对应的 Basic Authorization，详见下方阻塞项。fragment 按 HTTP 规范不会上传，但参与来源身份哈希。 |
| TC-004 glob 静默失败和 watcher | **通过** | 匹配曾存在时将 `FSUtil.scan` 固定为 `[]`，文件实际仍存在则保持已加载指令；删除后模拟匹配目录不可读时仍保持；可遍历时确认删除会撤销。连续 12 次同一 Location 配置来源替换，活跃订阅回到固定值且峰值不增长；向移除的旧路径发事件并等待超过 debounce，不增加扫描；新路径事件刷新指令。其余创建、编辑、删除、重建与配置更新在私服真实模型请求中通过。 |
| TC-005 项目移动和压缩边界 | **通过（不同测试层）** | 私服同一 Session 移动到另一个真实项目后，模型新增更新包含目标指令并撤销原项目来源；Core `session-instructions` 和筛选 runner 用例验证压缩边界。私服未单独执行压缩/回退组合。 |
| TC-006 外部全局配置迁移 | **未执行，职责外** | 本轮未修改/验证外部全局仓库，交父流程现有独立验证。 |

## 失败与影响

`packages/core/test/instruction-discovery.test.ts` 用例 **“loads a URL containing userinfo without exposing the credentials in the initial source”**：配置 `http://fixture-user:fixture-password@127.0.0.1:<port>/rules?token=fixture-token#fixture-fragment`，成功从私有服务器取回 `PRIVATE_REMOTE_RULE`，初始渲染脱敏且服务器收到 query；然而服务器观察到两次请求的 `Authorization` 都是空字符串，期望的 Basic `fixture-user:fixture-password` 未发送，测试断言失败（当前文件约第 411 行）。这不是泄漏，但 Basic-auth-only 指令源会返回 401，从而在初始上下文不可用、后续保留旧值；签名查询参数来源不受该问题影响。是否接受“不承诺 userinfo 用于 HTTP Basic 身份验证”应由父流程根据“仍按原 URL 请求”的 DEC-006 契约决定；若要求 URL userinfo 的通常网络语义，则是生产缺陷，需由父流程修复并复测。**本测试智能体未修改生产代码，也未绕过或跳过失败断言。**

## 本轮测试代码变更（全部）

| 所属仓库 | 测试文件绝对路径 | 本轮类型 |
|---|---|---|
| `D:\works\thirdparty\opencode` | `D:\works\thirdparty\opencode\packages\core\test\instruction-discovery.test.ts` | 修改既有测试：签名 URL fragment/真实 userinfo 加载与 Basic 鉴权、legacy 和新来源 diff 脱敏、warning、watcher 旧路径无刷新断言 |
| `D:\works\thirdparty\opencode` | `D:\works\thirdparty\opencode\packages\cli\test\instructions-http.test.ts` | 修改父流程既有**未跟踪**测试文件：签名 URL 私服模型 initial/update/diff/revoke、HTTP query、持久化 instruction_blob/state 的私密性断言 |

本轮生产代码修改：**无**。另新增本报告（忽略目录；非测试代码）；外部全局配置/网站修改：**无**。

## 未执行项及剩余风险

- 未执行真实 5 秒挂起 HTTP 超时、操作系统级 EACCES/瞬态网络挂载目录故障、私服压缩/回退端到端、外部全局配置 TC-006、根 `bun run check`。故障扫描在可控 FSUtil 层验证，不能等同所有平台的真实权限故障。
- Core 用户名/密码 URL **HTTP Basic 鉴权断言失败**，为本轮唯一失败和需父流程裁定/修复的阻塞项；其余测试通过，不应将“私服用例成功”误称为受鉴权远端也成功。
