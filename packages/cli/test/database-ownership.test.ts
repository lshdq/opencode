import { expect, test } from "bun:test"
import path from "node:path"
import { databaseOptions } from "../src/database-path"

test("only the default app-owned database parent can be tightened", () => {
  const previous = process.env.OPENCODE_DB
  const root = path.resolve("fixture-app-data")
  try {
    delete process.env.OPENCODE_DB
    expect(databaseOptions(root).privateDirectory).toBe(true)
    expect(path.dirname(databaseOptions(root).path)).toBe(root)
    for (const filename of ["", "custom.db", path.resolve("elsewhere", "custom.db"), ":memory:"]) {
      process.env.OPENCODE_DB = filename
      expect(databaseOptions(root).privateDirectory).toBe(false)
      expect(databaseOptions(root).path).toBe(filename === ":memory:" ? filename : path.resolve(root, filename))
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_DB
    else process.env.OPENCODE_DB = previous
  }
})
