import path from "node:path"
import { expect } from "bun:test"
import { LanguageModel, LLMClient } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Form } from "@opencode/core/form"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ModelsDev } from "@opencode/core/models-dev"
import { Plugin } from "@opencode/core/plugin"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionContext } from "@opencode/core/session/context"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTitle } from "@opencode/core/session/title"
import { Skill } from "@opencode/core/skill"
import { Snapshot } from "@opencode/core/snapshot"
import { TaskQueue } from "@opencode/core/task-queue"
import { TaskQueuePlanning } from "@opencode/core/task-queue/planning"
import { Tool } from "@opencode/core/tool"
import { TaskQueuePlanTool } from "@opencode/core/tool/plugin/task-queue-plan"
import { SkillTool } from "@opencode/core/tool/plugin/skill"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { registerToolPlugin, toolIdentity } from "./lib/tool"

// Actual runner, registry, leaf planning tool, Form, persistence and execution coordinator.
// Only the LLM transport is scripted; a malicious write tool needs no permission to show
// that planning's catalog/execution boundary, rather than its prompt, prevents writes.
it.live("real planning tool gates writes, checks workflow capability, asks once per stage and continues the same Session after manual start", () => Effect.gen(function* () {
  const directory = AbsolutePath.make((yield* tmpdirScoped("pq-")).path)
  const llm = yield* TestLLM.Test
  const layer = AppNodeBuilder.build(LayerNode.group([TaskQueue.configured({ judge: () => Effect.succeed({ verdict: "done", reason: "fixture artifact verified" }) }),
    TaskQueuePlanning.node, Session.node, Bus.node, Database.node, LocationServiceMap.node]), [
    LayerNodePlatform.llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
    Config.node.replace(Config.testLayer([])), ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
    PluginSupervisor.node.replace(Layer.empty), Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
    Snapshot.node.replace(Snapshot.noopLayer), SessionTitle.node.replace(Layer.succeed(SessionTitle.Service, { generate: () => Effect.void })),
    SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(SessionRunnerModel.resolved(
      LanguageModel.make({ id: "planning-script", provider: "test", route: OpenAIChat.route }),
      { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 32_000 } },
    )) })),
  ])
  yield* Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const queues = yield* TaskQueue.Service
      const sessions = yield* Session.Service
      const tools = yield* Tool.Service
      const agents = yield* Agent.Service
      const skills = yield* Skill.Service
      const forms = yield* Form.Service
      const bus = yield* Bus.Service
      yield* agents.transform((editor) => {
        for (const id of [Agent.defaultID, Agent.ID.make("plan")]) editor.update(id, (agent) => {
          agent.mode = "primary"
          agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
        })
      })
      yield* skills.transform((editor) => editor.remove("dev-workflow"))
      yield* registerToolPlugin(TaskQueuePlanTool.Plugin)
      const writes: string[] = []
      yield* tools.transform((editor) => editor.add({ name: "mutate", description: "Write an artifact", options: { codemode: false },
        input: Schema.Struct({ text: Schema.String }), output: Schema.String,
        execute: (input) => Effect.promise(async () => {
          writes.push(input.text)
          await Bun.write(path.join(directory, "artifact.txt"), input.text)
          return { output: input.text, content: input.text }
        }),
      }))
      yield* tools.transform((editor) => {
        for (const name of ["shell", "subagent"]) editor.add({ name, description: "Forbidden planning capability", options: { codemode: false },
          input: Schema.Struct({ text: Schema.String }), output: Schema.String,
          execute: (input) => Effect.sync(() => { writes.push(name); return { output: input.text, content: input.text } }),
        })
      })
      const created = yield* bus.subscribe(Form.Event.Created).pipe(Stream.toQueue({ capacity: 10 }))
      yield* llm.push(
        TestLLM.toolCall("cannot-write", "mutate", { text: "forbidden" }),
        TestLLM.toolCall("missing-workflow", "task_queue_plan", { stage: "requirements", version: 0, type: "development", requirements: "开发", acceptance: ["标准"], dependencies: [] }),
        TestLLM.toolCall("requirements", "task_queue_plan", { stage: "requirements", version: 0, type: "other", requirements: "研究需求全文", acceptance: ["产出artifact"], dependencies: [] }),
        TestLLM.toolCall("proposal", "task_queue_plan", { stage: "proposal", version: 1, proposal: "研究方案全文" }),
        TestLLM.text("方案保存，等待用户手动开始；请开启自动接受权限。", "ready"),
      )
      const queue = yield* queues.create({ directory, tasks: [{ prompt: "研究并产出artifact" }] })
      yield* queues.plan(queue.id)
      const requirements = (yield* Queue.take(created)).data.form
      expect(requirements.metadata).toMatchObject({ stage: "requirements", version: 1 })
      const root = Session.ID.make(requirements.sessionID)
      const context = yield* SessionContext.Service
      yield* sessions.switchAgent({ sessionID: root, agent: Agent.ID.make("build") })
      const selected = yield* context.select(root)
      expect(selected.agent.id).toBe(Agent.ID.make("plan"))
      expect(selected.tools.definitions.map((tool) => tool.name)).toContain("task_queue_plan")
      expect(selected.tools.definitions.map((tool) => tool.name)).not.toContain("mutate")
      expect(selected.tools.definitions.map((tool) => tool.name)).not.toContain("execute")
      for (const name of ["shell", "subagent", "execute", "mutate"]) {
        expect(selected.tools.definitions.map((tool) => tool.name)).not.toContain(name)
        expect(yield* selected.tools.execute({ sessionID: root, ...toolIdentity,
          call: { type: "tool-call", id: `forged-${name}`, name, input: { text: "forbidden" } },
        }).pipe(Effect.flip)).toMatchObject({ _tag: "Tool.Error", message: expect.stringContaining("read-only") })
      }
      const child = yield* sessions.create({ parentID: root })
      expect((yield* context.select(child.id)).tools.definitions.map((tool) => tool.name)).not.toContain("task_queue_plan")
      const ordinary = yield* sessions.create({ location: { directory } })
      expect((yield* context.select(ordinary.id)).tools.definitions.map((tool) => tool.name)).not.toContain("task_queue_plan")
      yield* forms.reply({ id: requirements.id, answer: { decision: "confirm" } })
      const proposal = (yield* Queue.take(created)).data.form
      expect(proposal.metadata).toMatchObject({ stage: "proposal", version: 2 })
      expect(proposal.fields[0]).toMatchObject({ custom: false, options: [{ value: "auto" }, { value: "interactive" }, { value: "revise" }] })
      yield* forms.reply({ id: proposal.id, answer: { decision: "auto" } })
      const ready = yield* awaitQueue(queues, queue.id, (value) => value.phase === "ready")
      expect(ready.tasks[0]?.plan?.approval).toMatchObject({ version: 2, formID: proposal.id, choice: "auto", answer: { decision: "auto" } })
      expect(writes).toEqual([])
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "artifact.txt")).exists())).toBe(false)
      expect((yield* llm.requests()).length).toBe(5)
      yield* llm.push(TestLLM.toolCall("actual-write", "mutate", { text: "approved execution" }), TestLLM.text("Verified artifact", "finished"))
      yield* queues.start(queue.id)
      const done = yield* awaitQueue(queues, queue.id, (value) => value.status === "done")
      expect(done.tasks[0]).toMatchObject({ status: "completed", sessionID: root })
      expect(done.snapshot).toContain("任务队列")
      expect(writes).toEqual(["approved execution"])
      expect(yield* Effect.promise(() => Bun.file(path.join(directory, "artifact.txt")).text())).toBe("approved execution")
    }).pipe(Effect.provide(locations.get({ directory })))
  }).pipe(Effect.provide(layer))
}).pipe(Effect.provide(TestLLM.testLayer())))

