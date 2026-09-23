import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"
import { ServiceRegistration } from "../src/services/service-registration"
import { acl, grantEveryone } from "../../util/test/fixture/file-acl"

test.skipIf(process.platform !== "win32")("service password migration/read/replacement and registration protect temporary and existing files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-service-acl-中文 ' "))
  const config = path.join(root, ServiceConfig.filename())
  const registration = path.join(root, "registration.json")
  const publications: string[] = []
  try {
    await writeFile(config, JSON.stringify({ password: "test-fixture-only" }))
    await grantEveryone(config)
    await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const checked = {
        ...fs,
        rename: (from: string, to: string) => Effect.gen(function* () {
          const found = yield* Effect.promise(() => acl(from))
          expect(found.protected).toBe(true)
          expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
          publications.push(to)
          yield* fs.rename(from, to)
        }),
      }
      yield* Effect.gen(function* () {
        expect(yield* ServiceConfig.password()).toBe("test-fixture-only")
        const existing = yield* Effect.promise(() => acl(config))
        expect(existing.rules.map((rule) => rule.sid)).toEqual([existing.current])
        yield* ServiceConfig.password("replacement-fixture-only")
        yield* ServiceConfig.password("second-fixture-only")
        yield* ServiceConfig.migrateConfig(config, path.join(root, "migrated.json"))
        // Existing destination is never truncated by a migration retry.
        yield* ServiceConfig.migrateConfig(config, path.join(root, "migrated.json"))
        // Only an actual exclusive-create collision is ignored; failed private
        // creation must propagate instead of looking like a successful migration.
        expect(yield* ServiceConfig.migrateConfig(config, path.join(root, "missing", "target.json")).pipe(Effect.flip)).toBeDefined()
        yield* Effect.promise(() => writeFile(registration, "{}"))
        yield* Effect.promise(() => grantEveryone(registration))
        const remove = yield* ServiceRegistration.register({
          address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 12345 },
          password: "registration-fixture-only",
          id: "acl-test",
          file: registration,
          shutdown: Effect.void,
        })
        const published = yield* Effect.promise(() => acl(registration))
        expect(published.rules.map((rule) => rule.sid)).toEqual([published.current])
        yield* remove
      }).pipe(Effect.provideService(FileSystem.FileSystem, checked))
    }).pipe(
      Effect.scoped,
      Effect.provideService(Global.Service, Global.make({
        home: root, data: root, config: root, state: root, cache: root, tmp: root, bin: root, repos: root, log: root,
      })),
      Effect.provide(NodeFileSystem.layer),
    ))
    expect(publications).toEqual([config, config, registration])
    const migrated = await acl(path.join(root, "migrated.json"))
    expect(migrated.protected).toBe(true)
    expect(migrated.rules.map((rule) => rule.sid)).toEqual([migrated.current])
    expect(JSON.parse(await readFile(config, "utf8")).password).toBe("second-fixture-only")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
