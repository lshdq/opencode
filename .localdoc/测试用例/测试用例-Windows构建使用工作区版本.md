# 测试用例：Windows构建使用工作区版本

## 测试范围

覆盖 Windows 构建版本来源、版本校验、元数据追溯和最终 Windows x64 构建契约。

## 用例列表

### TC-001: 使用工作区版本
- 前置条件：工作区根 `package.json` 声明版本 `2.0.32`，上游基线版本为 `2.0.26`。
- 操作步骤：运行版本来源测试和 Windows 构建。
- 预期结果：构建版本为 `2.0.32`，不使用上游基线版本作为产物版本。
- 优先级：P0

### TC-002: 保留上游追溯信息
- 前置条件：存在有效 `upstream/v2` 引用和共同基线。
- 操作步骤：读取构建元数据。
- 预期结果：`upstream` 字段仍记录基线提交，`version` 字段记录工作区版本。
- 优先级：P1

### TC-003: Windows 构建契约
- 前置条件：PowerShell 7、Bun 1.4.2、部署父目录存在。
- 操作步骤：运行 `build-win.ps1`。
- 预期结果：构建、隔离 smoke、改名 executable 版本校验和单文件部署通过。
- 优先级：P0

## 测试命令

- `bun test script/windows-build.test.ts`（工作目录：`packages/cli`）
- `bun run check`（工作目录：仓库根目录）
- `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\packages\cli\script\build-win.ps1`（工作目录：仓库根目录）

## 测试场景分类

通用构建流程与框架代码。