// TC-002/006: availability or an assistant claim is not a skill load. Exercise the actual
// skill leaf and persisted runner tool messages before permitting development approval.
it.live("requires actual dev-workflow loading before genuine development requirements approval", () => Effect.gen(function* () {
  const directory = AbsolutePath.make((yield* tmpdirScoped("pd-")).path)
  const llm = yield* TestLLM.Test
  const layer = AppNodeBuilder.build(LayerNode.group([TaskQueue.node, TaskQueuePlanning.node, Session.node, Bus.node, Database.node, LocationServiceMap.node, FSUtil.node]), [
    LayerNodePlatform.llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
    Config.node.replace(Config.testLayer([])), ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
    PluginSupervisor.node.replace(Layer.empty), Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
    Snapshot.node.replace(Snapshot.noopLayer), SessionTitle.node.replace(Layer.succeed(SessionTitle.Service, { generate: () => Effect.void })),
    SessionRunnerModel.node.replace(Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(SessionRunnerModel.resolved(
      LanguageModel.make({ id: "development-planning-script", provider: "test", route: OpenAIChat.route }),
      { capabilities: { tools: true, input: ["text"], output: ["text"] }, cost: [], limit: { context: 200_000, output: 32_000 } },
    )) })),
  ])
  yield* Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const queues = yield* TaskQueue.Service
      const sessions = yield* Session.Service
      const agents = yield* Agent.Service
      const skills = yield* Skill.Service
      const forms = yield* Form.Service
      const bus = yield* Bus.Service
      const skillPath = AbsolutePath.make(path.join(directory, ".opencode", "skills", "dev-workflow", "SKILL.md"))
      const content = "# dev-workflow\n阶段1需求确认，阶段2方案与模式审批；阶段3-7必须等批次手动开始。"
      yield* Effect.promise(() => Bun.write(skillPath, content))
      yield* skills.transform((editor) => editor.add({ id: Skill.ID.make("dev-workflow"), name: Skill.Name.make("dev-workflow"), path: skillPath, content }))
      yield* agents.transform((editor) => editor.update(Agent.ID.make("plan"), (agent) => {
        agent.mode = "primary"
        agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
      }))
      yield* registerToolPlugin(SkillTool.Plugin)
      yield* registerToolPlugin(TaskQueuePlanTool.Plugin)
      const created = yield* bus.subscribe(Form.Event.Created).pipe(Stream.toQueue({ capacity: 10 }))
      const input = { stage: "requirements", version: 0, type: "development", requirements: "开发需求", acceptance: ["真实验收"], dependencies: [] } as const
      yield* llm.push(
        TestLLM.toolCall("claimed-loaded", "task_queue_plan", input),
        TestLLM.toolCall("actually-load", "skill", { id: "dev-workflow" }),
        TestLLM.toolCall("confirmed-loaded", "task_queue_plan", input),
        TestLLM.toolCall("development-proposal", "task_queue_plan", { stage: "proposal", version: 1, proposal: "完整方案；独立测试与审查在手动开始后执行" }),
        TestLLM.text("方案已保存，等待手动开始。", "ready"),
      )
      const queue = yield* queues.create({ directory, tasks: [{ prompt: "开发任务" }] })
      yield* queues.plan(queue.id)
      const requirements = (yield* Queue.take(created)).data.form
      const root = Session.ID.make(requirements.sessionID)
      expect(requirements.metadata).toMatchObject({ stage: "requirements", version: 1 })
      const history = yield* sessions.context(root)
      const calls = history.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [])
      expect(calls.some((part) => part.id === "claimed-loaded" && part.state.status === "error" && JSON.stringify(part.state).includes("Load dev-workflow"))).toBe(true)
      expect(calls.some((part) => part.name === "skill" && part.state.status === "completed")).toBe(true)
      yield* forms.reply({ id: requirements.id, answer: { decision: "confirm" } })
      const proposal = (yield* Queue.take(created)).data.form
      expect(proposal.metadata).toMatchObject({ stage: "proposal", version: 2 })
      yield* forms.reply({ id: proposal.id, answer: { decision: "auto" } })
      const ready = yield* awaitQueue(queues, queue.id, (value) => value.phase === "ready")
      expect(ready).toMatchObject({ status: "queued", tasks: [{ status: "ready", plan: { type: "development", mode: "auto" } }] })
      expect(ready.snapshot).toBeUndefined()
      expect((yield* sessions.get(root)).agent).toBe(Agent.ID.make("plan"))
      expect((yield* llm.requests()).length).toBe(5)
    }).pipe(Effect.provide(locations.get({ directory })))
  }).pipe(Effect.provide(layer))
}).pipe(Effect.provide(TestLLM.testLayer())))

function awaitQueue(queues: TaskQueue.Interface, id: TaskQueue.ID, check: (queue: TaskQueue.Info) => boolean) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (true) {
      const queue = yield* queues.get(id)
      if (check(queue)) return queue
      if (Date.now() >= deadline) return yield* Effect.die(new Error(`Queue did not transition: ${JSON.stringify(queue)}`))
      yield* Effect.sleep("1 millis")
    }
  })
}
