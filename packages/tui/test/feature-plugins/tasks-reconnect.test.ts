import { expect, test } from "bun:test"
import { OpenCode } from "@opencode/client"
import { createTaskQueueFeed } from "../../src/feature-plugins/system/tasks-data"
import { taskQueue } from "../fixture/task-queue"
import { json } from "../fixture/tui-client"

test.each(["success", "failure"] as const)("a replaced connection discards the old endpoint's in-flight detail %s", async (outcome) => {
  // TC-033: changing the live getter must not let an already-dispatched old GET
  // repopulate the replacement service's list or display its obsolete error.
  const requested = Promise.withResolvers<void>()
  const response = Promise.withResolvers<Response>()
  const previous = taskQueue({ id: "tq_previous_endpoint", title: "Previous endpoint only" })
  const replacement = taskQueue({ id: "tq_replacement_endpoint", title: "Replacement endpoint only" })
  const oldServer = Bun.serve({ port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith(`/${previous.id}`)) {
      requested.resolve()
      return response.promise
    }
    return json({ data: [previous] })
  } })
  const newServer = Bun.serve({ port: 0, fetch: () => json({ data: [replacement] }) })
  let client = OpenCode.make({ baseUrl: oldServer.url.toString() })
  const feed = createTaskQueueFeed(() => client.taskQueue)
  let detail: Promise<void> | undefined
  try {
    feed.directory(previous.directory)
    await feed.load()
    expect(feed.items()).toEqual([previous])
    detail = feed.get(previous.id)
    await requested.promise
    client = OpenCode.make({ baseUrl: newServer.url.toString() })
    // The production server.connected relay calls load on the existing feed.
    await feed.load()
    expect(feed.items()).toEqual([replacement])
    response.resolve(outcome === "success" ? json({ data: previous }) : new Response(null, { status: 503 }))
    await detail
    expect(feed.items()).toEqual([replacement])
    expect(feed.error()).toBeUndefined()
  } finally {
    response.resolve(json({ data: previous }))
    await detail
    feed.dispose()
    await Promise.all([oldServer.stop(true), newServer.stop(true)])
  }
})
