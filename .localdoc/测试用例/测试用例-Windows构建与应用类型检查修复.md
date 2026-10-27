# 测试用例：Windows构建与应用类型检查修复

## 测试范围

覆盖 Windows 链接修复逻辑、持久化迁移类型检查及仓库标准检查。

## 用例列表

### TC-001: 实际跟踪链接修复
- 前置条件：Windows 工作区存在 app 链接，enterprise 文件未被当前索引跟踪。
- 操作步骤：运行 Windows 构建专项测试及构建入口。
- 预期结果：只处理实际跟踪的链接，不因不存在的 enterprise 文件失败。
- 优先级：P0

### TC-001a: 未跟踪文件保持不变
- 前置条件：Windows 工作区存在未被 Git 跟踪的 enterprise 同名文件。
- 操作步骤：调用链接修复逻辑。
- 预期结果：文件不被删除、覆盖或转换为符号链接，修复逻辑正常返回。
- 优先级：P1

### TC-002: 持久化迁移类型检查
- 前置条件：安装冻结依赖。
- 操作步骤：运行 `packages/app` 类型检查。
- 预期结果：迁移转换返回值满足 schema 字面量类型。
- 优先级：P0

### TC-003: 仓库标准检查
- 前置条件：源码修改完成。
- 操作步骤：从仓库根目录运行 `bun run check`。
- 预期结果：检查通过。
- 优先级：P1

### TC-004: Windows x64 构建契约
- 前置条件：PowerShell 7、Bun 1.4.2、部署父目录存在。
- 操作步骤：运行 `packages/cli/script/build-win.ps1`，不传额外参数。
- 预期结果：构建、隔离 smoke 和版本化单文件部署均成功；不覆盖同名文件。
- 优先级：P0

## 测试命令

- `bun test script/windows-build.test.ts`（工作目录：`packages/cli`）
- `bun run typecheck`（工作目录：`packages/app`）
- `bun run check`（工作目录：仓库根目录）
- `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\packages\cli\script\build-win.ps1`（工作目录：仓库根目录）

## 测试场景分类

框架代码与通用构建流程。
