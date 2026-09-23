import { expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Global } from "@opencode/util/global"
import { FileMode } from "@opencode/util/file-mode"
import { FileModeWindows } from "@opencode/util/file-mode-windows"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "../src/database/database"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { SqlClient } from "effect/unstable/sql"
import { acl, grantEveryone } from "../../util/test/fixture/file-acl"
import { interruptDuringACL } from "../../util/test/fixture/file-mode-fiber"

test.skipIf(process.platform !== "win32")("credential database and WAL/SHM remain private across real close, reopen and checkpoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-sqlite-acl-中文 ' "))
  const filename = path.join(root, "credentials.sqlite")
  const sibling = path.join(root, "unrelated.txt")
  try {
    // A custom location is prepared explicitly by its owner, not by the driver.
    await FileMode.directory(root, { owned: true })
    await writeFile(sibling, "unrelated")
    const before = await acl(sibling)
    const parent = await acl(root)
    const global = Global.make({ home: root, data: root, config: root, state: root, cache: root, tmp: root, bin: root, repos: root, log: root })
    for (const reopen of [false, true]) {
      if (reopen) await grantEveryone(filename)
      await Effect.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        if (!reopen) {
          yield* database.db.run(sql`INSERT INTO credential (id, label, value, time_created, time_updated) VALUES ('acl-fixture', 'fixture', '{"type":"api","key":"fixture-not-a-secret"}', 1, 1)`)
        }
        const row = yield* database.db.get<{ id: string }>(sql`SELECT id FROM credential WHERE id = 'acl-fixture'`)
        expect(row?.id).toBe("acl-fixture")
        yield* database.db.run(sql`UPDATE credential SET time_updated = time_updated + 1 WHERE id = 'acl-fixture'`)
        for (const suffix of ["", "-wal", "-shm"]) {
          yield* Effect.promise(() => stat(filename + suffix))
          const found = yield* Effect.promise(() => acl(filename + suffix))
          expect(found.protected).toBe(suffix === "")
          expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
          expect(found.rules.every((rule) => rule.allow && rule.inherited === (suffix !== ""))).toBe(true)
        }
        yield* database.db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        yield* database.db.run(sql`UPDATE credential SET time_updated = time_updated + 1 WHERE id = 'acl-fixture'`)
        for (const suffix of ["-wal", "-shm"]) {
          const found = yield* Effect.promise(() => acl(filename + suffix))
          expect(found.rules.every((rule) => rule.inherited)).toBe(true)
          expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
        }
      }).pipe(
        Effect.provide(Database.layer({ path: filename })),
        Effect.provideService(Global.Service, global),
        Effect.scoped,
      ))
      // SQLite must still be allowed to delete its sidecars on final close.
      await expect(stat(filename + "-wal")).rejects.toThrow()
      await expect(stat(filename + "-shm")).rejects.toThrow()
    }
    expect((await acl(sibling)).sddl).toBe(before.sddl)
    expect((await acl(root)).sddl).toBe(parent.sddl)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)

test("in-memory SQLite keeps its existing execution semantics", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    yield* client`CREATE TABLE fixture (value INTEGER)`
    yield* client`INSERT INTO fixture VALUES (42)`
    expect(yield* client<{ value: number }>`SELECT value FROM fixture`).toEqual([{ value: 42 }])
  }).pipe(Effect.provide(sqliteLayer({ filename: ":memory:" })), Effect.scoped))
})

test.skipIf(process.platform !== "win32")("SQLite batches new, reopened and retained-sidecar permission work into one host per acquisition", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-sqlite-batch-"))
  const filename = path.join(root, "fixture.sqlite")
  const durations: number[] = []
  const execute = FileModeWindows.execute
  // Observe the real bounded executor, without substituting any ACL operation.
  const observer = spyOn(FileModeWindows, "execute").mockImplementation(async (script, variables, options) => {
    const started = performance.now()
    try {
      return await execute(script, variables, options)
    } finally {
      if (variables.OPENCODE_ACL_PATH === filename) durations.push(performance.now() - started)
    }
  })
  const open = Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    yield* client`CREATE TABLE IF NOT EXISTS fixture (value TEXT)`
    yield* client`INSERT INTO fixture VALUES ('batch-fixture')`
  }).pipe(Effect.provide(sqliteLayer({ filename, privateDirectory: true })), Effect.scoped)
  try {
    await Effect.runPromise(open)
    expect(durations).toHaveLength(1)
    await expect(stat(filename + "-wal")).rejects.toThrow()
    await Effect.runPromise(open)
    expect(durations).toHaveLength(2)
    const { Database } = await import("bun:sqlite")
    const held = new Database(filename)
    try {
      held.query("SELECT * FROM fixture").all()
      for (const suffix of ["-wal", "-shm"]) await stat(filename + suffix)
      await Effect.runPromise(open)
      expect(durations).toHaveLength(3)
      expect(held.query("SELECT count(*) AS count FROM fixture").get()).toEqual({ count: 3 })
    } finally {
      held.close()
    }
    console.info("SQLite ACL host durations (new/reopen/retained, ms):", durations.map(Math.round))
  } finally {
    observer.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32")("SQLite acquisition interruption joins permission host close before cleanup or retry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-db-fiber-"))
  const filename = path.join(root, "private.sqlite")
  const operation = Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient
    yield* client`CREATE TABLE fixture (id INTEGER)`
  }).pipe(Effect.provide(sqliteLayer({ filename, privateDirectory: true })), Effect.scoped)
  try {
    await interruptDuringACL(root, operation)
    expect((await stat(filename)).size).toBe(0)
    await Effect.runPromise(operation)
    expect((await stat(filename)).size).toBeGreaterThan(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32")("Bun driver tightens existing shared WAL/SHM before exposing a reopened client", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-sqlite-existing-sidecars-"))
  const filename = path.join(root, "credentials.sqlite")
  await FileMode.directory(root, { owned: true })
  const { Database } = await import("bun:sqlite")
  const held = new Database(filename)
  try {
    held.run("PRAGMA journal_mode = WAL")
    held.run("CREATE TABLE credential (value TEXT)")
    held.run("INSERT INTO credential VALUES ('fixture-existing')")
    for (const suffix of ["", "-wal", "-shm"]) await grantEveryone(filename + suffix)
    const before = await acl(root)
    await Effect.runPromise(Effect.gen(function* () {
      const client = yield* SqlClient.SqlClient
      // Check immediately on layer acquisition, before the client issues SQL.
      for (const suffix of ["", "-wal", "-shm"]) {
        const found = yield* Effect.promise(() => acl(filename + suffix))
        expect(found.protected).toBe(true)
        expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
      }
      expect(yield* client<{ value: string }>`SELECT value FROM credential`).toEqual([{ value: "fixture-existing" }])
      yield* client`UPDATE credential SET value = 'reopened'`
    }).pipe(Effect.provide(sqliteLayer({ filename })), Effect.scoped))
    expect(held.query("SELECT value FROM credential").get()).toEqual({ value: "reopened" })
    expect((await acl(root)).sddl).toBe(before.sddl)
  } finally {
    held.close()
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)

test.skipIf(process.platform !== "win32")("Node driver uses real node:sqlite and reopens private WAL/SHM", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-node-sqlite-acl-"))
  try {
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "fixture/sqlite-node-permissions.ts")],
      target: "node",
    })
    expect(build.success).toBe(true)
    const fixture = path.join(root, "node-test.mjs")
    await Bun.write(fixture, build.outputs[0])
    const child = Bun.spawn(["node", fixture, path.join(root, "credentials.sqlite")], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    expect(await child.exited, await stderr).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
