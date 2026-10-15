import { expect, test } from "bun:test"
import { hasCustomAgent, resolveAgent, resolveDraftAgent } from "./agent"

test("hasCustomAgent detects only explicitly custom agents", () => {
  expect(hasCustomAgent([{ native: true }, { native: false }])).toBe(true)
  expect(hasCustomAgent([{ native: true }, {}])).toBe(false)
})

const agents = [{ name: "plan" }, { name: "build" }, { name: "custom" }]

const rows: { name: string; agents: { name: string }[]; requested?: string; expected: string }[] = [
  { name: "the requested available agent", agents, requested: "custom", expected: "custom" },
  {
    name: "build without a request",
    agents: [{ name: "reviewer" }, { name: "build" }],
    requested: undefined,
    expected: "build",
  },
  { name: "build for a missing agent", agents, requested: "missing", expected: "build" },
  {
    name: "the first agent when build is unavailable",
    agents: [{ name: "custom" }],
    requested: "missing",
    expected: "custom",
  },
]

test.each(rows)("resolveAgent uses $name", (row) => {
  expect(resolveAgent(row.agents, row.requested)?.name).toBe(row.expected)
})

test("resolveDraftAgent follows the catalog first agent for an untouched draft", () => {
  const initial = resolveDraftAgent([{ name: "build" }, { name: "reviewer" }], "draft")
  const refreshed = resolveDraftAgent(
    [{ name: "reviewer" }, { name: "build" }],
    "draft",
    initial.selection,
  )

  expect(initial.item?.name).toBe("build")
  expect(refreshed.item?.name).toBe("reviewer")
})

test("resolveDraftAgent keeps a manual selection across catalog refreshes", () => {
  const selection = { draftID: "draft", name: "build" }
  const unavailable = resolveDraftAgent([], "draft", selection)
  const refreshed = resolveDraftAgent(
    [{ name: "reviewer" }, { name: "build" }],
    "draft",
    unavailable.selection,
  )

  expect(unavailable.item).toBeUndefined()
  expect(unavailable.selection).toBe(selection)
  expect(refreshed.item?.name).toBe("build")
  expect(refreshed.selection).toBe(selection)
})

test("resolveDraftAgent resets the selection when the draft changes", () => {
  const next = resolveDraftAgent(
    [{ name: "reviewer" }, { name: "build" }],
    "next-draft",
    { draftID: "draft", name: "build" },
  )

  expect(next.item?.name).toBe("reviewer")
  expect(next.selection).toEqual({ draftID: "next-draft" })
})
