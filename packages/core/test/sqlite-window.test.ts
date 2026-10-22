import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Global } from "@opencode/util/global"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "../src/database/database"
import { acl } from "../../util/test/fixture/file-acl"

const sharedValue = "SHARED-WINDOW-FIXTURE-NOT-A-CREDENTIAL"

for (const runtime of ["bun", "node"] as const) {
  test.skipIf(process.platform !== "win32")(`${runtime}: database and sidecars keep inherited ACLs while open and across recreation`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-db-shared-"))
    const directory = path.join(root, "app-owned-data")
    const filename = path.join(directory, "shared.sqlite")
    await mkdir(directory)
    const outside = await acl(root)
    const before = await acl(directory)
    const fixture = path.join(root, "node-shared.mjs")
    if (runtime === "node") {
      const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/sqlite-window-node.ts")], target: "node" })
      expect(build.success).toBe(true)
      await Bun.write(fixture, build.outputs[0])
    }
    try {
      if (runtime === "node") {
        const child = Bun.spawn(["node", fixture, filename], { stdout: "ignore", stderr: "pipe" })
        const stderr = new Response(child.stderr).text()
        try {
          expect(await child.exited, await stderr).toBe(0)
        } finally {
          child.kill()
          await child.exited
        }
      }
      if (runtime === "bun") {
        for (const reopen of [false, true]) {
          await Effect.runPromise(Effect.gen(function* () {
            const database = yield* Database.Service
            if (!reopen) yield* database.db.run(sql`INSERT INTO credential (id, label, value, time_created, time_updated) VALUES ('window', 'fixture', ${JSON.stringify({ type: "api", key: sharedValue })}, 1, 1)`)
            expect(yield* database.db.get(sql`SELECT value FROM credential WHERE id = 'window'`)).toEqual({ value: JSON.stringify({ type: "api", key: sharedValue }) })
            for (const suffix of ["", "-wal", "-shm"]) {
              const found = yield* Effect.promise(() => acl(filename + suffix))
              expect(found.protected).toBe(false)
            }
          }).pipe(
            Effect.provide(Database.layer({ path: filename })),
            Effect.provideService(Global.Service, Global.make({ home: root, data: directory, config: root, state: root, cache: root, tmp: root, bin: root, log: root, repos: root })),
            Effect.scoped,
          ))
          await expect(stat(filename + "-wal")).rejects.toThrow()
          await expect(stat(filename + "-shm")).rejects.toThrow()
        }
      }
      expect((await acl(directory)).sddl).toBe(before.sddl)
      expect((await acl(root)).sddl).toBe(outside.sddl)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)
}
