import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { NetAddress } from "effect/net"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"
import { ServiceRegistration } from "../src/services/service-registration"
import { acl, grantEveryone } from "../../util/test/fixture/file-acl"

test.skipIf(process.platform !== "win32")("service password migration/read/replacement and registration publish inherited files", async () => {
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
          // Published temps inherit the parent directory instead of tightening to a single user.
          expect((yield* Effect.promise(() => acl(from))).protected).toBe(false)
          publications.push(to)
          yield* fs.rename(from, to)
        }),
      }
      yield* Effect.gen(function* () {
        expect(yield* ServiceConfig.password()).toBe("test-fixture-only")
        // Reading never re-tightens a widened file: the explicit Everyone ACE survives.
        const existing = yield* Effect.promise(() => acl(config))
        expect(existing.protected).toBe(false)
        expect(existing.rules.some((rule) => rule.sid === "S-1-1-0")).toBe(true)
        yield* ServiceConfig.password("replacement-fixture-only")
        yield* ServiceConfig.password("second-fixture-only")
        yield* ServiceConfig.migrateConfig(config, path.join(root, "migrated.json"))
        // Existing destination is never truncated by a migration retry.
        yield* ServiceConfig.migrateConfig(config, path.join(root, "migrated.json"))
        // A failed temp-directory creation must propagate instead of looking
        // like a successful migration.
        expect(yield* ServiceConfig.migrateConfig(config, path.join(root, "missing", "target.json")).pipe(Effect.flip)).toBeDefined()
        yield* Effect.promise(() => writeFile(registration, "{}"))
        const remove = yield* ServiceRegistration.register({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 12345),
          password: "registration-fixture-only",
          id: "acl-test",
          file: registration,
          shutdown: Effect.void,
        })
        const published = yield* Effect.promise(() => acl(registration))
        expect(published.protected).toBe(false)
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
    expect(migrated.protected).toBe(false)
    expect(JSON.parse(await readFile(config, "utf8")).password).toBe("second-fixture-only")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
