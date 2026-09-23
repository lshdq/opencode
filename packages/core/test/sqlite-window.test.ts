import { expect, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Global } from "@opencode/util/global"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "../src/database/database"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { SqlClient } from "effect/unstable/sql"
import { acl } from "../../util/test/fixture/file-acl"
import { restrictedReader, windowSecret } from "../../util/test/fixture/restricted-reader"

test.skipIf(process.platform !== "win32")("unsafe custom SQLite parent is rejected without modifying directory, sibling, database or creating sidecars", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-custom-db-refusal-"))
  const filename = path.join(root, "existing.sqlite")
  try {
    await writeFile(filename, "existing-user-data-not-sqlite")
    await writeFile(path.join(root, "sibling"), "unrelated")
    const before = await Promise.all([root, filename, path.join(root, "sibling")].map(acl))
    for (const file of [filename, path.join(root, "new.sqlite")]) {
      await expect(Effect.runPromise(Effect.gen(function* () {
        yield* SqlClient.SqlClient
      }).pipe(Effect.provide(sqliteLayer({ filename: file })), Effect.scoped))).rejects.toThrow("Unsafe custom SQLite directory")
    }
    expect(await readFile(filename, "utf8")).toBe("existing-user-data-not-sqlite")
    expect((await Promise.all([root, filename, path.join(root, "sibling")].map(acl))).map((item) => item.sddl)).toEqual(before.map((item) => item.sddl))
    for (const file of ["new.sqlite", "existing.sqlite-wal", "existing.sqlite-shm"]) await expect(stat(path.join(root, file))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

for (const runtime of ["bun", "node"] as const) {
  test.skipIf(process.platform !== "win32")(`${runtime}: restricted reader cannot acquire a main/WAL/SHM handle at birth or normal recreation`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-db-birth-"))
    const directory = path.join(root, "app-owned-data")
    const filename = path.join(directory, "credential.sqlite")
    await mkdir(directory)
    const outside = await acl(root)
    const fixture = path.join(root, "node-window.mjs")
    if (runtime === "node") {
      const build = await Bun.build({ entrypoints: [path.join(import.meta.dir, "fixture/sqlite-window-node.ts")], target: "node" })
      expect(build.success).toBe(true)
      await Bun.write(fixture, build.outputs[0])
    }
    const reader = restrictedReader([filename, filename + "-wal", filename + "-shm"], root)
    try {
      await reader.ready()
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
            if (!reopen) yield* database.db.run(sql`INSERT INTO credential (id, label, value, time_created, time_updated) VALUES ('window', 'fixture', ${JSON.stringify({ type: "api", key: windowSecret })}, 1, 1)`)
            expect(yield* database.db.get(sql`SELECT value FROM credential WHERE id = 'window'`)).toEqual({ value: JSON.stringify({ type: "api", key: windowSecret }) })
            for (const suffix of ["-wal", "-shm"]) {
              const found = yield* Effect.promise(() => acl(filename + suffix))
              expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
              expect(found.rules.every((rule) => rule.inherited && rule.allow)).toBe(true)
            }
          }).pipe(
            Effect.provide(Database.layer({ path: filename, privateDirectory: true })),
            Effect.provideService(Global.Service, Global.make({ home: root, data: directory, config: root, state: root, cache: root, tmp: root, bin: root, log: root, repos: root })),
            Effect.scoped,
          ))
          await expect(stat(filename + "-wal")).rejects.toThrow()
          await expect(stat(filename + "-shm")).rejects.toThrow()
        }
      }
      expect(reader.state.done).toBe(false)
      const observed = await reader.close()
      expect(observed.opened).toBe(0)
      expect(observed.denied).toBeGreaterThan(0)
      expect(observed.readSecret).toBe(false)
      expect((await acl(directory)).protected).toBe(true)
      expect((await acl(root)).sddl).toBe(outside.sddl)
    } finally {
      await reader.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 45_000)
}
