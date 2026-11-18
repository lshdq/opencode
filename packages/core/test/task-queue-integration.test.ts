import path from "node:path"
import fs from "node:fs/promises"
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
import { Instance } from "@opencode/core/instance/service"
import { Job } from "@opencode/core/job"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { ModelsDev } from "@opencode/core/models-dev"
import { Plugin } from "@opencode/core/plugin"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTitle } from "@opencode/core/session/title"
import { SessionStore } from "@opencode/core/session/store"
import { Snapshot } from "@opencode/core/snapshot"
import { TaskQueue } from "@opencode/core/task-queue"
import { Tool } from "@opencode/core/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// TC-001/002/006/028: only the model transport/selection is scripted. The queue, default
// generate judge, SessionRunnerLLM, inbox delivery, execution coordinator and file I/O are real.
it.live(
  "real runner delivers queue input, continues the same Session and shares files without revisiting completed tasks",
  () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped("qi-")).path
      const directory = AbsolutePath.make(path.join(root, "project"))
      yield* Effect.promise(() => fs.mkdir(directory))
      const llm = yield* TestLLM.Test
      const context = yield* Layer.build(
        AppNodeBuilder.build(
          LayerNode.group([
            TaskQueue.node,
            Bus.node,
            Session.node,
            SessionStore.node,
            SessionExecution.node,
            Database.node,
            Instance.node,
            Job.node,
            LocationServiceMap.node,
          ]),
          [
            LayerNodePlatform.llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
            Config.node.replace(Config.testLayer([])),
            ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
            PluginSupervisor.node.replace(Layer.empty),
            Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
            Snapshot.node.replace(Snapshot.noopLayer),
            SessionTitle.node.replace(Layer.succeed(SessionTitle.Service, { generate: () => Effect.void })),
            SessionRunnerModel.node.replace(
              Layer.succeed(SessionRunnerModel.Service, {
                resolve: () =>
                  Effect.succeed(
                    SessionRunnerModel.resolved(
                      LanguageModel.make({ id: "queue-script", provider: "test", route: OpenAIChat.route }),
                      {
                        capabilities: { tools: true, input: ["text"], output: ["text"] },
                        cost: [],
                        limit: { context: 200_000, output: 32_000 },
                      },
                    ),
                  ),
              }),
            ),
          ],
        ),
      )
      yield* Effect.gen(function* () {
        const queues = yield* TaskQueue.Service
        const sessions = yield* Session.Service
        const operations: string[] = []
        yield* Agent.Service.use((agents) =>
          agents.transform((editor) =>
            editor.update(Agent.defaultID, (agent) => {
              agent.mode = "primary"
              agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
            }),
          ),
        ).pipe(Effect.provide((yield* LocationServiceMap.Service).get({ directory })))
        yield* Tool.Service.use((tools) =>
          tools.transform((editor) =>
            editor.add({
              name: "queuefile",
              description: "Write or read the two fixture files",
              options: { codemode: false },
              input: Schema.Struct({ operation: Schema.Literals(["x", "y", "read"]) }),
              output: Schema.Struct({ text: Schema.String }),
              execute: (input) =>
                Effect.promise(async () => {
                  operations.push(input.operation)
                  if (input.operation !== "read") {
                    await Bun.write(path.join(directory, `${input.operation}.txt`), input.operation)
                    return { output: { text: input.operation }, content: input.operation }
                  }
                  const text =
                    (await Bun.file(path.join(directory, "x.txt")).text()) +
                    (await Bun.file(path.join(directory, "y.txt")).text())
                  return { output: { text }, content: text }
                }),
            }),
          ),
        ).pipe(Effect.provide((yield* LocationServiceMap.Service).get({ directory })))

        yield* llm.push(
          TestLLM.toolCall("write-x", "queuefile", { operation: "x" }),
          TestLLM.text("Only X is written", "early"),
          TestLLM.text('{"verdict":"continue","reason":"Y is missing","next_step":"write Y"}', "review-1"),
          TestLLM.toolCall("write-y", "queuefile", { operation: "y" }),
          TestLLM.text("X and Y are written", "finished"),
          TestLLM.text('{"verdict":"done","reason":"Both files exist"}', "review-2"),
          TestLLM.toolCall("read-files", "queuefile", { operation: "read" }),
          TestLLM.text("Read xy from the previous task", "read"),
          TestLLM.text('{"verdict":"done","reason":"Read previous files"}', "review-3"),
          TestLLM.text("External approval unavailable", "blocked"),
          TestLLM.text('{"verdict":"blocked","reason":"External approval unavailable"}', "review-4"),
        )
        const queue = yield* queues.create({
          directory,
          tasks: [
            { prompt: "Write X then Y using queuefile" },
            { prompt: "Read X and Y using queuefile" },
            { title: "Approval", prompt: "Wait for external approval" },
          ],
        })
        yield* queues.start(queue.id)
        const done = yield* untilDone(queues, queue.id)
        expect(done.tasks.filter((task) => task.status === "failed")).toEqual([])
        expect(done.tasks.map((task) => task.status)).toEqual(["completed", "completed", "blocked"])
        expect(done.tasks[0]?.rounds).toBe(1)
        expect(operations).toEqual(["x", "y", "read"])
        expect(new Set(done.tasks.map((task) => task.sessionID)).size).toBe(3)
        const originals = yield* Effect.forEach(done.tasks, (task) =>
          task.sessionID ? sessions.get(task.sessionID) : Effect.die("missing Session"),
        )
        expect(originals.map((session) => session.title)).toEqual([
          "Write X then Y using queuefile", "Read X and Y using queuefile", "Approval",
        ])
        expect(
          originals.every((session) => session.parentID === undefined && session.location.directory === directory),
        ).toBe(true)
        expect(yield* Effect.forEach(originals, (session) => sessions.inbox(session.id))).toEqual([[], [], []])
        const history = yield* sessions.context(originals[0]!.id)
        expect(history.filter((message) => message.type === "synthetic")).toHaveLength(2)
        expect(history.some((message) => message.type === "synthetic" && message.text.includes("Y is missing"))).toBe(
          true,
        )
        expect(
          (yield* sessions.context(originals[1]!.id)).some(
            (message) =>
              message.type === "assistant" &&
              message.content.some(
                (part) =>
                  part.type === "tool" &&
                  part.state.status === "completed" &&
                  JSON.stringify(part.state).includes("xy"),
              ),
          ),
        ).toBe(true)

        // Explicit done-resume retries just the blocked Session, not the writer or reader.
        yield* llm.push(
          TestLLM.text("Approval supplied", "released"),
          TestLLM.text('{"verdict":"done","reason":"Approval supplied"}', "review-5"),
        )
        yield* queues.resume(queue.id)
        const retried = yield* untilDone(queues, queue.id)
        expect(retried.tasks.map((task) => task.sessionID)).toEqual(done.tasks.map((task) => task.sessionID))
        expect(retried.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"])
        expect(operations).toEqual(["x", "y", "read"])
        expect(yield* SessionExecution.Service.use((execution) => execution.active)).toEqual(new Set())
        expect((yield* llm.requests()).length).toBe(13)

        // Deleting the batch retains the source marker. Public prompt/resume accept input but
        // cannot restart this old task; it remains parked, rather than bypassing the wake fence.
        yield* queues.remove(queue.id)
        yield* sessions.prompt({ sessionID: originals[0]!.id, text: "Manual input after batch deletion" })
        yield* sessions.resume(originals[0]!.id)
        yield* sessions.wait(originals[0]!.id)
        expect(yield* sessions.inbox(originals[0]!.id)).toMatchObject([
          { type: "user", payload: { text: "Manual input after batch deletion" } },
        ])
        expect((yield* llm.requests()).length).toBe(13)

        // Real fork projection copies metadata, but creates a new top-level Session. Neither
        // that independent fork nor its descendant may be stranded by the original tombstone.
        const fork = yield* sessions.fork({ sessionID: originals[0]!.id })
        const child = yield* sessions.create({ parentID: fork.id })
        const ordinary = yield* sessions.create({ location: { directory }, title: "Ordinary" })
        expect(fork.parentID).toBeUndefined()
        expect(fork.metadata?.source).toBe("taskqueue")
        for (const session of [fork, child, ordinary]) {
          yield* llm.push(TestLLM.text("Manual work completed", `manual-${session.id}`))
          // A real child completion also admits a report and wakes its independent parent.
          if (session.id === child.id) yield* llm.push(TestLLM.text("Child report received", "manual-child-report"))
          yield* sessions.prompt({ sessionID: session.id, text: "Perform manual work", resume: false })
          yield* sessions.resume(session.id)
          yield* sessions.wait(session.id)
          if (session.id === child.id) yield* sessions.wait(fork.id)
          expect(yield* sessions.inbox(session.id)).toEqual([])
          expect(
            (yield* sessions.context(session.id)).some(
              (message) =>
                message.type === "assistant" &&
                message.content.some((part) => part.type === "text" && part.text === "Manual work completed"),
            ),
          ).toBe(true)
        }
        expect((yield* llm.requests()).length).toBe(17)

        // TC-022/023: actual root + grandchild executions, with no subagent Job row,
        // and an image Job whose real scope cannot finish until the test releases it.
        const execution = yield* SessionExecution.Service
        const jobs = yield* Job.Service
        yield* llm.push(TestLLM.hangAfter())
        const stoppingQueue = yield* queues.create({
          directory,
          tasks: [
            { title: "Running root", prompt: "Keep working" },
            { title: "Must stay pending", prompt: "Do not start after stop" },
          ],
        })
        yield* queues.start(stoppingQueue.id)
        yield* llm.wait(18)
        const running = (yield* queues.get(stoppingQueue.id)).tasks[0]?.sessionID
        if (!running) return yield* Effect.die("running task has no Session")
        const descendant = yield* sessions.create({ parentID: running })
        const grandchild = yield* sessions.create({ parentID: descendant.id })
        yield* llm.push(TestLLM.hangAfter())
        yield* sessions.prompt({ sessionID: grandchild.id, text: "Grandchild work", resume: false })
        const grandchildRun = yield* execution.resume(grandchild.id).pipe(Effect.forkScoped)
        yield* llm.wait(19)
        expect(yield* execution.active).toEqual(new Set([running, grandchild.id]))
        // TC-008: exercise real coordinator/Location cleanup after retargeting, not only a fake executor.
        const target = path.join(root, "target")
        yield* Effect.promise(async () => {
          await fs.rename(directory, path.join(root, "saved"))
          await fs.mkdir(target)
        })
        yield* Effect.acquireRelease(
          Effect.promise(() => fs.symlink(target, directory, process.platform === "win32" ? "junction" : "dir")),
          () => Effect.promise(() => fs.unlink(directory)),
        )
        expect(yield* TaskQueue.canonicalDirectory(directory)).toBe(AbsolutePath.make(target))
        const started = yield* Deferred.make<void>()
        const cancelling = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid))
        yield* jobs.start({
          id: "queue-integration-image",
          type: "image",
          background: true,
          recovery: {
            kind: "image",
            sessionID: grandchild.id,
            path: path.join(directory, "image.png"),
            model: "test/image",
          },
          run: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.await(release)),
          ),
          cancel: Deferred.succeed(cancelling, undefined).pipe(Effect.asVoid),
        })
        yield* Deferred.await(started)
        const stopping = yield* queues.stop(stoppingQueue.id).pipe(Effect.forkScoped)
        yield* Deferred.await(cancelling)
        expect(stopping.pollUnsafe()).toBeUndefined()
        expect((yield* queues.get(stoppingQueue.id)).tasks[1]).toMatchObject({ status: "pending" })
        yield* sessions.synthetic({ sessionID: grandchild.id, text: "Late shell notification" })
        yield* execution.wake(running)
        expect((yield* llm.requests()).length).toBe(19)
        yield* Deferred.succeed(release, undefined)
        const stopped = yield* Fiber.join(stopping)
        yield* Fiber.await(grandchildRun)
        expect(stopped.status).toBe("stopped")
        expect(stopped.tasks.map((task) => task.status)).toEqual(["interrupted", "pending"])
        expect(stopped.tasks[1]?.sessionID).toBeUndefined()
        expect(yield* execution.active).toEqual(new Set())
        expect(yield* jobs.get("queue-integration-image")).toBeUndefined()
        yield* execution.resume(grandchild.id)
        expect((yield* llm.requests()).length).toBe(19)

        // A separately scoped real queue owner must also stop its run during shutdown despite drift.
        const scope = yield* Scope.make()
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
        const closingQueues = yield* TaskQueue.make.pipe(Scope.provide(scope))
        const closingDirectory = AbsolutePath.make(path.join(root, "closing"))
        yield* Effect.promise(() => fs.mkdir(closingDirectory))
        yield* Agent.Service.use((agents) => agents.transform((editor) =>
          editor.update(Agent.defaultID, (agent) => {
            agent.mode = "primary"
            agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
          }),
        )).pipe(Effect.provide((yield* LocationServiceMap.Service).get({ directory: closingDirectory })))
        const closing = yield* closingQueues.create({ directory: closingDirectory, tasks: [
          { prompt: "Keep working until shutdown" }, { prompt: "Must remain pending" },
        ] })
        yield* llm.push(TestLLM.hangAfter())
        yield* closingQueues.start(closing.id)
        yield* llm.wait(20)
        const closingSession = (yield* closingQueues.get(closing.id)).tasks[0]?.sessionID
        if (!closingSession) return yield* Effect.die("shutdown task has no Session")
        expect(yield* execution.active).toEqual(new Set([closingSession]))
        yield* Effect.promise(() => fs.rmdir(closingDirectory))
        yield* Effect.acquireRelease(
          Effect.promise(() => fs.symlink(target, closingDirectory, process.platform === "win32" ? "junction" : "dir")),
          () => Effect.promise(() => fs.unlink(closingDirectory)),
        )
        yield* Scope.close(scope, Exit.void)
        const closed = yield* closingQueues.get(closing.id)
        expect(closed).toMatchObject({ status: "stopped", reason: "server stopped", directory: closing.directory })
        expect(closed.tasks.map((task) => task.status)).toEqual(["interrupted", "pending"])
        expect(closed.tasks[0]?.sessionID).toBe(closingSession)
        expect(closed.tasks[1]?.sessionID).toBeUndefined()
        expect((yield* sessions.get(closingSession)).location.directory).toBe(closing.directory)
        expect(yield* execution.active).toEqual(new Set())
        expect((yield* llm.requests()).length).toBe(20)
      }).pipe(Effect.provide(context))
    }).pipe(Effect.provide(TestLLM.testLayer())),
)

function untilDone(queues: TaskQueue.Interface, id: TaskQueue.ID) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 10_000
    while (true) {
      const info = yield* queues.get(id)
      if (info.status === "done") return info
      if (Date.now() >= deadline) return yield* Effect.die(new Error(`queue did not finish: ${JSON.stringify(info)}`))
      yield* Effect.sleep("1 millis")
    }
  })
}
