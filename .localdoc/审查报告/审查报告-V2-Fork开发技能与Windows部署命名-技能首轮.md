# 代码审查：V2 Fork 开发技能与 Windows 部署命名（技能首轮）

- 独立审查：`task-standard` 会话 `ses_f2df14d9affePLyb8jcS87xWFQ`；只读检查了三个技能及其原始快照、需求和测试报告。
- 阻塞 1：`.opencode/skills/fork-development/SKILL.md`、`.opencode/skills/merge-upstream/SKILL.md` 被上级 `D:\works\git\.gitignore` 忽略，在普通提交和新检出中不会交付。修复分派：仓库 `.gitignore` 精确放行本次相关技能，保留其他本地配置的忽略。
- 阻塞 2：全局 `github-retry` skill 的 `pull upstream v2` 示例可绕过 `merge-upstream` 合并前审查与用户确认。修复分派：改为 fetch 示例并写明 pull 的前置条件。
- 应改：0；可选：0。以上项修复后必须按流程重新验证、独立测试和独立审查。
