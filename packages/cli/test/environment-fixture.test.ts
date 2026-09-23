import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FileMode } from "@opencode/util/file-mode"
import { acl } from "../../util/test/fixture/file-acl"
import { isolatedEnv, isolatedRoot } from "./fixture/environment"

test.skipIf(process.platform !== "win32")(
  "shared fixture prepares its custom DB parent before initial WAL writes",
  async () => {
    const root = await isolatedRoot("opencode-fixture-private-")
    try {
      const env = isolatedEnv(root)
      expect(path.dirname(env.OPENCODE_DB!)).toBe(root)
      await FileMode.directory(root)
      const db = new Database(env.OPENCODE_DB!)
      try {
        db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('fixture')")
        for (const suffix of ["", "-wal", "-shm"]) {
          const found = await acl(env.OPENCODE_DB! + suffix)
          expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
          expect(found.rules.every((rule) => rule.inherited && rule.allow)).toBe(true)
        }
      } finally {
        db.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)

test.skipIf(process.platform !== "win32")(
  "custom DB overrides never transfer fixture ownership to an unrelated parent",
  async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "opencode-fixture-outside-"))
    const root = await isolatedRoot("opencode-fixture-owned-")
    try {
      const before = await acl(outside)
      const env = isolatedEnv(root, { OPENCODE_DB: path.join(outside, "custom.db") })
      expect(env.OPENCODE_DB).toBe(path.join(outside, "custom.db"))
      expect((await acl(outside)).sddl).toBe(before.sddl)
      expect(await Bun.file(env.OPENCODE_DB!).exists()).toBe(false)
    } finally {
      await Promise.all([root, outside].map((dir) => rm(dir, { recursive: true, force: true })))
    }
  },
  30_000,
)
