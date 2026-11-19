import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest.js"
import { AbsolutePath } from "../src/schema.js"
import { TaskQueue } from "../src/task-queue.js"
import { Form } from "../src/form.js"

describe("task queue contracts", () => {
  test("only version-matched real Auto approval qualifies a complete plan", () => {
    const plan = TaskQueue.Plan.make({ version: 2, requirementsVersion: 1, type: "development", requirements: "需求全文", acceptance: ["标准"], dependencies: [], proposal: "完整方案",
      requirementsApproval: { version: 1, formID: Form.ID.create(), choice: "confirm", time: 1 },
      approval: { version: 2, formID: Form.ID.create(), choice: "auto", time: 2 }, mode: "auto" })
    expect(TaskQueue.approved(plan)).toBe(true)
    for (const choice of ["confirm", "interactive", "revise", "cancelled"] as const)
      expect(TaskQueue.approved({ ...plan, approval: { ...plan.approval!, choice } })).toBe(false)
    expect(TaskQueue.approved({ ...plan, version: 3 })).toBe(false)
    expect(TaskQueue.approved({ ...plan, requirementsVersion: 2 })).toBe(false)
    expect(TaskQueue.approved(undefined)).toBe(false)
    expect(Schema.encodeSync(TaskQueue.Plan)({ ...plan, proposal: undefined, approval: undefined, mode: undefined })).not.toHaveProperty("proposal")
  })
  test("IDs validate exactly the prefix they emit", () => {
    expect(TaskQueue.ID.create()).toStartWith("tq_")
    expect(TaskQueue.TaskID.create()).toStartWith("tqt_")
    expect(() => Schema.decodeUnknownSync(TaskQueue.ID)("sch_1")).toThrow()
    expect(() => Schema.decodeUnknownSync(TaskQueue.TaskID)("tq_1")).toThrow()
  })

  test("a queue encodes without undefined optional keys", () => {
    const info = TaskQueue.Info.make({
      id: TaskQueue.ID.make("tq_test"),
      directory: AbsolutePath.make("/project"),
      status: "queued",
      tasks: [
        {
          id: TaskQueue.TaskID.make("tqt_test"),
          title: "One",
          prompt: "do one",
          status: "pending",
          position: 1,
          rounds: 0,
          time: { created: 1, updated: 1 },
        },
      ],
      time: { created: 1, updated: 1 },
      title: undefined,
      reason: undefined,
      currentTaskID: undefined,
    })
    const encoded = Schema.encodeSync(TaskQueue.Info)(info)
    expect(encoded).not.toHaveProperty("title")
    expect(encoded).not.toHaveProperty("reason")
    expect(encoded).not.toHaveProperty("currentTaskID")
    expect(encoded.tasks[0]).not.toHaveProperty("sessionID")
    expect(encoded.tasks[0]).not.toHaveProperty("summary")
    expect(encoded.time).toEqual({ created: 1, updated: 1 })
  })

  test("a create input needs at least one ordered task with non-empty text", () => {
    const decode = Schema.decodeUnknownSync(TaskQueue.CreateInput)
    expect(
      decode({ directory: "/project", tasks: [{ title: "One", prompt: "do one" }, { title: "Two", prompt: "do two" }] }),
    ).toMatchObject({ directory: "/project", tasks: [{ title: "One" }, { title: "Two" }] })
    expect(() => decode({ directory: "/project", tasks: [] })).toThrow()
    expect(() => decode({ directory: "/project", tasks: [{ title: "", prompt: "do one" }] })).toThrow()
    expect(() => decode({ directory: "/project", tasks: [{ title: "One", prompt: "" }] })).toThrow()
    expect(() => decode({ directory: "/project", tasks: [{ prompt: " \t\r\n　" }] })).toThrow()
    const input = decode({ directory: "/project", tasks: [{ prompt: "\n 第一项 \n保留完整内容" }] })
    expect(Schema.encodeSync(TaskQueue.CreateInput)(input).tasks).toEqual([{ prompt: "\n 第一项 \n保留完整内容" }])
    expect(Schema.encodeSync(TaskQueue.TaskInput)(TaskQueue.TaskInput.make({ title: undefined, prompt: "Work" }))).toEqual({ prompt: "Work" })
  })

  test.each([
    ["\r\n \t\r\n  修复接口 😀  \r\n后续完整内容", "修复接口 😀"],
    ["\u2028\u2029名称\u2028内容", "名称"],
    [" \n\t", ""],
    ["中".repeat(80), "中".repeat(80)],
    ["中".repeat(78) + "😀😀😀", "中".repeat(78) + "😀…"],
  ])("derives a short Unicode-safe name from %j", (prompt, expected) => {
    expect(TaskQueue.titleFromPrompt(prompt)).toBe(expected)
  })

  test("taskqueue.updated is a current public event carrying the full info", () => {
    expect(TaskQueue.Event.Definitions).toEqual([TaskQueue.Event.Updated])
    expect(TaskQueue.Event.Updated.type).toBe("taskqueue.updated")
    expect(TaskQueue.Event.Updated.durability).toBe("ephemeral")
    expect(EventManifest.ServerDefinitions).toContain(TaskQueue.Event.Updated)
    expect(EventManifest.Latest.get("taskqueue.updated")).toBe(TaskQueue.Event.Updated)
    expect(EventManifest.Durable.has("taskqueue.updated")).toBe(false)
  })
})
