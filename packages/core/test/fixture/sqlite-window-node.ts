import assert from "node:assert/strict"
import { stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { sqliteLayer } from "../../src/database/sqlite.node"
import { acl } from "../../../util/test/fixture/file-acl"

const filename = process.argv[2]
assert(filename)
const before = await acl(path.dirname(filename))
await assert.rejects(Effect.runPromise(Effect.gen(function* () {
  yield* SqlClient.SqlClient
}).pipe(Effect.provide(sqliteLayer({ filename })), Effect.scoped)))
assert.equal((await acl(path.dirname(filename))).sddl, before.sddl)
await assert.rejects(stat(filename), { code: "ENOENT" })
for (const reopen of [false, true]) {
  await Effect.runPromise(Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!reopen) yield* sql`CREATE TABLE credential (value TEXT)`
    if (!reopen) yield* sql`INSERT INTO credential VALUES ('ACL-WINDOW-FIXTURE-NOT-A-CREDENTIAL')`
    const rows = yield* sql<{ value: string }>`SELECT value FROM credential`
    assert.deepEqual(rows.map((row) => row.value), ["ACL-WINDOW-FIXTURE-NOT-A-CREDENTIAL"])
    for (const suffix of ["-wal", "-shm"]) {
      const found = yield* Effect.promise(() => acl(filename + suffix))
      assert.deepEqual(found.rules.map((rule) => rule.sid), [found.current])
      assert(found.rules.every((rule) => rule.inherited && rule.allow))
    }
  }).pipe(Effect.provide(sqliteLayer({ filename, privateDirectory: true })), Effect.scoped))
  await assert.rejects(stat(filename + "-wal"), { code: "ENOENT" })
  await assert.rejects(stat(filename + "-shm"), { code: "ENOENT" })
}
