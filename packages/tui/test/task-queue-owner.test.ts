import { expect, jest, test } from "bun:test"
import type { OpenCodeClient, TaskQueueInfo } from "@opencode/client"
import { createTaskQueueOwner } from "../src/util/task-queue-owner"
import { taskQueue } from "./fixture/task-queue"

function fixture(input: Partial<OpenCodeClient["experimental"]["taskQueue"]> = {}) {
  const timers = new Set<() => void>()
  const intervals: number[] = []
  const stops: string[] = []
  let beats = 0
  const api = {
    start: async () => taskQueue({ status: "running" }),
    resume: async () => taskQueue({ status: "running" }),
    heartbeat: async () => { beats++; return taskQueue({ status: "running" }) },
    stop: async (input: { queueID: string; reason?: string }) => { stops.push(input.reason ?? ""); return taskQueue({ status: "stopped" }) },
    ...input,
  }
  const owner = createTaskQueueOwner(() => api, (run, milliseconds) => {
    intervals.push(milliseconds)
    timers.add(run)
    return () => { timers.delete(run) }
  })
  return { owner, timers, intervals, stops, beats: () => beats }
}

test("observing other TUI's running batch never acquires or resumes it", async () => {
  const setup = fixture()
  setup.owner.observe(taskQueue({ status: "running" }))
  expect(setup.owner.owns("tq_fixture")).toBe(false)
  expect(setup.timers.size).toBe(0)
  await setup.owner.shutdown()
  expect(setup.stops).toEqual([])
})

test("failed start is not owned; successful start/resume share one application timer", async () => {
  const setup = fixture({ start: async () => { throw new Error("Forbidden") } })
  await expect(setup.owner.acquire("tq_fixture", "start")).rejects.toThrow("Forbidden")
  expect(setup.owner.owns("tq_fixture")).toBe(false)
  expect(setup.timers.size).toBe(0)
  await setup.owner.acquire("tq_fixture", "resume")
  expect(setup.owner.owns("tq_fixture")).toBe(true)
  expect(setup.intervals).toEqual([10_000])
  expect(setup.timers.size).toBe(1)
  await setup.owner.shutdown()
  expect(setup.stops[0]).toContain("TUI 已退出")
  expect(setup.timers.size).toBe(0)
})

test("panel-independent heartbeat retries after a single rejection and exit cancels renewal", async () => {
  const renewed = Promise.withResolvers<TaskQueueInfo>()
  let calls = 0
  const signals: AbortSignal[] = []
  const setup = fixture({ heartbeat: async (_, options) => {
    if (options?.signal) signals.push(options.signal)
    if (++calls === 1) throw new Error("offline")
    return renewed.promise
  } })
  await setup.owner.acquire("tq_fixture", "start")
  const tick = [...setup.timers][0]
  tick()
  // Drain the request's rejection/finally, not a real ten-second interval.
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(setup.owner.owns("tq_fixture")).toBe(true)
  tick()
  expect(calls).toBe(2)
  const stopped = setup.owner.shutdown()
  expect(signals[1].aborted).toBe(true)
  tick()
  expect(calls).toBe(2)
  expect(setup.timers.size).toBe(0)
  renewed.resolve(taskQueue({ status: "running" }))
  await stopped
  expect(setup.owner.owns("tq_fixture")).toBe(false)
  expect(setup.stops).toHaveLength(1)
})

test("multiple owned queues have a single timer, and one terminal queue does not cancel the other", async () => {
  const setup = fixture({ start: async ({ queueID }) => taskQueue({ id: queueID, status: "running" }) })
  await setup.owner.acquire("tq_first", "start")
  await setup.owner.acquire("tq_second", "start")
  expect(setup.timers.size).toBe(1)
  expect(setup.intervals).toEqual([10_000])
  setup.owner.observe(taskQueue({ id: "tq_first", status: "done" }))
  expect(setup.owner.owns("tq_second")).toBe(true)
  expect(setup.timers.size).toBe(1)
  await setup.owner.shutdown()
  expect(setup.timers.size).toBe(0)
  expect(setup.stops).toHaveLength(1)
})

