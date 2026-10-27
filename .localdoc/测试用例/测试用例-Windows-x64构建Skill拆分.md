# 测试用例：Windows x64 构建 Skill 拆分

## 测试范围

验证 Skill 拆分、命令入口、关键构建契约保留情况，以及变更范围是否仅限 OpenCode 配置和文档。

## 用例列表

### TC-001: windows-build Skill 结构和契约完整性
- 前置条件：工作区包含新增 Skill 文件。
- 操作步骤：读取 Skill frontmatter 和正文，检查构建入口、工具链、版本来源、smoke、部署保护、选项语义和验收命令。
- 预期结果：Skill 可被发现，且关键契约完整存在。
- 优先级：P0

### TC-002: fork-development 职责边界
- 前置条件：完成 Skill 拆分。
- 操作步骤：检查 `fork-development` 的正文和描述。
- 预期结果：保留 fork 开发规则，并引用 `windows-build`；不再重复完整 Windows x64 构建契约。
- 优先级：P0

### TC-003: /build 命令入口
- 前置条件：项目命令目录存在。
- 操作步骤：读取 `/build` 命令定义，检查描述、Skill 加载要求和参数占位符。
- 预期结果：命令能将参数传递给构建任务，并明确要求加载 `windows-build`。
- 优先级：P0

### TC-004: 变更范围检查
- 前置条件：记录开发前 Git 基线。
- 操作步骤：执行基于基线的 diff 检查。
- 预期结果：仅包含预期的 Skill、Command 和 `.localdoc` 文件；无生产代码、依赖或构建脚本修改。
- 优先级：P1

## 测试命令

```powershell
git diff --check
git diff --stat <开发前基线>
```

另行执行基于文件内容的契约检查；本次不运行实际 Windows 构建，因为需求只调整 Skill 和命令提示，不改变构建实现。

## 测试场景分类

通用 / 文档验证。
