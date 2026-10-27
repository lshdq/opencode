# 需求：trusted-types 类型冲突

## 背景与目标

上游合并后，完整 `bun run check` 的 lint 已通过，但 TypeScript 在 `packages/session-ui/src/components/markdown-cache.tsx` 初始化 DOMPurify 时报告 `Window` 与 DOMPurify 所需 `WindowLike` 的 `trusted-types` 类型不兼容。目标是消除该类型错误，同时保持 DOMPurify 的运行时行为不变。

## 功能描述

### 核心功能

- 修复 DOMPurify 初始化处的跨依赖路径类型不兼容。
- 保持浏览器端仍使用当前 `window` 创建 DOMPurify 实例。

### 边界与约束

- 不改变 Markdown 清理规则、Hook、缓存逻辑或 SSR 分支。
- 不通过全局关闭类型检查掩盖问题。
- 不新增运行时依赖，不修改锁文件。

## 输入输出

- 输入：浏览器全局 `window` 对象。
- 输出：现有 `purifier` 实例及其原有 `sanitize` 行为。

## 非功能需求（性能/安全/兼容性）

- 类型修复应为编译期边界转换，不引入运行时开销。
- 保持现有 DOMPurify 安全清理策略不变。
- 兼容当前 Bun、TypeScript 和 DOMPurify 版本。

## 依赖

- `dompurify@3.4.14`
- `@types/trusted-types@2.0.7`
- `packages/session-ui` TypeScript 配置

## 验收标准

1. `bun run check` 全部通过。
2. `git diff` 仅包含本次类型边界修复及流程文档。
3. DOMPurify 初始化运行时代码路径保持等价。
