# 测试用例：trusted-types 类型冲突

## 测试范围

验证 DOMPurify 初始化的 TypeScript 类型兼容性，以及整个 monorepo 的 lint 和 typecheck。

## 用例列表

### TC-001: Session UI 类型检查
- 前置条件：依赖已按 `bun.lock` 安装。
- 操作步骤：执行 `bun run --cwd packages/session-ui typecheck`。
- 预期结果：类型检查通过，不再报告 `TrustedTypePolicyFactory` 或 `WindowLike` 不兼容。
- 优先级：P0

### TC-002: 全仓库检查
- 前置条件：TC-001 通过。
- 操作步骤：从仓库根目录执行 `bun run check`。
- 预期结果：lint 和所有包的 typecheck 均通过。
- 优先级：P0

### TC-003: 运行时分支保持不变
- 前置条件：代码审查变更。
- 操作步骤：检查 DOMPurify 浏览器分支仍调用 `DOMPurify(window)`，SSR 分支仍直接使用默认实例。
- 预期结果：清理配置、Hook 注册和 SSR 行为无变化。
- 优先级：P1

## 测试命令

```bash
bun run --cwd packages/session-ui typecheck
bun run check
```

## 测试场景分类

通用：TypeScript 类型兼容性与 monorepo 构建检查。
