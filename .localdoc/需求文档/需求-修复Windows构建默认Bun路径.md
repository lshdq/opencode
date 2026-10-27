# 需求：修复 Windows 构建默认 Bun 路径

## 背景与目标

`packages/cli/script/build-win.ps1` 当前默认指向不存在的 Bun 路径，导致未传入 `-Bun` 时无法启动 Windows x64 构建。目标是使默认路径符合本机 Windows 构建契约。

## 功能描述

### 核心功能

将构建脚本的默认 Bun 路径改为 `D:\Program\bun\bin\bun.exe`。

### 边界与约束

- 仅修改默认参数值。
- 保留 `-Bun` 显式覆盖能力。
- 不改变 Bun 版本校验、其他构建参数和构建流程。
- 本需求不处理其他独立的构建前置阻塞。

## 输入输出

- 输入：不传 `-Bun` 时执行 `build-win.ps1`。
- 输出：脚本使用 `D:\Program\bun\bin\bun.exe` 并继续执行既有版本检查。

## 非功能需求（性能/安全/兼容性）

- 保持 PowerShell 7 兼容性。
- 不引入依赖、不改变部署行为。
- 显式传入其他 Bun 路径时行为保持不变。

## 依赖

- 本机存在 Bun 1.4.2：`D:\Program\bun\bin\bun.exe`。
- 现有 `packages/cli/script/windows-build.test.ts` 测试。

## 验收标准

1. `build-win.ps1` 默认 Bun 参数为 `D:\Program\bun\bin\bun.exe`。
2. 使用该默认路径时能通过 Bun 文件存在及版本检查。
3. Windows 构建专项测试通过。
4. 其他构建参数和显式 `-Bun` 覆盖行为未被修改。
