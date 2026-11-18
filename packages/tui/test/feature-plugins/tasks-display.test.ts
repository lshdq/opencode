import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createPanelState } from "../../src/context/panel"
import { createTaskQueueFeed } from "../../src/feature-plugins/system/tasks-data"
import { createTaskQueueDisplay, TASK_QUEUE_PANEL } from "../../src/feature-plugins/system/tasks-display"
import { taskQueue } from "../fixture/task-queue"

function fixture() {
  return createRoot((dispose) => {
    const [route, navigate] = createSignal("home")
    const panels = createPanelState()
    const base = taskQueue({ tasks: [taskQueue().tasks[0], { ...taskQueue().tasks[0], id: "tqt_two", position: 1 }] })
    let api = { list: () => new Promise<never>(() => {}), get: async () => base }
    const feed = createTaskQueueFeed(() => api)
    feed.directory(base.directory)
    const opened: string[] = []
    const display = createTaskQueueDisplay({
      feed, route, navigate,
      panel: panels.current,
      open: (sessionID) => { opened.push(sessionID); panels.open({ plugin: "tasks", name: TASK_QUEUE_PANEL, sessionID }) },
      close: () => panels.release("tasks"),
    })
    const update = (revision: number, input: Partial<typeof base> = {}) => {
      const value = { ...base, ...input, time: { created: 1, updated: revision } }
      feed.update(value)
      return value
    }
    return { base, display, feed, panels, route, navigate, opened, update,
      replace() { api = { ...api } },
      [Symbol.dispose]() { feed.dispose(); dispose() },
    }
  })
}

test("app-owned follow waits for a session, follows subsequent tasks, pauses for history and keeps terminal results", () => {
  using setup = fixture()
  const running = setup.update(2, { status: "running", currentTaskID: "tqt_one" })
  setup.display.prepare()(running, () => {})
  expect(setup.opened).toEqual([])
  const first = { ...running.tasks[0], sessionID: "ses_one", status: "completed" as const }
  setup.update(3, { status: "running", currentTaskID: first.id, tasks: [first, running.tasks[1]] })
  expect(setup.route()).toBe("ses_one")
  expect(setup.display.following()).toBe(true)
  setup.update(4, { status: "running", currentTaskID: "tqt_two", tasks: [first, running.tasks[1]] })
  expect(setup.route()).toBe("ses_one")
  const second = { ...running.tasks[1], sessionID: "ses_two", status: "running" as const }
  const next = setup.update(5, { status: "running", currentTaskID: second.id, tasks: [first, second] })
  expect(setup.route()).toBe("ses_two")
  setup.navigate("ses_one")
  expect(setup.display.following()).toBe(false)
  expect(setup.panels.current()?.sessionID).toBe("ses_one")
  setup.display.follow()
  expect(setup.route()).toBe("ses_two")
  setup.display.view(next, "ses_one")
  expect(setup.display.following()).toBe(false)
  setup.update(6, { status: "done", tasks: [first, { ...second, status: "blocked", reason: "Need credentials" }] })
  expect(setup.route()).toBe("ses_one")
  setup.display.follow()
  expect(setup.route()).toBe("ses_two")
  expect(setup.display.info()?.status).toBe("done")
  expect(setup.panels.current()?.sessionID).toBe("ses_two")
})

test("manual departure, closing and replacing panels do not steal navigation or other panels", () => {
  using setup = fixture()
  const value = setup.update(2, { status: "running", currentTaskID: "tqt_one", tasks: [{ ...setup.base.tasks[0], sessionID: "ses_one" }] })
  setup.display.prepare()(value, () => {})
  setup.panels.close()
  setup.update(3, { ...value, tasks: [{ ...value.tasks[0], sessionID: "ses_two" }] })
  expect(setup.route()).toBe("ses_one")
  expect(setup.panels.current()).toBeUndefined()
  setup.display.view(value, "ses_one")
  setup.panels.open({ plugin: "diff", name: "diff", sessionID: "ses_one" })
  setup.update(4, { ...value, tasks: [{ ...value.tasks[0], sessionID: "ses_three" }] })
  expect(setup.panels.current()?.plugin).toBe("diff")
  expect(setup.route()).toBe("ses_one")
  setup.display.view(value, "ses_one")
  setup.display.follow()
  setup.navigate("ses_unrelated")
  setup.update(5, { ...value, tasks: [{ ...value.tasks[0], sessionID: "ses_four" }] })
  expect(setup.route()).toBe("ses_unrelated")
  expect(setup.display.following()).toBe(false)
  expect(setup.panels.current()).toBeUndefined()
})

