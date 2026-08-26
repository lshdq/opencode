# 测试用例：Windows 文件 ACL 锁死修复

## 测试范围

`packages/core/src/util/file-mode.ts` 的 `applyFileMode`：
Windows 字面 SID 收紧、事后自检与 /reset 兜底、安全降级链；新增回归测试文件
`packages/core/test/util/file-mode.test.ts`。

## 用例列表

### TC-001: 0o600 收紧后当前进程仍可读写（核心回归）
- 前置条件：Windows 平台；temp 目录可写
- 操作步骤：
  1. 创建 temp 文件并写入初始内容
  2. 临时令 `USERNAME=COMPUTERNAME`，确定性复现旧实现的名称解析歧义
  3. 调用 `applyFileMode(file, 0o600)`
  4. 以写方式打开并改写内容，再读回校验
- 预期结果：打开、写入、读取全部成功，内容一致；不抛 EACCES/EPERM
- 优先级：P0

### TC-002: DACL 授予当前用户且无畸形 ACE
- 前置条件：TC-001 完成后的同一文件
- 操作步骤：用 `icacls /findsid` 查询当前用户 SID，并查询 ACL 输出
- 预期结果：能找到当前用户 SID；ACL 不含 `(I)`，且输出不匹配正则 `\\:\(`
- 优先级：P0

### TC-003: 清理其他显式 ACE
- 前置条件：Windows 平台；temp 文件预置 `Everyone:(R,W)`
- 操作步骤：调用 `applyFileMode(file, 0o600)`，分别查询当前用户和 Everyone SID
- 预期结果：仅能找到当前用户 SID，无法找到 Everyone SID，且 ACL 不含继承 ACE
- 优先级：P0

### TC-004: 非 owner-only 模式跳过收紧
- 前置条件：Windows 平台；temp 文件
- 操作步骤：调用 `applyFileMode(file, 0o644)` 后检查 ACL
- 预期结果：继承未被移除（输出含 `(I)` 标记的继承 ACE），当前进程可读写
- 优先级：P1

### TC-005: 非 Windows 平台仅 chmod 且不调用 icacls
- 前置条件：非 Windows 平台运行（CI/Linux）
- 操作步骤：对 temp 文件调用 `applyFileMode(file, 0o600)`，检查 `stats.mode & 0o777`
- 预期结果：mode 位生效为 0o600；流程正常返回（win32 分支被跳过）
- 优先级：P2（平台条件 skip）

### TC-006: Windows chmod 失败安全降级
- 前置条件：Windows 平台；目标路径不存在
- 操作步骤：对不存在的文件调用 `applyFileMode(file, 0o600)`
- 预期结果：函数正常返回，不向调用方抛出异常
- 优先级：P1

### TC-007: Windows 只写模式保持收紧
- 前置条件：Windows 平台；temp 文件
- 操作步骤：调用 `applyFileMode(file, 0o200)`，随后分别执行写入和读取
- 预期结果：ACL 不含继承 ACE；写入成功，读取因无读权限失败，不触发 `/reset` 放宽 ACL
- 优先级：P1

### TC-008: ACL 恢复状态机
- 前置条件：无平台限制；使用可控的验证、恢复和等待函数
- 操作步骤：分别输入 `tightened`、`safe`、`unsafe`、`unknown`，并模拟恢复命令持续失败
- 预期结果：`tightened` 验证成功时保留、验证失败时恢复；`safe/unknown` 无操作；仅 `unsafe` 直接恢复；失败操作共执行三次且等待两次
- 优先级：P0

### TC-009: 恢复链与命令安全
- 前置条件：无平台限制；使用可控的 reset/inherit/verify 函数和虚拟 SystemRoot
- 操作步骤：模拟 reset 三次失败后 inheritance 成功；构造系统命令路径和 PowerShell 环境
- 预期结果：覆盖 reset 验证成功短路及验证失败后的 inheritance 回退；命令均为绝对路径，相对 SystemRoot 降级到绝对默认值，环境不含 PATH 或业务凭据
- 优先级：P0

### TC-010: 访问错误分类
- 前置条件：无平台限制；输入可控的文件打开错误码和重试耗尽标记
- 操作步骤：分别输入 EBUSY、EACCES、EPERM、ENOENT，并覆盖重试中和已耗尽状态
- 预期结果：临时错误先重试；耗尽后 EBUSY 保留 ACL，EACCES/EPERM 触发恢复；永久错误立即恢复
- 优先级：P0

## 测试命令

```bash
# 在 packages/core 目录下执行（禁止从仓库根目录跑测试）
cd packages/core
bun test test/util/file-mode.test.ts

# 类型检查
bun typecheck
```

## 测试场景分类

框架代码（core 工具函数，平台相关行为验证；无业务接口/文档验证场景）
