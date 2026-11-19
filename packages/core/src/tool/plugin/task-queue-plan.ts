export * as TaskQueuePlanTool from "./task-queue-plan.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import { TaskQueue } from "@opencode/schema/task-queue"
import { Effect, Schema } from "effect"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { Skill } from "../../skill.js"
import { Session } from "../../session.js"
import { TaskQueuePlanning } from "../../task-queue/planning.js"
import { SkillTool } from "./skill.js"

export const Plugin = { id: "opencode.tool.task-queue-plan", effect: Effect.fn("TaskQueuePlanTool.Plugin")(function* (ctx: Context) {
  const planning = yield* TaskQueuePlanning.Service
  const forms = yield* Form.Service
  const permission = yield* Permission.Service
  const skills = yield* Skill.Service
  const sessions = yield* Session.Service
  yield* ctx.tool.transform((editor) => editor.add({
    name: "task_queue_plan", options: { codemode: false, permission: "question" },
    description: "Only for the active task-queue planning root. Submit requirements (type, full requirements, acceptance, earlier dependencies) for genuine user confirmation, then submit the full proposal with the returned version. This tool itself asks the unique workflow stage-2 three-choice question. Do not separately ask for mode/approval. Never claim approval from text. Auto prepares only; stop before phase 3 and wait for manual batch start. Revisions use the current version (0 for the first requirements).",
    input: TaskQueue.PlanInput, output: TaskQueue.Plan,
    execute: (input, context) => Effect.gen(function* () {
      yield* permission.assert({ action: "question", resources: ["*"], ...Permission.invocation(context) })
      const skill = input.stage === "requirements" && input.type === "development" ? yield* skills.get(Skill.ID.make("dev-workflow")) : undefined
      if (input.stage === "requirements" && input.type === "development" && !skill)
        return yield* new ToolFailure({ message: "Development planning is blocked: dev-workflow skill is unavailable. Do not skip it." })
      if (skill) yield* permission.assert({ action: "skill", resources: [skill.id], ...Permission.invocation(context) })
      if (skill) {
        const history = yield* sessions.context(context.sessionID)
        const loaded = history.some((message) => (message.type === "skill" && message.skill === skill.id) ||
          (message.type === "assistant" && message.content.some((part) => part.type === "tool" && part.name === "skill" &&
            part.state.status === "completed" && Schema.is(SkillTool.Input)(part.state.input) && part.state.input.id === skill.id)))
        if (!loaded) return yield* new ToolFailure({ message: "Load dev-workflow with the skill tool before confirming development requirements, then resubmit. A claim of loading it is not sufficient." })
      }
      const plan = yield* planning.submit(context.sessionID, input, forms)
      return { output: plan, content: JSON.stringify(plan) + (TaskQueue.approved(plan) ? "\n方案已保存。请开启自动接受权限（不解除显式 deny）。等待全部任务规划结束后手动开始；现在禁止执行阶段3。" : "\nNot approved for unattended execution. Continue planning; do not infer Auto from custom input.") }
    }).pipe(Effect.mapError((error) => error instanceof ToolFailure ? error : new ToolFailure({ message: error.message, error }))),
  })).pipe(Effect.orDie)
}) }