test("late start intents cannot navigate after departure, a new SDK, reset or a newer view intent", () => {
  using setup = fixture()
  const value = setup.update(2, { status: "done", tasks: [{ ...setup.base.tasks[0], sessionID: "ses_result" }] })
  const left = setup.display.prepare()
  setup.navigate("ses_elsewhere")
  left(value, () => {})
  expect(setup.opened).toEqual([])
  const obsolete = setup.display.prepare()
  setup.replace()
  obsolete(value, () => {})
  expect(setup.opened).toEqual([])
  const reset = setup.display.prepare()
  setup.display.reset()
  reset(value, () => {})
  expect(setup.opened).toEqual([])
  const older = setup.display.prepare()
  const latest = setup.display.prepare()
  older(value, () => {})
  expect(setup.opened).toEqual([])
  latest(value, () => {})
  expect(setup.route()).toBe("ses_result")
})

test("no-session selection is inert and a very fast batch can reveal its final session after the dialog closes", () => {
  using setup = fixture()
  const accept = setup.display.prepare()
  const value = setup.update(3, { status: "done", tasks: [{ ...setup.base.tasks[0], status: "completed", sessionID: "ses_final" }] })
  accept(value, () => {})
  expect(setup.route()).toBe("ses_final")
  setup.display.view(value, "ses_not_created")
  expect(setup.route()).toBe("ses_final")
  expect(setup.display.following()).toBe(true)
})

test("choosing another panel before start resolves or while waiting for the first session cancels automatic takeover", () => {
  using setup = fixture()
  const value = setup.update(2, { status: "running", currentTaskID: "tqt_one" })
  const pending = setup.display.prepare()
  setup.panels.open({ plugin: "diff", name: "diff", sessionID: "ses_existing" })
  pending(value, () => {})
  expect(setup.display.following()).toBe(false)
  setup.display.prepare()(value, () => {})
  expect(setup.display.following()).toBe(true)
  setup.panels.open({ plugin: "other", name: "other", sessionID: "ses_existing" })
  setup.update(3, { ...value, tasks: [{ ...value.tasks[0], sessionID: "ses_one" }] })
  expect(setup.route()).toBe("home")
  expect(setup.panels.current()?.plugin).toBe("other")
  expect(setup.opened).toEqual([])
})

test("same-service SDK refresh empties stale facts but keeps follow intent for the refreshed feed", () => {
  using setup = fixture()
  const value = setup.update(2, { status: "running", currentTaskID: "tqt_one", tasks: [{ ...setup.base.tasks[0], sessionID: "ses_one" }] })
  setup.display.prepare()(value, () => {})
  setup.replace()
  setup.feed.capture()
  expect(setup.display.info()).toBeUndefined()
  expect(setup.display.following()).toBe(true)
  setup.update(3, { ...value, tasks: [{ ...value.tasks[0], sessionID: "ses_two" }] })
  expect(setup.route()).toBe("ses_two")
  expect(setup.display.following()).toBe(true)
})

test("a pending display action cannot cross a directory lifetime even if the SDK stays identical", () => {
  using setup = fixture()
  const pending = setup.display.prepare()
  const result = { ...setup.base, status: "done" as const,
    tasks: [{ ...setup.base.tasks[0], status: "completed" as const, sessionID: "ses_old_directory" }] }
  setup.feed.directory("D:\\another-project")
  pending(result, () => { throw new Error("Old directory must not reveal a dialog or panel") })
  expect(setup.opened).toEqual([])
  expect(setup.route()).toBe("home")
  expect(setup.display.following()).toBe(false)
  expect(setup.display.info()).toBeUndefined()
  expect(setup.panels.current()).toBeUndefined()
})

