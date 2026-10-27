# 测试用例：Kimi K3 启动脚本

## 测试范围

验证 Windows CMD 启动脚本的静态配置、参数透传、模型选择和退出码传递，不发起真实模型请求。

## 用例列表

### TC-001: 校验默认模型
- 前置条件：脚本已创建。
- 操作步骤：读取 `opencodeKimi.cmd`。
- 预期结果：`OPENCODE_DEV_MODEL` 等于 `kimi-for-coding/k3`。
- 优先级：P0

### TC-002: 校验推理档位映射
- 前置条件：脚本已创建。
- 操作步骤：读取三个 `OPENCODE_DEV_*_VARIANT` 环境变量。
- 预期结果：fast、standard、deep 分别为 `low`、`high`、`max`。
- 优先级：P0

### TC-003: 校验参数透传和退出码
- 前置条件：脚本已创建，`opencode` 命令可用。
- 操作步骤：检查调用行和退出行，并使用无交互 CLI 参数执行脚本。
- 预期结果：调用行透传 `%*`，脚本退出码与 OpenCode 一致。
- 优先级：P0

### TC-004: 校验参考脚本未被修改
- 前置条件：参考脚本存在。
- 操作步骤：对比任务前后 `opencodeOpenai.cmd` 内容。
- 预期结果：参考脚本内容保持不变。
- 优先级：P1

### TC-005: 校验不存在敏感信息
- 前置条件：脚本已创建。
- 操作步骤：审查脚本全部内容。
- 预期结果：不包含 API key、令牌或其他认证数据。
- 优先级：P0

## 测试命令

```powershell
cmd.exe /d /c "D:\Program\opencode\opencodeKimi.cmd --version"
```

## 测试场景分类

通用
