# 需求：Effect 进程类型导入统一

## 背景与目标

上游将 Effect 进程 API 从 `effect/unstable/process` 迁移到 `effect/process`。fork 中的 Windows MCP 适配仍引用旧模块，导致 `StandardCommand` 类型来自两个不同模块，`bun run check` 和 pre-push 检查失败。

目标是统一相关 Effect 稳定/旧版模块导入，消除类型不兼容，同时保持进程启动、Windows MCP 作业隔离和其他运行行为不变。

## 功能描述

### 核心功能

1. 扫描仓库中 `effect/unstable/*` 导入与稳定模块的对应关系。
2. 将存在稳定等价物且参与同一类型图的进程/HTTP 导入统一到 Effect `rc.118` 稳定模块。
3. 对仍没有稳定等价物的模块保留原导入，避免机械迁移改变 API 行为。
4. 修复同次 Effect 升级暴露的 CLI 测试地址类型适配，使全量检查恢复；保持固定回环地址和 ACL 验证语义。

### 边界与约束

- 重点覆盖 `packages/util`、`packages/core` 及其测试和 fixture。
- 不改变 Windows MCP 的 PowerShell 作业隔离、环境传递和进程生命周期行为。
- 不进行与本次类型兼容无关的 Effect API 重构。
- 不绕过类型检查或 pre-push 检查。

## 输入输出

- 输入：当前仓库源码、Effect `rc.118` 类型定义及现有测试。
- 输出：统一后的源码导入、通过的类型检查结果和验证报告。

## 非功能需求（性能/安全/兼容性）

- 兼容 Effect `4.0.0-rc.118`。
- 保持 Windows 与非 Windows 进程执行行为。
- 不降低 Windows MCP 子进程隔离能力，不引入新的外部网络访问。
- 不增加运行时开销；变更限于模块类型来源。

## 依赖

- Bun 1.4.2。
- Effect `4.0.0-rc.118`，以 `bun.lock` 为准。
- 现有 `packages/util`、`packages/core` 类型检查和测试脚本。

## 验收标准

审查收敛补充：指令向上发现只接受文件，忽略名为 AGENTS.md 的目录；通过现有 instruction-discovery 测试及目录场景验证。

1. 相关稳定/旧版进程类型不再混用。
2. `packages/util` 类型检查通过。
3. 受影响的 Core/Util 测试通过。
4. 根目录 `bun run check` 通过。
5. 代码审查无阻塞或应改问题。
