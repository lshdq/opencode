import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FSUtil } from "../src/fs-util.js"
import { interruptDuringACL } from "./fixture/file-mode-fiber.js"

for (const kind of ["json", "string", "bytes"] as const) {
  test.skipIf(process.platform !== "win32")(`FSUtil ${kind} Fiber.interrupt joins ACL close before returning`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-fs-fiber-"))
    const file = path.join(root, "private")
    const operation = Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      yield* kind === "json"
        ? fs.writeJson(file, { value: "fixture" }, 0o600)
        : fs.writeWithDirs(file, kind === "string" ? "fixture" : new TextEncoder().encode("fixture"), 0o600)
    }).pipe(Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer))
    try {
      await interruptDuringACL(root, operation)
      expect(await readFile(file, "utf8")).toBe("")
      await Effect.runPromise(operation)
      expect(await readFile(file, "utf8")).toContain("fixture")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
