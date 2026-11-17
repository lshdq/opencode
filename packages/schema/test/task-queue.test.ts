import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest.js"
import { AbsolutePath } from "../src/schema.js"
import { TaskQueue } from "../src/task-queue.js"

describe("task queue contracts", () => {
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