test.each(["done", "stopped", "interrupted"] as const)("%s removes ownership and the last timer", async (status) => {
  const setup = fixture()
  await setup.owner.acquire("tq_fixture", "start")
  setup.owner.observe(taskQueue({ status, time: { created: 1, updated: 2 } }))
  expect(setup.owner.owns("tq_fixture")).toBe(false)
  expect(setup.timers.size).toBe(0)
  await setup.owner.shutdown()
  expect(setup.stops).toHaveLength(0)
})

test("terminal event arriving before start reply cannot resurrect an owner", async () => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const setup = fixture({ start: () => reply.promise })
  const starting = setup.owner.acquire("tq_fixture", "start")
  expect(setup.owner.acquire("tq_fixture", "start")).toBe(starting)
  setup.owner.observe(taskQueue({ status: "done", time: { created: 1, updated: 2 } }))
  reply.resolve(taskQueue({ status: "running" }))
  await starting
  expect(setup.owner.owns("tq_fixture")).toBe(false)
  expect(setup.timers.size).toBe(0)
  await setup.owner.shutdown()
})

test("a start finishing during exit is stopped, and shutdown is idempotent", async () => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const setup = fixture({ start: () => reply.promise })
  const starting = setup.owner.acquire("tq_fixture", "start")
  const closing = setup.owner.shutdown()
  expect(setup.owner.shutdown()).toBe(closing)
  reply.resolve(taskQueue({ status: "running" }))
  await starting
  await closing
  expect(setup.timers.size).toBe(0)
  expect(setup.stops).toHaveLength(1)
  await expect(setup.owner.acquire("tq_fixture", "resume")).rejects.toThrow("退出")
})

test("an unavailable stop endpoint cannot block normal teardown or restart renewal", async () => {
  const setup = fixture({ stop: async () => { throw new Error("server disconnected") } })
  await setup.owner.acquire("tq_fixture", "start")
  await setup.owner.shutdown()
  expect(setup.owner.owns("tq_fixture")).toBe(false)
  expect(setup.timers.size).toBe(0)
  await expect(setup.owner.acquire("tq_fixture", "resume")).rejects.toThrow("退出")
})

test("out-of-order events during start retain the newest terminal state", async () => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const setup = fixture({ start: () => reply.promise })
  const starting = setup.owner.acquire("tq_fixture", "start")
  try {
    setup.owner.observe(taskQueue({ status: "done", time: { created: 1, updated: 10 } }))
    setup.owner.observe(taskQueue({ status: "running", time: { created: 1, updated: 9 } }))
    reply.resolve(taskQueue({ status: "running", time: { created: 1, updated: 2 } }))
    expect((await starting).status).toBe("done")
    expect(setup.owner.owns("tq_fixture")).toBe(false)
    expect(setup.timers.size).toBe(0)
  } finally {
    reply.resolve(taskQueue({ status: "done" }))
    await starting
    await setup.owner.shutdown()
  }
})

test("a hanging stop is bounded by the shutdown deadline without real sleeps", async () => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const setup = fixture({ stop: () => reply.promise })
  jest.useFakeTimers()
  try {
    await setup.owner.acquire("tq_fixture", "start")
    const closing = setup.owner.shutdown()
    expect(setup.owner.owns("tq_fixture")).toBe(false)
    expect(setup.timers.size).toBe(0)
    jest.runOnlyPendingTimers()
    await closing
    await expect(setup.owner.acquire("tq_fixture", "resume")).rejects.toThrow("退出")
  } finally {
    reply.resolve(taskQueue({ status: "stopped" }))
    await setup.owner.shutdown()
    jest.useRealTimers()
  }
})

test("start succeeding after the shutdown deadline still sends exactly one stop", async () => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const setup = fixture({ start: () => reply.promise })
  jest.useFakeTimers()
  const starting = setup.owner.acquire("tq_fixture", "start")
  try {
    const closing = setup.owner.shutdown()
    jest.runOnlyPendingTimers()
    await closing
    expect(setup.stops).toHaveLength(0)
    reply.resolve(taskQueue({ status: "running" }))
    await starting
    expect(setup.stops).toHaveLength(1)
    expect(setup.timers.size).toBe(0)
    expect(setup.owner.shutdown()).toBe(closing)
  } finally {
    reply.resolve(taskQueue({ status: "running" }))
    await starting
    await setup.owner.shutdown()
    jest.useRealTimers()
  }
})

