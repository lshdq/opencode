# 测试用例：Windows源码哈希并发部署

## 测试范围

验证 Windows x64 构建契约的源码哈希文件句柄控制、版本来源、构建追溯、隔离 smoke、部署哈希和冲突保护。

## 用例列表

### TC-001: 源码哈希不触发文件句柄耗尽
- 前置条件：Windows x64，Bun 1.4.2，仓库存在完整工作区文件。
- 操作步骤：调用 `sourceIdentity(root)`，并执行契约构建脚本。
- 预期结果：源码哈希完成，不出现 `EMFILE`；哈希输入和结果保持确定。
- 优先级：P0

### TC-002: 上游基线版本固定
- 前置条件：`upstream/v2` 和 fork HEAD 均存在，且上游可能领先但未合入。
- 操作步骤：运行构建脚本并读取 `build-metadata.json`。
- 预期结果：版本等于 `git merge-base HEAD upstream/v2` 提交中的根 `package.json` 版本。
- 优先级：P0

### TC-003: 构建与隔离 smoke
- 前置条件：冻结依赖安装成功且 lockfile 初始哈希已记录。
- 操作步骤：执行 `build-win.ps1` 默认流程。
- 预期结果：生成 Windows x64 exe；隔离环境下 `--version` 与预期版本一致；失败时不部署。
- 优先级：P0

### TC-004: 单文件部署和哈希校验
- 前置条件：部署父目录已存在，构建和 smoke 成功。
- 操作步骤：完成默认部署并检查部署目录。
- 预期结果：只新增一个 `opencode-<version>-<YYYYMMDDHHmm>.exe`；哈希匹配；不复制元数据和 source diff。
- 优先级：P0

### TC-005: 同名目标拒绝覆盖
- 前置条件：同版本同分钟部署目标已存在。
- 操作步骤：再次运行部署。
- 预期结果：排他创建失败，已有文件内容不变。
- 优先级：P0

### TC-006: 全量检查与工作区保护
- 前置条件：修复完成。
- 操作步骤：运行专项测试、`bun run check`，比较 lockfile 和部署前后的日常 exe、PATH、服务状态。
- 预期结果：专项测试和检查通过；lockfile 未变化；不激活日常 exe，不修改 PATH、快捷方式或服务。
- 优先级：P1

## 测试命令

```text
cd packages/cli
bun test script/windows-build.test.ts
cd ../..
bun run check
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\packages\cli\script\build-win.ps1 -Bun 'D:\Program\bun\bin\bun.exe' -DeployRoot 'D:\Program\opencode'
```

## 测试场景分类

框架代码 / 通用 / Windows x64 构建与部署契约。
