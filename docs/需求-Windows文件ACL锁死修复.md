# 需求：Windows 文件 ACL 锁死修复

## 背景与目标

opencode 的 win-adapt 适配在 `packages/core/src/util/file-mode.ts` 中引入了 `applyFileMode`：
Unix 模式（如 `0o600`）在 Windows 上通过 `icacls /inheritance:r /grant:r <用户名>:(R,W)` 收紧 ACL。

**缺陷**：授权主体使用裸 `process.env.USERNAME`。当机器名与用户名同名（如本机均为 `lsh`）时，
icacls 将其解析为**计算机账号**（域 SID 无 RID），叠加 `/inheritance:r` 删除全部继承 ACE 后，
当前用户反而失去读写权限。实际后果：

- `/connect` 保存凭据后 `auth.json` 被锁死（读 EACCES、写 EPERM）
- 凭据加载静默失败 → provider 未连接 → 模型选择器无对应模型
- 日志中大量 `AuthError: Failed to write auth data (EPERM)`

**目标**：彻底消除该故障类——无论名称解析如何异常，`applyFileMode` 都不能把当前进程/用户锁在文件之外。

## 功能描述

### 核心功能

1. **字面 SID 授权**：SID 通过 `whoami /user /fo csv /nh` 获取，以 latin1 解码，并仅从 CSV
   第二列正则提取。使用 `SecurityIdentifier` 构造唯一允许 ACE，绕过所有账户名称解析；通过
   PowerShell `Set-Acl -LiteralPath` 在内存中移除继承和旧显式 ACE，再一次写回完整 DACL。
2. **事后自检**：PowerShell 写回后校验 DACL 受保护且只包含当前 SID 的允许 ACE；随后按 mode
   语义真实打开文件验证（读写 → `r+`；只写 → 非创建型 `O_WRONLY`；只读 → `r`，不使用
   `fs.access`）。EACCES/EPERM/EBUSY 会先重试；持续 EBUSY 视为文件占用并保留已验证 DACL，
   重试后仍 EACCES/EPERM 或发生其他永久访问失败时进入恢复链。
3. **可判定恢复**：PowerShell 区分未修改/已恢复的 `safe`、恢复失败的 `unsafe` 和进程状态未知的
   `unknown`；仅脚本明确报告的 `unsafe` 才重试执行 `icacls /reset`，必要时重新启用继承并再次验证。
4. **安全降级链**：非 owner-only 模式 / perms 为空 / 获取 SID 失败 → 跳过收紧，
   保留默认继承 ACL（等效上游行为）。

### 边界与约束

- Unix 分支行为不变（仅 `chmod`）
- 函数签名、导出名、调用方（`fs-util.ts:113`、`util/filesystem.ts:102`）零改动
- 收紧仍为 best-effort：任何一步失败不得抛出异常中断调用方写入流程

## 输入输出

- 输入：`path: string`（目标文件）、`mode: number`（Unix 八进制权限位）
- 输出：`Promise<void>`；副作用为文件 ACL/chmod 变化，无返回值变化

## 非功能需求（性能/安全/兼容性）

- **性能**：每次收紧新增 `whoami` 和 PowerShell 子进程调用，仅在 owner-only 模式触发；
  PowerShell 启动成本可接受（凭据保存等低频路径）
- **安全**：保持原意图——owner-only 文件仅授予当前用户；自检兜底确保不会因加固反而失锁
- **兼容性**：本地账号 / 域账号 / Azure AD 账号 SID 形态均可匹配；
  中文 Windows 的 GBK 控制台编码不影响 SID 提取
- **命令安全**：`whoami`、`icacls` 和 Windows PowerShell 均使用 `%SystemRoot%` 下绝对路径；
  PowerShell 子进程仅继承运行所需的最小环境，不向其暴露 token 等业务环境变量

## 依赖

- Windows 自带命令：`whoami`、`icacls`、Windows PowerShell 5.1
- Node/Bun：`node:child_process`（execFile）、`node:fs/promises`（chmod/open）

## 验收标准

1. 机器名=用户名的环境下，对 temp 文件执行 `applyFileMode(file, 0o600)` 后，
   当前进程**仍然可读写**该文件（回归本 bug 的核心断言）
2. 收紧后的 DACL 经 `Get-Acl` 转换后仅包含当前用户 SID 的唯一授权项，
   不含继承、其他显式主体或 `DOMAIN\:(...)` 形态的畸形 ACE
3. 非 Windows 平台行为与现状一致（仅 chmod），相关逻辑被平台条件跳过
4. `bun typecheck`（packages/core）通过；新增测试全部通过
