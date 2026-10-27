# 测试报告：V2 Fork 开发技能与 Windows 部署命名（审查修复后独立复测）

- 独立测试：`task-deep` 全新会话 `ses_f2de57d74ffeeItjag4ejL05Yp`；框架代码验证。
- 命令/结果：`packages/cli` 下 `bun test script/windows-build.test.ts` **25 通过、0 失败**；`bun typecheck` 与 `git diff --check` 通过。主任务在本次修复后再次运行根目录 `bun run check`，通过。
- TC-002：Git 夹具确认版本来自已合入上游基线，未合入上游更新不改变结果；当前本地基线是 `080b7671…`，版本 `2.0.12`。
- TC-003/004：临时目录验证仅复制分钟命名的 exe、哈希一致、同名拒绝覆盖、保留构建元数据与模拟日常 `opencode.exe`。
- TC-006：借用 Bun 1.4.2 真实可执行文件，在隔离目录验证改名后 `--version`、同名保护，以及版本不符、不可执行文件和哈希不符时清理本次新目标。正式 OpenCode 编译 exe 未验证。
- TC-005：选项门禁、冒烟失败和 CI `-NoDeploy` 仅按代码/配置静态核对，未运行正式构建、冒烟失败分支或 CI。
- 环境：Windows x64，夹具位于 `D:\temp\systemp\opencode`；无真实 OpenCode 构建制品，未 fetch、未连接日常服务或部署到 `D:\Program\opencode`。
- 本轮新增/修改测试文件及所属仓库：无；流程此前已修改的 `D:\works\thirdparty\opencode\packages\cli\script\windows-build.test.ts` 仍属于最终审查范围（仓库 `D:\works\thirdparty\opencode`）。
