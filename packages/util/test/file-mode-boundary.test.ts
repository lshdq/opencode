import { NodeFileSystem } from "@effect/platform-node"
import { expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileMode } from "../src/file-mode.js"
import { FileModeWindows } from "../src/file-mode-windows.js"
import { FSUtil } from "../src/fs-util.js"
import { acl, grantEveryone } from "./fixture/file-acl.js"

// TC-007: exercise CreateNew contention, not a mocked AlreadyExists error.
test.skipIf(process.platform !== "win32")("exclusive preparation has exactly one winner and preserves an existing file's contents and DACL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-exclusive-"))
  const file = path.join(root, "private")
  try {
    const results = await Promise.allSettled([
      FileMode.prepare(file, { exclusive: true }),
      FileMode.prepare(file, { exclusive: true }),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const rejected = results.filter((result) => result.status === "rejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBeInstanceOf(FileMode.AlreadyExists)
    const created = await acl(file)
    expect(created.rules).toEqual([{ sid: created.current, inherited: false, allow: true, rights: 1507743 }])
    await writeFile(file, "do-not-truncate")
    await grantEveryone(file)
    const before = await acl(file)
    await expect(FileMode.prepare(file, { exclusive: true })).rejects.toBeInstanceOf(FileMode.AlreadyExists)
    expect(await readFile(file, "utf8")).toBe("do-not-truncate")
    expect((await acl(file)).sddl).toBe(before.sddl)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

for (const method of ["json", "string", "bytes"] as const) {
  test.skipIf(process.platform !== "win32")(`FSUtil ${method} propagates a real post-prepare write failure and can retry`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-write-failure-"))
    const file = path.join(root, "private")
    const attempts: string[] = []
    try {
      await writeFile(file, "original")
      await grantEveryone(file)
      const parent = await acl(root)
      await Effect.runPromise(Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        // Interpose only at the real filesystem boundary. Prepare still runs its
        // actual PS script; the OS read-only attribute then rejects the real write.
        const checked = {
          ...fs,
          writeFileString: (target: string, content: string) => Effect.gen(function* () {
            attempts.push(target)
            yield* Effect.promise(() => chmod(target, 0o400))
            yield* fs.writeFileString(target, content)
          }),
          writeFile: (target: string, content: Uint8Array) => Effect.gen(function* () {
            attempts.push(target)
            yield* Effect.promise(() => chmod(target, 0o400))
            yield* fs.writeFile(target, content)
          }),
        }
        const write = Effect.gen(function* () {
          const util = yield* FSUtil.Service
          return yield* method === "json"
            ? util.writeJson(file, { fixture: true }, 0o600)
            : util.writeWithDirs(file, method === "bytes" ? new TextEncoder().encode("replacement") : "replacement", 0o600)
        })
        const error = yield* write.pipe(
          Effect.provide(FSUtil.layer),
          Effect.provideService(FileSystem.FileSystem, checked),
          Effect.flip,
        )
        expect(error._tag).toBe("PlatformError")
        expect(attempts).toEqual([file])
        expect(yield* Effect.promise(() => readFile(file, "utf8"))).toBe("original")
        const found = yield* Effect.promise(() => acl(file))
        expect(found.protected).toBe(true)
        expect(found.rules).toEqual([{ sid: found.current, inherited: false, allow: true, rights: 1507743 }])
        yield* Effect.promise(() => chmod(file, 0o600))
        yield* write.pipe(Effect.provide(FSUtil.layer))
      }).pipe(Effect.provide(NodeFileSystem.layer)))
      expect(await readFile(file, "utf8")).toBe(method === "json" ? JSON.stringify({ fixture: true }, null, 2) : "replacement")
      expect((await acl(root)).sddl).toBe(parent.sddl)
    } finally {
      await chmod(file, 0o600).catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}

test.skipIf(process.platform !== "win32")("abort before ACL submission reaps the host and preserves the original DACL and bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-before-abort-"))
  const file = path.join(root, "private")
  const controller = new AbortController()
  try {
    await writeFile(file, "original")
    await grantEveryone(file)
    const before = await acl(file)
    const result = FileModeWindows.execute(`
[System.IO.File]::WriteAllText($env:OPENCODE_ACL_MARKER, [string]$PID)
[System.Threading.Thread]::Sleep(60000)
${FileModeWindows.script}`, {
      OPENCODE_ACL_PATH: file,
      OPENCODE_ACL_MARKER: file + ".pid",
      OPENCODE_ACL_RIGHTS: "459167",
      OPENCODE_ACL_ACCESS: "3",
      OPENCODE_ACL_CREATE: "false",
      OPENCODE_ACL_EXCLUSIVE: "false",
    }, { signal: controller.signal }).catch((error: unknown) => error)
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await stat(file + ".pid").then(() => true, () => false)) break
        await Bun.sleep(25)
      }
      const pid = Number(await readFile(file + ".pid", "utf8"))
      controller.abort()
      expect(await result).toBeInstanceOf(Error)
      expect(() => process.kill(pid, 0)).toThrow()
      expect((await acl(file)).sddl).toBe(before.sddl)
      expect(await readFile(file, "utf8")).toBe("original")
      await FileMode.prepare(file)
      await writeFile(file, "retry")
      expect(await readFile(file, "utf8")).toBe("retry")
    } finally {
      controller.abort()
      await result
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32")("ACL executor reports a missing host and excessive output without hanging or changing the target", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-host-error-"))
  const file = path.join(root, "private")
  try {
    await writeFile(file, "original")
    const before = await acl(file)
    await expect(FileModeWindows.execute(FileModeWindows.script, { OPENCODE_ACL_PATH: file }, {
      command: path.join(root, "absent.exe"),
    })).rejects.toThrow()
    await expect(FileModeWindows.execute(`
[System.IO.File]::WriteAllText($env:OPENCODE_ACL_MARKER, [string]$PID)
[Console]::Out.Write(('x' * 100000))
[System.Threading.Thread]::Sleep(60000)`, { OPENCODE_ACL_MARKER: file + ".pid" })).rejects.toThrow()
    const pid = Number(await readFile(file + ".pid", "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
    expect((await acl(file)).sddl).toBe(before.sddl)
    expect(await readFile(file, "utf8")).toBe("original")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
