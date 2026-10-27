# 测试用例：优化 dev-workflow 流程

## 测试范围

验证全局 `dev-workflow` skill 的阶段结构、确认点、模式切换和后续自主闭环规则。

## 用例列表

### TC-001: 七阶段结构
- 前置条件：技能文件已修改。
- 操作步骤：检查流程摘要、阶段总数及所有阶段标题。
- 预期结果：仅存在阶段 1-7；不存在“阶段 4：用户审核”或“8 阶段”描述。
- 优先级：P0

### TC-002: 仅保留两个确认点
- 前置条件：技能文件已修改。
- 操作步骤：检索“等待用户确认”“询问用户”“是否需要修复”等确认类表述。
- 预期结果：正常流程中仅阶段 1 和阶段 2要求用户确认；其他命中仅可描述真实阻塞例外。
- 优先级：P0

### TC-003: 阶段 2 后切换模式
- 前置条件：技能文件已修改。
- 操作步骤：检查阶段 2、模式处理规则和 `plan_exit` 运行时契约。
- 预期结果：支持环境中先完成 plan 文件，再通过 `plan_exit` 的内置提问完成该阶段唯一一次确认；Yes 切换 build；No 保持 plan、禁止进入阶段 3并等待用户下一条消息，不依赖 `continue_loop_on_deny` 配置；执行开发阶段不再提示用户手动切换 build 模式。
- 优先级：P0

### TC-004: 后续步骤连续执行
- 前置条件：技能文件已修改。
- 操作步骤：检查文档生成、任务分解、开发、测试和审查阶段。
- 预期结果：阶段 3-7均无需确认并连续执行；任务清单生成后直接开发。
- 优先级：P0

### TC-005: 测试与审查自主闭环
- 前置条件：技能文件已修改。
- 操作步骤：检查独立测试和代码审查的结果处理规则。
- 预期结果：失败或问题由主智能体自主修复，并重复测试或审查，直至通过或遇到真实阻塞。
- 优先级：P1

### TC-006: 真实阻塞例外
- 前置条件：技能文件已修改。
- 操作步骤：检查强制规则及开发异常处理规则。
- 预期结果：仅权限、外部环境、不可消解的需求矛盾等真实阻塞允许询问用户。
- 优先级：P1

### TC-007: 确认工具不可用时降级
- 前置条件：当前已经是 build agent，或客户端未注册 `plan_exit`，并覆盖 question 同样不可用的客户端。
- 操作步骤：检查模式处理以及阶段 1、阶段 2 的降级规则。
- 预期结果：question 不可用时，阶段 1 通过普通对话澄清、复述并等待明确确认；阶段 2 同样通过普通对话请求明确确认并结束当前回复；已在 build agent 时确认后直接进入阶段 3；既非 build 又无法自动切换时按真实阻塞处理；不得跳过或重复确认。
- 优先级：P0

## 测试命令

使用 Grep/Read 对以下文件执行静态文档和运行时契约验证，无项目构建命令：

- `C:\Users\lshdq\.config\opencode\skills\dev-workflow\SKILL.md`
- `D:\works\thirdparty\opencode\packages\opencode\src\tool\plan.ts`
- `D:\works\thirdparty\opencode\packages\opencode\src\tool\plan-exit.txt`
- `D:\works\thirdparty\opencode\packages\opencode\src\tool\registry.ts`
- `D:\works\thirdparty\opencode\packages\opencode\src\agent\agent.ts`
- `D:\works\thirdparty\opencode\packages\opencode\src\session\processor.ts`

## 测试场景分类

文档验证