test.each(["same", "other"] as const)("explicit %s-batch viewing supersedes an unconsumed automatic reveal and its late acceptance", (target) => {
  using setup = fixture()
  const running = setup.update(2, { status: "running", currentTaskID: "tqt_two", tasks: [
    { ...setup.base.tasks[0], status: "completed", sessionID: "ses_history" }, setup.base.tasks[1],
  ] })
  let reveals = 0
  const accept = setup.display.prepare()
  accept(running, () => { reveals++; return false })
  expect(setup.display.following()).toBe(true)
  expect(setup.opened).toEqual([])
  const viewed = target === "same" ? running : taskQueue({ id: "tq_other", status: "done",
    tasks: [{ ...setup.base.tasks[0], status: "completed", sessionID: "ses_history" }] })
  setup.display.view(viewed, "ses_history")
  expect(setup.route()).toBe("ses_history")
  expect(setup.display.info()?.id).toBe(viewed.id)
  expect(setup.display.visible()).toBe(true)
  expect(setup.display.following()).toBe(false)
  expect(setup.panels.current()?.sessionID).toBe("ses_history")
  expect(setup.opened).toEqual(["ses_history"])
  expect(reveals).toBe(0)

  const late = { ...running, time: { created: 1, updated: 3 }, tasks: [running.tasks[0],
    { ...running.tasks[1], status: "running" as const, sessionID: "ses_late" },
  ] }
  setup.feed.update(late)
  // The explicit intent must also invalidate an older in-flight acceptance.
  accept(late, () => { throw new Error("An obsolete acceptance must not regain automatic reveal") })
  expect(setup.route()).toBe("ses_history")
  expect(setup.display.info()?.id).toBe(viewed.id)
  expect(setup.display.visible()).toBe(true)
  expect(setup.display.following()).toBe(false)
  expect(setup.opened).toEqual(["ses_history"])
  expect(reveals).toBe(0)
})

test("viewing the current route invalidates an older acceptance even without a route change", () => {
  using setup = fixture()
  const value = setup.update(2, { status: "running", currentTaskID: "tqt_two", tasks: [
    { ...setup.base.tasks[0], status: "completed", sessionID: "ses_history" }, setup.base.tasks[1],
  ] })
  setup.navigate("ses_history")
  const accept = setup.display.prepare()
  setup.display.view(value, "ses_history")
  accept(value, () => { throw new Error("The explicit view must invalidate in-flight acceptance") })
  expect(setup.route()).toBe("ses_history")
  expect(setup.display.visible()).toBe(true)
  expect(setup.display.following()).toBe(false)
  expect(setup.panels.current()?.sessionID).toBe("ses_history")
  expect(setup.opened).toEqual(["ses_history"])
})

// TC-013: an unavailable task is not a new viewing intent. It must preserve
// both an in-flight acceptance and an already accepted, unconsumed reveal.
test.each(["before", "after"] as const)("no-session view %s acceptance leaves the pending automatic reveal intact", (stage) => {
  using setup = fixture()
  const running = setup.update(2, { status: "running", currentTaskID: "tqt_two" })
  let reveals = 0
  const reveal = () => { reveals++ }
  const accept = setup.display.prepare()
  if (stage === "after") accept(running, reveal)
  setup.display.view(running, "ses_not_created")
  expect(setup.route()).toBe("home")
  expect(setup.opened).toEqual([])
  expect(setup.panels.current()).toBeUndefined()
  expect(reveals).toBe(0)
  if (stage === "before") accept(running, reveal)
  expect(setup.display.info()?.id).toBe(running.id)
  expect(setup.display.following()).toBe(true)
  expect(setup.display.visible()).toBe(true)
  setup.update(3, { status: "running", currentTaskID: "tqt_two", tasks: [running.tasks[0],
    { ...running.tasks[1], status: "running", sessionID: "ses_first" },
  ] })
  expect(setup.route()).toBe("ses_first")
  expect(setup.panels.current()?.sessionID).toBe("ses_first")
  expect(setup.opened).toEqual(["ses_first"])
  expect(setup.display.following()).toBe(true)
  expect(reveals).toBe(1)
})
