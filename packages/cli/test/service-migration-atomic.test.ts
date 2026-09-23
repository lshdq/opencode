import { NodeFileSystem } from "@effect/platform-node"
import { FileMode } from "@opencode/util/file-mode"
import { expect, test } from "bun:test"
import { Effect, Fiber, FileSystem } from "effect"
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"
import { acl } from "../../util/test/fixture/file-acl"

for (const kind of ["config", "registration"] as const) {
  const content = JSON.stringify(kind === "config"
    ? { password: "legacy-fixture", hostname: "127.0.0.2", port: 4321, env: { FIXTURE: "retained" } }
    : { id: "legacy", password: "legacy-fixture", version: "fixture-version", url: "http://127.0.0.1:4321", pid: 42 })
  const winner = JSON.stringify(kind === "config"
    ? { password: "other-completed-winner", port: 5678 }
    : { id: "winner", password: "other-completed-winner", version: "fixture-version", url: "http://127.0.0.1:5678", pid: 84 })
  const migrate = (from: string, to: string) => kind === "config"
    ? ServiceConfig.migrateConfig(from, to)
    : ServiceConfig.migrateRegistration(from, to, "preview", "fixture-version")

  for (const fault of ["write", "interrupt", "concurrent-winner"] as const) {
    test.skipIf(process.platform !== "win32")(`${kind} migration: ${fault} never publishes an empty target or loses legacy state`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "opencode-migration-atomic-"))
      const source = path.join(root, "legacy.json")
      const target = path.join(root, "target.json")
      const ready = Promise.withResolvers<string>()
      try {
        await writeFile(source, content)
        const job = Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const checked = {
            ...fs,
            writeFileString: (file: string, text: string) => Effect.gen(function* () {
              const found = yield* Effect.promise(() => acl(file))
              expect(found.protected).toBe(true)
              expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
              ready.resolve(file)
              if (fault === "interrupt") return yield* Effect.never
              if (fault === "write") yield* Effect.promise(() => chmod(file, 0o400))
              yield* fs.writeFileString(file, text)
            }),
            link: (from: string, to: string) => Effect.gen(function* () {
              if (fault === "concurrent-winner") {
                yield* Effect.promise(() => FileMode.prepare(to, { exclusive: true }))
                yield* fs.writeFileString(to, winner)
              }
              yield* fs.link(from, to)
            }),
          }
          yield* migrate(source, target).pipe(Effect.provideService(FileSystem.FileSystem, checked))
        }).pipe(Effect.provide(NodeFileSystem.layer))
        if (fault === "interrupt") {
          const fiber = Effect.runFork(job)
          try {
            const temp = await ready.promise
            await Effect.runPromise(Fiber.interrupt(fiber))
            await expect(stat(temp)).rejects.toThrow()
          } finally {
            await Effect.runPromise(Fiber.interrupt(fiber))
          }
        }
        if (fault === "write") await expect(Effect.runPromise(job)).rejects.toThrow()
        if (fault === "concurrent-winner") await Effect.runPromise(job)
        expect(await readFile(source, "utf8")).toBe(content)
        expect((await readdir(root)).some((file) => file.startsWith(".migration-"))).toBe(false)
        if (fault !== "concurrent-winner") await expect(stat(target)).rejects.toThrow()
        await Effect.runPromise(migrate(source, target).pipe(Effect.provide(NodeFileSystem.layer)))
        expect(await readFile(target, "utf8")).toBe(fault === "concurrent-winner" ? winner : content)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }, 30_000)
  }

  test.skipIf(process.platform !== "win32")(`${kind} concurrent migrations publish exactly one complete private target`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-migration-race-"))
    try {
      const source = path.join(root, "legacy.json")
      const target = path.join(root, "target.json")
      await writeFile(source, content)
      await Promise.all([1, 2].map(() => Effect.runPromise(migrate(source, target).pipe(Effect.provide(NodeFileSystem.layer)))))
      expect(await readFile(target, "utf8")).toBe(content)
      expect((await acl(target)).protected).toBe(true)
      expect((await readdir(root)).sort()).toEqual(["legacy.json", "target.json"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
