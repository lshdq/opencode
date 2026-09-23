import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FSUtil } from "../src/fs-util.js"
import { acl } from "./fixture/file-acl.js"

test.skipIf(process.platform !== "win32")("FSUtil only tightens explicit private modes and can overwrite read-only ACL files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-fs-mode-"))
  try {
    const untouched = path.join(root, "ordinary")
    await writeFile(untouched, "ordinary")
    const before = await acl(untouched)
    await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      yield* fs.writeJson(path.join(root, "private.json"), { fixture: true }, 0o600)
      yield* fs.writeWithDirs(path.join(root, "nested", "private.txt"), "fixture", 0o400)
      yield* fs.writeWithDirs(path.join(root, "nested", "private.txt"), "updated", 0o600)
      yield* fs.writeWithDirs(untouched, "updated ordinary")
      yield* fs.writeJson(path.join(root, "shared.json"), {}, 0o644)
    }).pipe(Effect.provide(FSUtil.layer), Effect.provide(NodeFileSystem.layer)))
    for (const file of [path.join(root, "private.json"), path.join(root, "nested", "private.txt")]) {
      const found = await acl(file)
      expect(found.protected).toBe(true)
      expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
    }
    expect(await readFile(path.join(root, "nested", "private.txt"), "utf8")).toBe("updated")
    expect((await acl(untouched)).sddl).toBe(before.sddl)
    expect((await acl(path.join(root, "shared.json"))).protected).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
