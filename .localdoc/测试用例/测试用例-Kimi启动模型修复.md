# 测试用例：Kimi启动模型修复

## 测试范围
已安装 Windows CLI、启动脚本、供应商凭据关联、模型与开发子智能体配置。通用配置集成验证。

## 用例列表
### TC-001: 启动脚本
- 前置条件：安装目录存在。
- 操作步骤：读取脚本；通过脚本执行非交互 models 命令。
- 预期结果：OPENCODE_DEV_MODEL=kimi-code-plan-cn/k3，档位 low/high/max，参数正常透传。
- 优先级：P0

### TC-002: 凭据关联与保护
- 前置条件：旧 API 凭据存在，新中国站条目缺失。
- 操作步骤：在内存中核验复制结果及修改前后其他条目的语义一致性；只输出布尔值。
- 预期结果：新旧 Kimi 凭据相等，其他条目不变，控制台及文档无密钥。
- 优先级：P0

### TC-003: 模型与推理档位
- 操作步骤：通过安装版 models kimi-code-plan-cn --verbose 检查 k3 元数据。
- 预期结果：模型存在、接口为 api.kimi.com，支持 low/high/max。
- 优先级：P0

### TC-004: 开发子智能体配置
- 操作步骤：通过启动脚本分别执行 debug agent dev-fast、dev-standard、dev-deep；只提取模型与 variant 字段。
- 预期结果：三个子智能体均使用新供应商 k3，档位分别 low/high/max。
- 优先级：P1

### TC-005: 真实调用
- 操作步骤：通过脚本执行 run --agent build --variant low，提示词要求仅输出 KIMI_OK 且不调用工具；在批准的临时目录执行。
- 预期结果：Kimi 返回正常文本，无模型无效或认证错误。
- 优先级：P0

## 测试命令
在 D:\temp\systemp\opencode 或包目录运行，不从仓库根运行测试。
- cmd.exe /d /c D:\Program\opencode\opencodeKimi.cmd models kimi-code-plan-cn --verbose
- cmd.exe /d /c D:\Program\opencode\opencodeKimi.cmd debug agent dev-fast（以及 dev-standard、dev-deep；输出须过滤到 model/variant）
- cmd.exe /d /c D:\Program\opencode\opencodeKimi.cmd run --agent build --variant low --format json "Reply only KIMI_OK. Do not use tools."
- 可持久化一个只读 PowerShell 验证脚本，用于关联一致性和脚本内容；不得硬编码或输出密钥。

## 测试场景分类
通用：本机配置与 CLI 集成验证。独立测试不重复已成功的真实计费请求，复用明确的基本调用记录；对模型加载、档位和启动脚本独立检查。无需运行无关源码全量 typecheck 或构建。
