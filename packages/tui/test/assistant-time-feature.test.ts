import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

test.each([
  { width: 24, timestamps: true },
  { width: 90, timestamps: true },
  { width: 90, timestamps: false },
])("assistant footer uses creation time, width=$width enabled=$timestamps", async (input) => {
  await using state = await tmpdir()
  const created = new Date(2025, 1, 3, 4, 5, 6).getTime()
  const session = {
    id: "ses_creation_time",
    title: "Time fixture",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created, updated: created + 90_000 },
  }
  const messages = [
    { id: "user-time", type: "user", text: "hello", time: { created: created - 10_000 } },
    {
      id: "assistant-time", type: "assistant", agent: "build", model: { providerID: "test", id: "test" },
      finish: "stop",
      content: [{ type: "text", id: "text-time", text: "Time answer", time: { created, completed: created + 90_000 } }],
      time: { created, completed: created + 90_000 },
    },
  ]
  await using app = await createAppFixture({
    state: state.path,
    width: input.width,
    height: 30,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "off" }, session: { timestamps: input.timestamps } },
    fetch: async (url) => {
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
        return json({ data: [] })
    },
  })
  await app.ready
  await app.waitForFrame((frame) => frame.includes("Build"))
  const frame = app.captureCharFrame()
  if (!input.timestamps) {
    expect(frame).not.toContain("2025-02-03")
    return
  }
  expect(frame).toContain(input.width < 26 ? "2025-02-03 04:05" : "2025-02-03 04:05:06")
  expect(frame).not.toContain("04:06:36")
})
