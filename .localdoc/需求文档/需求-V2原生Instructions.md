# 需求：V2 原生 Instructions

## 背景与目标

V2 已有 AGENTS.md 发现和持久化的会话指令链路，但配置 `instructions` 数组目前只解析、不生效。全局外部 `extensions/server` 插件临时兼容 V1 的 `.opencode/AGENTS.md`，应由 V2 原生支持并移除该插件。

## 功能描述

### 核心功能

- 从 V2 配置文档加载 `instructions` 指定的本地文件、glob 及 HTTP(S) URL，沿用 V1 相对 glob 从会话目录逐层向上至项目根、绝对 glob 在目标目录匹配及 `~/` 展开规则；来源按配置顺序、近到远稳定去重。
- 配置来源与自动发现的 AGENTS.md 一同进入 InstructionDiscovery、SessionContext、InstructionState，参与首次上下文、更新、会话移动、压缩、回退与临时生成请求；避免同一路径重复注入。
- 全局配置加入 `.opencode/AGENTS.md`，原生收集当前位置到项目根的匹配。项目配置禁用时不加载项目规则。
- 更新 V2 配置与 instructions 文档，迁移全局配置，移除外部兼容插件注册和只服务于该插件的桥接代码及测试；保留无关全局配置。

### 边界与约束

- V1 实现位于 `dev:packages/opencode/src/session/instruction.ts`，仅复用来源解析语义，不移植其 InstanceState/消息注入机制。
- 用户允许随插件移除取消三个 `debate-*` agent 的 temperature 补丁；不要求实现一般性的 agent request 参数兼容。
- 本地删除与暂时不可读、HTTP 请求失败应区分；已有指令状态遇暂时不可用时保留上次值，不凭一次故障将规则删除。
- 不修改共享后台服务；使用隔离测试环境验证原生实现。

## 输入输出

- 输入：分层 `opencode.json(c)` 的 `instructions: string[]`、Location、匹配文件内容与 HTTP(S) 响应。
- 输出：供模型使用的初始/更新指令及既有持久化 instruction 状态；配置来源变化时刷新。

## 非功能需求（性能/安全/兼容性）

- 保持 V2 Schema 仅定义配置契约、Core 负责加载；复用现有 Effect 服务、Watcher、FSUtil 与 HTTP 客户端。
- 保持来源顺序确定、路径去重，远程请求有超时且不无限阻塞会话。
- 远端指令的签名 URL 仅用于网络请求；在日志、模型可见的来源说明和可读持久化来源字段中不暴露 URL 凭据或查询参数；相同 URL 仍可稳定识别，不同 URL 不误合并。
- 兼容 V1 相对/绝对路径、glob、URL 输入形式和全局配置的项目相对语义；保留 V2 已有 AGENTS.md 生命周期。

## 依赖

- `packages/core` 的 Config、InstructionDiscovery、SessionContext/InstructionState、FSUtil、Watcher；`packages/schema` 已提供 instructions 配置字段。
- 外部全局配置仓库：`C:\Users\lshdq\.config\opencode`。

## 验收标准

1. 路径、glob、URL 规则真实出现在主会话模型上下文，且同一来源不重复。
2. `.opencode/AGENTS.md` 的嵌套与根规则按近到远生效；移动后的目标规则生效，旧规则通过更新撤销。
3. 修改、创建、删除及配置变更会在后续请求反映，暂时不可用不误删已有规则。
4. 相关核心测试、全局配置测试与 `bun run check` 通过；文档不再声称配置 instructions 无效。
5. 全局配置不再注册 `extensions/server`，桥接插件已移除，其他用户设置保留。
6. glob 扫描暂时无法确认原有匹配文件已删除时保留已有规则，重启后的已有会话亦如此；反复替换配置来源或当前来源读取失败时不持续保留已移除来源的 watcher。
