# 测试用例：修复 Windows 构建默认 Bun 路径

## 测试范围

验证 Windows 构建脚本默认 Bun 路径修复，以及既有 Windows 构建运行时逻辑未受影响。

## 用例列表

### TC-001: 默认 Bun 路径指向可用 Bun 1.4.2
- 前置条件：`D:\Program\bun\bin\bun.exe` 存在且版本为 1.4.2。
- 操作步骤：不传 `-Bun` 检查 `build-win.ps1` 的默认参数并启动脚本前置检查。
- 预期结果：使用 `D:\Program\bun\bin\bun.exe`，通过文件存在和版本校验。
- 优先级：P0

### TC-002: Windows 构建专项测试
- 前置条件：仓库依赖可用。
- 操作步骤：在 `packages/cli` 执行专项测试命令。
- 预期结果：测试全部通过。
- 优先级：P1

### TC-003: 显式 Bun 路径覆盖仍可用
- 前置条件：存在有效 Bun 可执行文件。
- 操作步骤：传入 `-Bun <路径>` 执行脚本参数解析和版本校验。
- 预期结果：显式路径优先于默认路径。
- 优先级：P1

### TC-004: 默认路径回归断言
- 前置条件：构建脚本存在。
- 操作步骤：运行 Windows 构建专项测试。
- 预期结果：测试直接断言脚本默认值为 `D:\Program\bun\bin\bun.exe`。
- 优先级：P1

## 测试命令

```powershell
cd packages/cli
bun test script/windows-build.test.ts
```

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\packages\cli\script\build-win.ps1 -BuildOnly
```

## 测试场景分类

框架代码 / 通用
