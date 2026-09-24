import { expect, test } from "bun:test"
import { createAppFixture } from "../../fixture/app"
import { tmpdir } from "../../fixture/fixture"
import { directory, json } from "../../fixture/tui-client"

const parentID = "ses_prompt_parent"
const childID = "ses_prompt_child"

test.each([
  { width: 100, animations: true },
  { width: 36, animations: false },
])("prompt footer keeps child activity visible at width $width with animations=$animations", async (options) => {
  await using state = await tmpdir()
  const session = (id: string, parentID?: string) => ({
    id, parentID, title: id, projectID: "proj_test", location: { directory },
    agent: "build", model: { providerID: "provider", id: "model" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  })
  const app = await createAppFixture({
    state: state.path,
    width: options.width,
    args: { sessionID: parentID },
    config: { animations: options.animations, tabs: { mode: "off" } },
    fetch(url) {
      if (url.pathname === `/api/session/${parentID}`) return json({ data: session(parentID) })
      if (url.pathname === `/api/session/${childID}`) return json({ data: session(childID, parentID) })
      if (url.pathname === "/api/session" && url.searchParams.get("parentID") === parentID)
        return json({ data: [session(childID, parentID)], cursor: {} })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
    },
  })

  try {
    await app.ready
    await app.waitForFrame((frame) => frame.includes("packages/tui"))
    const emit = (id: string, type: "session.execution.started" | "session.execution.succeeded") => {
      app.events.emit({
        id: `evt_${id}_${type}_${Date.now()}`,
        type,
        created: Date.now(),
        durable: { aggregateID: id, seq: 0, version: 1 },
        data: { sessionID: id },
        location: { directory },
      })
    }

    emit(childID, "session.execution.started")
    const child = await app.waitForFrame((frame) => frame.includes("Subagent working"))
    const footerRow = child.split("\n").findIndex((line) => line.includes("Subagent working"))
    expect(child).not.toContain("esc interrupt")
    expect(child).not.toContain("esc again to interrupt")
    if (!options.animations) expect(child).toContain("[⋯]")
    else {
      expect(child).not.toContain("[⋯]")
      // Keep the marker and label on the same footer row, not an unrelated animated row.
      expect(child.split("\n")[footerRow]).toMatch(
        /^\s*[■⬝]{8}[ \t]+Subagent working/,
      )
    }

    emit(parentID, "session.execution.started")
    const parent = await app.waitForFrame((frame) => frame.includes("esc interrupt") && !frame.includes("Subagent working"))
    expect(parent).not.toContain("Subagent working")

    emit(parentID, "session.execution.succeeded")
    await app.waitForFrame((frame) => frame.includes("Subagent working") && !frame.includes("esc interrupt"))
    emit(childID, "session.execution.succeeded")
    const idle = await app.waitForFrame((frame) => !frame.includes("Subagent working") && !frame.includes("esc interrupt"))
    expect(idle).toContain("packages/tui")
    if (options.animations) expect(idle.split("\n")[footerRow]).not.toMatch(/[■⬝]{8}/)
  } finally {
    await app[Symbol.asyncDispose]()
  }
})
