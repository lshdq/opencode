import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { sqliteLayer } from "../../src/database/sqlite.node"
import { acl } from "../../../util/test/fixture/file-acl"

const filename = process.argv[2]
assert(filename)
const before = await acl(path.dirname(filename))
for (const reopen of [false, true]) {
  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!reopen) yield* sql`CREATE TABLE shared (value TEXT)`
    if (!reopen) yield* sql`INSERT INTO shared VALUES ('SHARED-WINDOW-FIXTURE-NOT-A-CREDENTIAL')`
    const rows = yield* sql<{ value: string }>`SELECT value FROM shared`
    assert.deepEqual(rows.map((row) => row.value), ["SHARED-WINDOW-FIXTURE-NOT-A-CREDENTIAL"])
    for (const suffix of ["", "-wal", "-shm"]) {
      const found = yield* Effect.promise(() => acl(filename + suffix))
      assert.equal(found.protected, false)
    }
  }).pipe(Effect.provide(sqliteLayer({ filename })), Effect.scoped))
  // The next iteration must recreate both files after the last connection closes.
  await assert.rejects(stat(filename + "-wal"), { code: "ENOENT" })
  await assert.rejects(stat(filename + "-shm"), { code: "ENOENT" })
}
assert.equal((await acl(path.dirname(filename))).sddl, before.sddl)