test.each([
  ["start/done", "start", "done"], ["start/stopped", "start", "stopped"], ["start/interrupted", "start", "interrupted"],
  ["resume/done", "resume", "done"], ["resume/stopped", "resume", "stopped"], ["resume/interrupted", "resume", "interrupted"],
] as const)("a %s pending action cannot reacquire from a later observed running, but a fresh explicit resume can", async (_, action, status) => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  let requests = 0
  const request = () => ++requests === 1 ? reply.promise : Promise.resolve(taskQueue({ status: "running", time: { created: 1, updated: 5 } }))
  const setup = fixture({ start: request, resume: request })
  try {
    const starting = setup.owner.acquire("tq_fixture", action)
    setup.owner.observe(taskQueue({ status, time: { created: 1, updated: 3 } }))
    setup.owner.observe(taskQueue({ status: "running", time: { created: 1, updated: 4 } }))
    reply.resolve(taskQueue({ status: "running", time: { created: 1, updated: 2 } }))
    expect((await starting).time.updated).toBe(4)
    expect(setup.owner.owns("tq_fixture")).toBe(false)
    expect(setup.timers.size).toBe(0)
    // A new explicit operation has its own qualification, not the previous pending history.
    expect((await setup.owner.acquire("tq_fixture", "resume")).time.updated).toBe(5)
    expect(setup.owner.owns("tq_fixture")).toBe(true)
  } finally {
    reply.resolve(taskQueue())
    await setup.owner.shutdown()
  }
})

test.each(["start", "resume"] as const)("old terminal events cannot disqualify a newer successful %s response", async (action) => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const setup = fixture({ [action]: () => reply.promise })
  try {
    const starting = setup.owner.acquire("tq_fixture", action)
    setup.owner.observe(taskQueue({ status: "running", time: { created: 1, updated: 4 } }))
    setup.owner.observe(taskQueue({ status: "stopped", time: { created: 1, updated: 1 } }))
    reply.resolve(taskQueue({ status: "running", time: { created: 1, updated: 2 } }))
    await starting
    expect(setup.owner.owns("tq_fixture")).toBe(true)
    expect(setup.timers.size).toBe(1)
    setup.owner.observe(taskQueue({ status: "done", time: { created: 1, updated: 5 } }))
    setup.owner.observe(taskQueue({ status: "running", time: { created: 1, updated: 6 } }))
    expect(setup.owner.owns("tq_fixture")).toBe(false)
    expect(setup.timers.size).toBe(0)
  } finally {
    reply.resolve(taskQueue())
    await setup.owner.shutdown()
  }
})

test.each(["start", "resume"] as const)("a completed pending %s is neither adopted nor stopped during exit", async (action) => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const setup = fixture({ [action]: () => reply.promise })
  const starting = setup.owner.acquire("tq_fixture", action)
  try {
    setup.owner.observe(taskQueue({ status: "done", time: { created: 1, updated: 3 } }))
    const closing = setup.owner.shutdown()
    reply.resolve(taskQueue({ status: "running", time: { created: 1, updated: 2 } }))
    expect((await starting).status).toBe("done")
    await closing
    expect(setup.owner.owns("tq_fixture")).toBe(false)
    expect(setup.timers.size).toBe(0)
    expect(setup.stops).toEqual([])
  } finally {
    reply.resolve(taskQueue())
    await starting
    await setup.owner.shutdown()
  }
})

test.each(["start", "resume"] as const)("a completed %s response cannot grant ownership from a newer observed run", async (action) => {
  const reply = Promise.withResolvers<TaskQueueInfo>()
  const setup = fixture({ [action]: () => reply.promise })
  try {
    const starting = setup.owner.acquire("tq_fixture", action)
    setup.owner.observe(taskQueue({ status: "running", time: { created: 1, updated: 4 } }))
    reply.resolve(taskQueue({ status: "done", time: { created: 1, updated: 2 } }))
    expect((await starting).time.updated).toBe(4)
    expect(setup.owner.owns("tq_fixture")).toBe(false)
    expect(setup.timers.size).toBe(0)
    await setup.owner.shutdown()
    expect(setup.stops).toEqual([])
  } finally {
    reply.resolve(taskQueue())
    await setup.owner.shutdown()
  }
})
