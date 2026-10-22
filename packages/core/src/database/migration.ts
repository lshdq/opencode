export * as DatabaseMigration from "./migration.js"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { supportsForeignKeyToggle } from "#sqlite"
import type { EffectDrizzleSqlite } from "./drizzle.js"
import { migrations } from "./migration.gen.js"
import schema from "./schema.gen.js"
import { Global } from "@opencode/util/global"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]

export type Migration = {
  id: string
  foreignKeys?: boolean
  up: (tx: Transaction) => Effect.Effect<void, unknown, Global.Service>
}

// Not serialized here: the Database layer holds a lock scoped to the database
// it is bootstrapping, since two instances over one file must not race.
export function apply(db: Database) {
  return Effect.gen(function* () {
    // OpenCode owns the unprefixed table namespace. Embedders sharing this
    // database may own underscore-prefixed tables, which bootstrap ignores.
    const tables = yield* db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'`,
    )
    if (tables.some((table) => table.name === "session" || table.name === "session_v2"))
      return yield* applyOnly(db, migrations)
    if (tables.length > 0) return yield* Effect.die(new Error("Database is not empty and has no session table"))
    yield* bootstrap(db)
  })
}

// Multi-user hosts point several processes at one shared database file, and
// the Database layer's semaphore only serializes within a process: two
// processes can both read an empty sqlite_master before either commits. SQLite
// itself serializes the bootstrap transactions, so the loser rolls back
// atomically and adopts the winner's committed schema instead of dying on it.
function bootstrap(db: Database) {
  return Effect.gen(function* () {
    const started = Date.now()
    yield* Effect.logInfo("database schema bootstrap started", { migrations: migrations.length })
    const outcome = yield* Effect.result(
      db.transaction((tx) =>
        Effect.gen(function* () {
          yield* schema.up(tx)
          yield* tx.run(
            sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
          )
          yield* Effect.forEach(migrations, (migration) =>
            tx.run(
              sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
            ),
          )
        }),
      ),
    )
    if (outcome._tag === "Success") {
      return yield* Effect.logInfo("database schema bootstrap completed", {
        migrations: migrations.length,
        durationMs: Date.now() - started,
      })
    }
    // A fresh read only sees committed schema, and the winner may still hold
    // the write lock when the loser's transaction fails (SQLITE_BUSY), so poll
    // a few times with short delays; the bounded wait stays far below
    // busy_timeout (5s).
    for (const delay of [0, 250, 500]) {
      if (delay > 0) yield* Effect.sleep(delay)
      const winner = yield* db.get(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND (name = ${"session"} OR name = ${"session_v2"})`,
      )
      if (!winner) continue
      yield* Effect.logInfo("database schema bootstrap committed by concurrent process", {
        migrations: migrations.length,
        durationMs: Date.now() - started,
      })
      return yield* applyOnly(db, migrations)
    }
    yield* Effect.logError("database schema bootstrap failed", {
      migrations: migrations.length,
      durationMs: Date.now() - started,
      error: outcome.failure,
    })
    return yield* Effect.fail(outcome.failure)
  })
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        const named = (yield* db.all<{ name: string }>(
          sql`SELECT name FROM pragma_table_info('__drizzle_migrations')`,
        )).some((column) => column.name === "name")

        if (named) {
          yield* db.run(sql`
            INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
            SELECT name, ${Date.now()}
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE name IS NOT NULL
          `)
        }

        if (!named) {
          const entries = yield* db.all<{ created_at: number; prefix: string | null }>(sql`
            SELECT created_at, strftime('%Y%m%d%H%M%S', created_at / 1000, 'unixepoch') AS prefix
            FROM ${sql.identifier("__drizzle_migrations")}
            WHERE created_at IS NOT NULL
          `)

          for (const entry of entries) {
            const migration = input.find((item) => item.id.startsWith(`${entry.prefix}_`))
            if (!migration) {
              return yield* Effect.die(
                new Error(`Legacy migration timestamp ${entry.created_at} does not match any known migration`),
              )
            }
            yield* db.run(sql`
              INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
              VALUES (${migration.id}, ${Date.now()})
            `)
          }
        }
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      const started = Date.now()
      yield* Effect.logInfo("database migration started", { migration: migration.id })
      const apply = db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
      const run =
        migration.foreignKeys !== false
          ? apply
          : Effect.gen(function* () {
              // Durable Object SQLite rejects the foreign_keys toggle; the closest
              // allowlisted relaxation is deferring enforcement to transaction commit.
              const relaxForeignKeys = supportsForeignKeyToggle
                ? db.run(sql`PRAGMA foreign_keys = OFF`)
                : db.run(sql`PRAGMA defer_foreign_keys = ON`)
              const restoreForeignKeys = supportsForeignKeyToggle
                ? Effect.asVoid(db.run(sql`PRAGMA foreign_keys = ON`))
                : Effect.void
              yield* relaxForeignKeys
              yield* apply.pipe(Effect.ensuring(restoreForeignKeys.pipe(Effect.orDie)))
            })
      const outcome = yield* Effect.result(run)
      if (outcome._tag === "Success") {
        yield* Effect.logInfo("database migration completed", {
          migration: migration.id,
          durationMs: Date.now() - started,
        })
        continue
      }
      // Processes sharing one database file (multi-user hosts) also race
      // individual migration transactions. The loser's rollback is atomic, so
      // when a fresh journal read finds the winner's record the migration is
      // done; only a missing record means this failure is real.
      const recorded = yield* db.get(sql`SELECT id FROM ${sql.identifier("migration")} WHERE id = ${migration.id}`)
      if (!recorded) {
        yield* Effect.logError("database migration failed", {
          migration: migration.id,
          durationMs: Date.now() - started,
          error: outcome.failure,
        })
        return yield* Effect.fail(outcome.failure)
      }
      yield* Effect.logInfo("database migration committed by concurrent process", {
        migration: migration.id,
        durationMs: Date.now() - started,
      })
    }
  })
}
