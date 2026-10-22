import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, FileSystem } from "effect"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"

// Every write() publishes through a temp with a random suffix, so concurrent
// writers never overwrite each other's temp file and the final config is always
// one complete JSON document published by an atomic rename.

// Windows scanners can briefly lock a freshly written temp before its rename;
// retrying that noise in the observation wrapper never changes the assertions.
function isTransientLock(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const reason = (error as { readonly reason?: unknown }).reason
  if (typeof reason !== "object" || reason === null) return false
  const tag = (reason as { readonly _tag?: unknown })._tag
  if (tag === "PermissionDenied") return true
  const cause = (reason as { readonly cause?: unknown }).cause
  return tag === "Unknown" && cause instanceof Error && (cause as NodeJS.ErrnoException).code === "EPERM"
}

test("service config writes use unique temps and publish atomically", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-service-write-"))
  const configFile = path.join(root, ServiceConfig.filename())
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const renames: string[] = []
      const checked = {
        ...fs,
        rename: (from: string, to: string) =>
          Effect.gen(function* () {
            renames.push(from)
            for (let left = 5; ; ) {
              const exit = yield* fs.rename(from, to).pipe(Effect.exit)
              if (Exit.isSuccess(exit)) return
              const error = Cause.squash(exit.cause)
              if (!(left-- > 0 && isTransientLock(error))) return yield* exit
              yield* Effect.sleep(50)
            }
          }),
      }
      const writes = (count: number, concurrency: "unbounded" | 1) =>
        Effect.forEach(Array.from({ length: count }), () => ServiceConfig.acceptRemote(), { concurrency })
      yield* writes(3, 1).pipe(Effect.provideService(FileSystem.FileSystem, checked))
      yield* writes(3, "unbounded").pipe(Effect.provideService(FileSystem.FileSystem, checked))
      expect(renames).toHaveLength(6)
      expect(new Set(renames).size).toBe(6)
      for (const from of renames) {
        expect(from.startsWith(`${configFile}.`)).toBe(true)
        expect(from.endsWith(".tmp")).toBe(true)
        expect(from.slice(configFile.length + 1, -4)).toMatch(/^[0-9a-f]{16}$/)
      }
    }).pipe(
      Effect.provideService(Global.Service, Global.make({
        home: root, data: root, config: root, state: root, cache: root, tmp: root, bin: root, repos: root, log: root,
      })),
      Effect.provide(NodeFileSystem.layer),
    ))
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual({ remoteAccepted: true })
    expect((await readdir(root)).filter((file) => file.endsWith(".tmp"))).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
