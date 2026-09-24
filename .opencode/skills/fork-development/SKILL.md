---
name: fork-development
description: OpenCode V2 fork 功能增强、个性化优化与按需 Windows 兼容开发。触发关键词：fork 开发、V2 定制、功能增强、个性化优化、Windows 兼容、Windows 构建、fork-development。包含上游同步决策、开发验证与 Windows x64 隔离构建/安全部署约束；不是 V1 win32 问题清单。
slash: true
---

# fork-development

本 fork 以 V2 功能增强和个性化优化为主；Windows 原生兼容按实际需求处理，不把所有改动限定为 win32 修补。开发遵守项目 `AGENTS.md` 与适用的 `dev-workflow`；上游合并另按 `merge-upstream` skill 执行，不因启动开发或构建而自动 fetch/merge/push。

## 开发原则

1. 从项目默认长期分支 `v2`（缺少本地引用时用 `origin/v2`）创建短横线命名的工作分支；上游对照为 `upstream/v2`。先确认工作区及用户改动，不覆盖未提交内容。合并上游必须先做安全审查、给出变更说明并获得用户明确确认。
2. 按需求明确 V2 的行为边界、测试和回归影响；在 `packages/core`、`packages/cli`、`packages/server`、`packages/protocol`、`packages/schema` 等对应现行模块实现，不沿用 V1 路径或配置接口。保持项目规定的依赖方向；修改公共 Protocol 或 Server `HttpApi` 后，从 `packages/client` 执行 `bun run generate`，不要直接编辑生成客户端。
3. 仅确有 Windows 兼容问题时针对 `win32` 增加平台差异处理；保持其他平台既有行为，不为假设性极端竞态增加复杂度。先复现、定位，再制定最小修复并覆盖相关测试。
4. 测试从相应包目录运行，聚焦类型检查用包目录的 `bun typecheck`；完整 lint/类型检查从仓库根运行 `bun run check`。提交信息用 `type(scope): summary`；不默认提交或推送。

## Windows x64 构建与部署契约

入口为仓库根目录的 `packages/cli/script/build-win.ps1`，要求 PowerShell 7 和 Bun 1.4.2。脚本默认 Bun 路径为当前本机存在的 `D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe`；其他安装位置可用 `-Bun '<路径>'` 覆盖，脚本会检查文件存在且版本为 1.4.2。保留冻结依赖、源码哈希、独立构建目录与隔离 cold/warm smoke；`--skip-web-ui` 不代表 Web UI 已通过验收。构建时不得自动拉取上游、更新 lockfile 或从远端最新版本猜测版本。

目标版本须从**已合入本 fork 的上游基线**读取：`git merge-base HEAD upstream/v2` 对应提交的根 `package.json` 中的 `version`。`upstream/v2` 前进但尚未合入时不得改变本次构建版本；最终产物的 `--version` 必须与该版本一致，不得硬编码特定发布版本。若缺少可信本地引用或版本无法验证，停止而不是猜测。

在构建和隔离 smoke 均成功后，默认仅复制一个构建产物 exe 到已有的 `D:\Program\opencode\opencode-<上游版本>-<本地时间YYYYMMDDHHmm>.exe`；`-DeployRoot` 可指定其他已存在父目录。时间戳使用部署时的本地时间，精确到分钟；同名目标（包括同分钟第二次部署）必须拒绝覆盖。复制后校验 exe 哈希；`build-metadata.json`、`smoke-result.json`、`source.diff` 仍保留在构建目录供追溯，不复制到部署目录，不创建部署版本子目录。失败或 smoke 不通过时禁止部署。默认**不激活**日常 `opencode.exe`，不更改 PATH、快捷方式或服务；部署不等于可直接使用共享日常服务。

选项语义：`-BuildOnly` 只构建（不 smoke、不部署）；`-NoDeploy` 构建并 smoke（不部署）；默认构建、隔离 smoke 成功后执行上述单文件部署。`-SkipInstall` 仅适用于已经具备冻结依赖的情况。以下示例显式传入与脚本当前默认值相同的本机 Bun 路径；部署命令仍须先确认工具链和构建实现通过验证：

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\packages\cli\script\build-win.ps1 -Bun 'D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe' -BuildOnly
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\packages\cli\script\build-win.ps1 -Bun 'D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe' -NoDeploy
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File .\packages\cli\script\build-win.ps1 -Bun 'D:\Program\bun\node_modules\@oven\bun-windows-x64\bin\bun.exe' -DeployRoot 'D:\Program\opencode'
```

**验收边界**：本技能不代替实际构建与部署验证。执行默认部署前，核对 `packages/cli/script/windows-build.ts` 和 `packages/cli/script/windows-runtime.ts` 的版本来源、单文件复制及冲突保护，并通过专项测试；未验证的构建产物不能视为合格部署。若其他材料与当前脚本不一致，以核实后的实现和验收结果为准。

需验证时，在 `packages/cli` 运行 `bun test script/windows-build.test.ts`，从根目录运行 `bun run check`；针对版本来源、隔离 smoke、改名 exe 的 `--version`、单文件哈希及同名拒绝覆盖做专项检查。不得用本技能中的目标行为替代实际测试结果。
