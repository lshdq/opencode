# 测试用例：Effect 进程类型导入统一

## 测试范围

验证 Effect `rc.118` 稳定/旧版模块导入统一，重点覆盖 Windows MCP 进程类型、Core 进程相关 fixture，以及全仓库类型检查。

## 用例列表

### TC-001: 进程类型统一检查
- 前置条件：已安装锁文件指定的依赖。
- 操作步骤：在 `packages/util` 执行类型检查。
- 预期结果：`cross-spawn-spawner.ts` 与 `mcp-windows.ts` 的 `StandardCommand` 类型兼容，类型检查通过。
- 优先级：P0

### TC-002: Windows MCP 相关测试
- 前置条件：项目依赖已安装。
- 操作步骤：执行 Core 中与 MCP/进程相关的现有测试。
- 预期结果：现有测试通过，进程隔离、命令包装和生命周期行为不变。
- 优先级：P0

### TC-003: 全仓库类型检查
- 前置条件：依赖版本与 `bun.lock` 一致。
- 操作步骤：从仓库根目录执行 `bun run check`。
- 预期结果：检查无 TypeScript 错误。
- 优先级：P0

### TC-004: 旧版导入边界扫描
- 前置条件：完成源码修改。
- 操作步骤：扫描 `effect/unstable/*` 导入，并核对每个模块是否存在稳定等价物。
- 预期结果：存在稳定等价物且参与相关类型图的导入已统一；无稳定等价物的导入有明确保留理由。
- 优先级：P1

### TC-005: 指令发现文件过滤
- 前置条件：祖先路径包含名为 AGENTS.md 的目录及正常指令文件。
- 操作步骤：验证文件发现忽略目录且保留正常文件；Core 包内运行 `bun test test/instruction-discovery.test.ts` 及必要的现有 fs-util 测试。
- 预期结果：目录不进入指令读取路径，正常文件仍被发现，现有断言通过。
- 优先级：P1

## 测试命令

命令须在对应包目录执行，不使用根目录运行测试：Util/Core/CLI 类型检查均为包内 `bun typecheck`；Core 测试为包内 `bun test <test 文件>`。补充 CLI 包内 `bun test test/service-permissions.test.ts`，验证新地址构造及原 ACL 断言。

```text
# packages/util、packages/core、packages/cli 各自目录
bun typecheck
# packages/core 目录
bun test test/mcp.test.ts test/process/process.test.ts test/effect/cross-spawn-spawner.test.ts
# packages/cli 目录
bun test test/service-permissions.test.ts
# 仓库根目录
bun run check
```

## 测试场景分类

框架代码 / 通用
