import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { FileMode } from "@opencode/util/file-mode"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { sqliteLayer } from "../../src/database/sqlite.node"
import { acl, grantEveryone } from "../../../util/test/fixture/file-acl"

const filename = process.argv[2]
assert(filename)
await FileMode.directory(path.dirname(filename), { owned: true })
for (const reopen of [false, true]) {
  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!reopen) {
      yield* sql`CREATE TABLE credential (id TEXT PRIMARY KEY, value TEXT NOT NULL)`
      yield* sql`INSERT INTO credential (id, value) VALUES ('fixture', 'not-a-secret')`
    }
    const rows = yield* sql<{ id: string }>`SELECT id FROM credential`
    assert.equal(rows[0]?.id, "fixture")
    if (reopen) {
      const values = yield* sql<{ value: string }>`SELECT value FROM credential`
      assert.equal(values[0]?.value, "after-checkpoint")
    }
    yield* sql`UPDATE credential SET value = 'updated-fixture'`
    for (const suffix of ["", "-wal", "-shm"]) {
      const found = yield* Effect.promise(() => acl(filename + suffix))
      assert.equal(found.protected, suffix === "")
      assert.deepEqual(found.rules.map((rule) => rule.sid), [found.current])
      assert(found.rules.every((rule) => rule.allow && rule.inherited === (suffix !== "")))
    }
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`
    yield* sql`UPDATE credential SET value = 'after-checkpoint'`
  }).pipe(Effect.provide(sqliteLayer({ filename })), Effect.scoped))
  // The next iteration must recreate both files after the last connection
  // closes; observing a pre-existing private sidecar is not sufficient.
  await assert.rejects(stat(filename + "-wal"), { code: "ENOENT" })
  await assert.rejects(stat(filename + "-shm"), { code: "ENOENT" })
}

// TC-008: also cover files retained by another connection, rather than only
// sidecars recreated after the last connection closes.
const held = new DatabaseSync(filename)
try {
  held.exec("SELECT * FROM credential")
  for (const suffix of ["", "-wal", "-shm"]) await grantEveryone(filename + suffix)
  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const suffix of ["", "-wal", "-shm"]) {
      const found = yield* Effect.promise(() => acl(filename + suffix))
      assert.equal(found.protected, true)
      assert.deepEqual(found.rules.map((rule) => rule.sid), [found.current])
    }
    const values = yield* sql<{ value: string }>`SELECT value FROM credential`
    assert.equal(values[0]?.value, "after-checkpoint")
    yield* sql`UPDATE credential SET value = 'existing-sidecars'`
  }).pipe(Effect.provide(sqliteLayer({ filename })), Effect.scoped))
  assert.equal(held.prepare("SELECT value FROM credential").get()?.value, "existing-sidecars")
} finally {
  held.close()
}
await assert.rejects(stat(filename + "-wal"), { code: "ENOENT" })
await assert.rejects(stat(filename + "-shm"), { code: "ENOENT" })
