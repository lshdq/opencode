import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink } from "node:fs/promises"
import path from "node:path"
import {
  assertRegistration,
  cliVersion,
  deployVerifiedWindowsBinary,
  deployWindowsBinary,
  execute,
  executeRaw,
  isolatedEnvironment,
  prepareIsolatedDatabaseDirectory,
  sha256,
  sourceIdentity,
  upstreamAtCommit,
  upstreamBaseline,
} from "./windows-runtime"
import { repairWindowsLinks } from "./repair-windows-links"

describe("Windows build isolation", () => {
  const fixtureParent = process.env.OPENCODE_WINDOWS_TEST_TMP ?? path.resolve(import.meta.dir, "../dist")

  test("pins the version to the merged upstream commit, not fork HEAD or newer unmerged upstream", async () => {
    const parent = fixtureParent
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(path.join(parent, "upstream-baseline-test-"))
    try {
      await execute(["git", "init", "--quiet"], root)
      await Bun.write(path.join(root, "package.json"), JSON.stringify({ version: "3.4.0", packageManager: "bun@1.4.2" }))
      await execute(["git", "add", "package.json"], root)
      const commit = ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m"]
      await execute([...commit, "upstream base"], root)
      const base = await execute(["git", "rev-parse", "HEAD"], root)
      const fork = await execute(["git", "branch", "--show-current"], root)
      await execute(["git", "update-ref", "refs/remotes/upstream/v2", base], root)
      await Bun.write(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9", packageManager: "bun@1.4.2" }))
      await execute(["git", "add", "package.json"], root)
      await execute([...commit, "fork changes"], root)
      expect(await upstreamBaseline(root)).toEqual({ commit: base, version: "3.4.0" })
      await execute(["git", "switch", "--quiet", "-c", "upstream-next", base], root)
      await Bun.write(path.join(root, "package.json"), JSON.stringify({ version: "3.5.0", packageManager: "bun@1.4.2" }))
      await execute(["git", "add", "package.json"], root)
      await execute([...commit, "new upstream release"], root)
      await execute(["git", "update-ref", "refs/remotes/upstream/v2", "HEAD"], root)
      await execute(["git", "switch", "--quiet", fork], root)
      expect(await upstreamBaseline(root)).toEqual({ commit: base, version: "3.4.0" })
      expect(await upstreamAtCommit(root, base)).toEqual({ version: "3.4.0" })
      await execute(["git", "update-ref", "-d", "refs/remotes/upstream/v2"], root)
      await expect(upstreamBaseline(root)).rejects.toThrow()
      await expect(upstreamAtCommit(root, "--invalid")).rejects.toThrow("Invalid upstream baseline commit")
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test("deploys only one timestamped exe, with exclusive copy and matching hash", async () => {
    const parent = fixtureParent
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(path.join(parent, "deployment-test-"))
    try {
      const deploy = path.join(root, "existing")
      await mkdir(deploy)
      const binary = path.join(root, "original.exe")
      await Bun.write(binary, "build bytes")
      const hash = await sha256(binary)
      const target = await deployWindowsBinary(binary, deploy, "3.4.0", hash, new Date(2026, 8, 24, 13, 49))
      expect(path.basename(target)).toBe("opencode-3.4.0-202609241349.exe")
      expect(await sha256(target)).toBe(hash)
      await Bun.write(binary, "new build bytes")
      await expect(deployWindowsBinary(binary, deploy, "3.4.1", hash, new Date(2026, 8, 24, 13, 49)))
        .rejects.toThrow("Deployed binary hash mismatch")
      expect(await Bun.file(path.join(deploy, "opencode-3.4.1-202609241349.exe")).exists()).toBe(false)
      await expect(deployWindowsBinary(binary, deploy, "3.4.0", await sha256(binary), new Date(2026, 8, 24, 13, 49)))
        .rejects.toThrow()
      expect(await sha256(target)).toBe(hash)
      expect(await readdir(deploy)).toEqual([path.basename(target)])
      await expect(deployWindowsBinary(binary, path.join(root, "missing"), "3.4.0", hash)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test("TC-003/004: keeps the daily executable and metadata untouched across minute rollover and collision", async () => {
    const parent = fixtureParent
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(path.join(parent, "deploy-minute-test-"))
    try {
      const deploy = path.join(root, "deploy")
      await mkdir(deploy)
      const binary = path.join(root, "build.exe")
      await Bun.write(binary, "fixture compiled bytes")
      await Bun.write(path.join(root, "build-metadata.json"), "fixture metadata")
      await Bun.write(path.join(deploy, "opencode.exe"), "daily executable")
      const hash = await sha256(binary)
      const first = await deployWindowsBinary(binary, deploy, "3.4.0", hash, new Date(2026, 11, 31, 23, 59, 59))
      expect(path.basename(first)).toBe("opencode-3.4.0-202612312359.exe")
      await expect(deployWindowsBinary(binary, deploy, "3.4.0", hash, new Date(2026, 11, 31, 23, 59)))
        .rejects.toThrow()
      expect(await sha256(first)).toBe(hash)
      const second = await deployWindowsBinary(binary, deploy, "3.4.0", hash, new Date(2027, 0, 1, 0, 0))
      expect(path.basename(second)).toBe("opencode-3.4.0-202701010000.exe")
      expect(await readdir(deploy)).toEqual([
        "opencode-3.4.0-202612312359.exe",
        "opencode-3.4.0-202701010000.exe",
        "opencode.exe",
      ])
      expect(await sha256(second)).toBe(hash)
      expect(await Bun.file(path.join(deploy, "opencode.exe")).text()).toBe("daily executable")
      expect(await Bun.file(path.join(root, "build-metadata.json")).text()).toBe("fixture metadata")
      expect(await Bun.file(path.join(deploy, "build-metadata.json")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test.skipIf(process.platform !== "win32")(
    "TC-003/004/006: runs the renamed real Bun exe and removes only a failed new deployment",
    async () => {
      await mkdir(fixtureParent, { recursive: true })
      const root = await mkdtemp(path.join(fixtureParent, "deploy-executable-test-"))
      try {
        const deploy = path.join(root, "deploy")
        const checkRoot = path.join(root, "isolated-check")
        await Promise.all([mkdir(deploy), mkdir(checkRoot)])
        await Bun.write(path.join(deploy, "opencode.exe"), "daily executable")
        const binary = process.execPath
        const hash = await sha256(binary)
        const version = cliVersion(await execute([binary, "--version"], checkRoot, isolatedEnvironment(checkRoot)))
        expect(version).toBe("1.4.2")
        const at = new Date(2026, 8, 24, 13, 49)
        const target = await deployVerifiedWindowsBinary(binary, deploy, version, hash, checkRoot, at)
        expect(path.basename(target)).toBe(`opencode-${version}-202609241349.exe`)
        expect(cliVersion(await execute([target, "--version"], checkRoot, isolatedEnvironment(checkRoot)))).toBe(version)
        expect(await sha256(target)).toBe(hash)
        await expect(deployVerifiedWindowsBinary(binary, deploy, version, hash, checkRoot, at)).rejects.toThrow()
        expect(await sha256(target)).toBe(hash)
        const wrongVersion = "1.4.3"
        await expect(
          deployVerifiedWindowsBinary(binary, deploy, wrongVersion, hash, checkRoot, new Date(2026, 8, 24, 13, 50)),
        ).rejects.toThrow("Renamed deployed binary version mismatch")
        expect(await Bun.file(path.join(deploy, `opencode-${wrongVersion}-202609241350.exe`)).exists()).toBe(false)
        const invalid = path.join(root, "invalid.exe")
        await Bun.write(invalid, "not an executable")
        await expect(
          deployVerifiedWindowsBinary(invalid, deploy, version, await sha256(invalid), checkRoot, new Date(2026, 8, 24, 13, 51)),
        ).rejects.toThrow()
        expect(await Bun.file(path.join(deploy, `opencode-${version}-202609241351.exe`)).exists()).toBe(false)
        await expect(
          deployVerifiedWindowsBinary(binary, deploy, version, "wrong hash", checkRoot, new Date(2026, 8, 24, 13, 52)),
        ).rejects.toThrow("Deployed binary hash mismatch")
        expect(await Bun.file(path.join(deploy, `opencode-${version}-202609241352.exe`)).exists()).toBe(false)
        expect(await readdir(deploy)).toEqual([path.basename(target), "opencode.exe"])
        expect(await Bun.file(path.join(deploy, "opencode.exe")).text()).toBe("daily executable")
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
    30_000,
  )

  test.skipIf(process.platform !== "win32")(
    "prepares only owned data for custom DB, baseline and restored copies before SQLite creates files",
    async () => {
      const { FileMode } = await import("@opencode/util/file-mode")
      const { acl } = await import("../../util/test/fixture/file-acl")
      const parent = fixtureParent
      await mkdir(parent, { recursive: true })
      const root = await mkdtemp(path.join(parent, "private-db-中文's-"))
      const env = isolatedEnvironment(root)
      const sibling = path.join(root, "unrelated")
      try {
        await Bun.write(sibling, "untouched")
        const before = await Promise.all([root, sibling].map(acl))
        const directory = await prepareIsolatedDatabaseDirectory(root)
        expect(directory).toBe(path.dirname(env.OPENCODE_DB))
        // The production custom-directory path is check-only: it must now accept this directory.
        await FileMode.directory(directory)
        const baseline = path.join(directory, "official-base.db")
        for (const file of [baseline, env.OPENCODE_DB]) {
          if (file !== baseline) await copyFile(baseline, file)
          // Also models the official baseline producer, which has no privateDirectory option.
          const db = new Database(file)
          try {
            db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sentinel(value TEXT)")
            db.run("INSERT INTO sentinel VALUES (?)", ["synthetic-fixture"])
            for (const suffix of ["", "-wal", "-shm"]) {
              const found = await acl(file + suffix)
              expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
              expect(found.rules.every((rule) => rule.inherited && rule.allow)).toBe(true)
            }
          } finally {
            db.close()
          }
          expect(await Bun.file(file + "-wal").exists()).toBe(false)
          expect(await Bun.file(file + "-shm").exists()).toBe(false)
        }
        const restored = path.join(directory, "restored.db")
        await copyFile(baseline, restored)
        expect(await sha256(restored)).toBe(await sha256(baseline))
        const found = await acl(restored)
        expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
        const after = await Promise.all([root, sibling].map(acl))
        expect(after.map((item) => item.sddl)).toEqual(before.map((item) => item.sddl))
        expect(await Bun.file(sibling).text()).toBe("untouched")
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
    30_000,
  )

  test.skipIf(process.platform !== "win32")(
    "refuses a redirected data directory instead of tightening an unrelated target",
    async () => {
      const { acl } = await import("../../util/test/fixture/file-acl")
      const parent = fixtureParent
      await mkdir(parent, { recursive: true })
      const root = await mkdtemp(path.join(parent, "private-db-junction-"))
      const outside = path.join(root, "outside")
      try {
        await mkdir(outside)
        await Bun.write(path.join(outside, "sentinel"), "untouched")
        const before = await Promise.all([outside, path.join(outside, "sentinel")].map(acl))
        await symlink(outside, path.join(root, "data"), "junction")
        await expect(prepareIsolatedDatabaseDirectory(root)).rejects.toThrow()
        const after = await Promise.all([outside, path.join(outside, "sentinel")].map(acl))
        expect(after.map((item) => item.sddl)).toEqual(before.map((item) => item.sddl))
        expect(await Bun.file(path.join(outside, "sentinel")).text()).toBe("untouched")
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
    30_000,
  )

  test("keeps raw command bytes distinct from normalized metadata text", async () => {
    const command = [process.execPath, "-e", 'process.stdout.write(" leading value \\t\\r\\n")']
    expect(await execute(command, import.meta.dir)).toBe(" leading value")
    expect(await executeRaw(command, import.meta.dir)).toEqual(new TextEncoder().encode(" leading value \t\r\n"))
    expect(
      await executeRaw(
        [process.execPath, "-e", "process.stdout.write(new Uint8Array([0, 255, 128, 32, 9, 13, 10]))"],
        import.meta.dir,
      ),
    ).toEqual(new Uint8Array([0, 255, 128, 32, 9, 13, 10]))
  })

  test.each([
    { name: "trailing spaces and tabs before LF", text: "changed\nlast line \t  \n" },
    { name: "trailing spaces without a final newline", text: "changed\nlast line \t  " },
    { name: "Unicode and trailing spaces before CRLF", text: "中文\r\nlast line \t  \r\n" },
  ])("saves byte-exact, parseable text and binary Git patches: $name", async ({ text }) => {
    const parent = fixtureParent
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(path.join(parent, "patch-bytes-test-"))
    try {
      await execute(["git", "init", "--quiet"], root)
      await Bun.write(path.join(root, "a-binary.bin"), new Uint8Array([0, 1, 2, 255]))
      await Bun.write(path.join(root, "z-text.txt"), "original\n")
      await execute(["git", "-c", "core.autocrlf=false", "add", "--", "a-binary.bin", "z-text.txt"], root)
      await Bun.write(path.join(root, "a-binary.bin"), new Uint8Array([0, 255, 128, 32, 9, 13, 10]))
      await Bun.write(path.join(root, "z-text.txt"), text)
      // Compare against the staged original, so the fixture needs no commit or Git config changes.
      const command = ["git", "-c", "core.autocrlf=false", "diff", "--binary", "--no-ext-diff", "--no-textconv"]
      const patch = await executeRaw(command, root)
      await Bun.write(path.join(root, "source.diff"), patch)
      // Git writes the reference directly: the expected bytes do not pass through our helper's stdout handling.
      await execute([...command, "--output=expected.diff"], root)
      const saved = new Uint8Array(await Bun.file(path.join(root, "source.diff")).arrayBuffer())
      expect(saved).toEqual(new Uint8Array(await Bun.file(path.join(root, "expected.diff")).arrayBuffer()))
      expect(new TextDecoder().decode(saved)).toContain("GIT binary patch")
      expect(saved.at(-1)).toBe(10)
      expect(new TextDecoder().decode(saved)).toContain(
        text.endsWith("\n") ? "+last line \t  " : "\\ No newline at end of file",
      )
      expect(await execute(["git", "apply", "--stat", "source.diff"], root)).toContain("z-text.txt")
      // Reverse-check against the modified worktree without actually applying or changing any files.
      expect(
        await execute(["git", "-c", "core.autocrlf=false", "apply", "--check", "--reverse", "source.diff"], root),
      ).toBe("")
      expect(await Bun.file(path.join(root, "z-text.txt")).text()).toBe(text)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test("reads the official Effect CLI version format without accepting arbitrary output", () => {
    expect(cliVersion("opencode v3.4.0\r\n")).toBe("3.4.0")
    expect(cliVersion("3.4.0\n")).toBe("3.4.0")
    expect(() => cliVersion("opencode vlocal")).toThrow()
    expect(() => cliVersion("warning\nopencode v3.4.0")).toThrow()
  })
  test("replaces every data root and drops inherited server/config/credential overrides", () => {
    const root = path.resolve("tmp", "中文 smoke's path")
    const env = isolatedEnvironment(root, {
      PATH: "keep",
      OPENCODE_SERVER: "http://daily-service",
      OPENCODE_PASSWORD: "daily-secret",
      OPENCODE_CONFIG: "daily-config",
      OPENCODE_DB: "daily.db",
      OPENCODE_CONFIG_CONTENT: "danger",
      XDG_STATE_HOME: "daily-state",
      NODE_OPTIONS: "--require=untrusted.js",
    })
    expect(env).toHaveProperty("PATH", "keep")
    expect(env).not.toHaveProperty("OPENCODE_SERVER")
    expect(env).not.toHaveProperty("OPENCODE_PASSWORD")
    expect(env).not.toHaveProperty("OPENCODE_CONFIG")
    expect(env).not.toHaveProperty("NODE_OPTIONS")
    for (const key of [
      "HOME",
      "USERPROFILE",
      "XDG_STATE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "OPENCODE_DB",
      "TEMP",
    ]) {
      expect(
        Object.entries(env)
          .find(([name]) => name === key)?.[1]
          ?.startsWith(root),
      ).toBe(true)
    }
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")
  })

  const own = { pid: 1234, id: "owned", version: "3.4.0", password: "private", url: "http://127.0.0.1:54321" }
  test("accepts only an identified loopback registration owned by the spawned PID", () => {
    expect(assertRegistration(own, 1234, "3.4.0")).toEqual(own)
  })
  test.each([
    null,
    {},
    { ...own, pid: 5678 },
    { ...own, version: "3.3.9" },
    { ...own, id: "" },
    { ...own, password: undefined },
    { ...own, url: "http://remote:1234" },
    { ...own, url: "https://127.0.0.1:1234" },
    { ...own, url: "http://127.0.0.1" },
    { ...own, url: "http://user:pass@127.0.0.1:1234" },
  ])("rejects unsafe registration %j", (value) => {
    expect(() => assertRegistration(value, 1234, "3.4.0")).toThrow()
  })

  test("source identity tracks uncommitted inputs, preserves leading spaces, and ignores build output", async () => {
    const parent = fixtureParent
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(path.join(parent, "identity-test-"))
    try {
      await execute(["git", "init", "--quiet"], root)
      await Bun.write(path.join(root, ".gitignore"), "ignored/\n")
      await execute(["git", "add", "--", ".gitignore"], root)
      await Bun.write(path.join(root, " leading.txt"), "before")
      const before = await sourceIdentity(root)
      expect(before.files.map((file) => file.file)).toContain(" leading.txt")
      expect(before.files.find((file) => file.file === ".gitignore")?.tracked).toBe(true)
      expect(before.files.find((file) => file.file === " leading.txt")?.tracked).toBe(false)
      await Bun.write(path.join(root, "ignored", "output.txt"), "not a source input")
      expect((await sourceIdentity(root)).sha256).toBe(before.sha256)
      await Bun.write(path.join(root, " leading.txt"), "after")
      expect((await sourceIdentity(root)).sha256).not.toBe(before.sha256)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  })

  test.skipIf(process.platform !== "win32")(
    "repairs only untouched indexed symlink placeholders and keeps Git clean",
    async () => {
      const parent = fixtureParent
      await mkdir(parent, { recursive: true })
      const root = await mkdtemp(path.join(parent, "symlink-test-"))
      const files = ["packages/app/src/custom-elements.d.ts", "packages/enterprise/src/custom-elements.d.ts"]
      try {
        await execute(["git", "init", "--quiet"], root)
        await Bun.write(path.join(root, "packages/ui/src/custom-elements.d.ts"), "export {}\n")
        for (const file of files) {
          await mkdir(path.dirname(path.join(root, file)), { recursive: true })
          await symlink("../../ui/src/custom-elements.d.ts", path.join(root, file))
        }
        await execute(["git", "-c", "core.symlinks=true", "add", "--", "packages"], root)
        for (const file of files) {
          await unlink(path.join(root, file))
          await Bun.write(path.join(root, file), "../../ui/src/custom-elements.d.ts")
        }
        await repairWindowsLinks(root)
        expect((await lstat(path.join(root, files[0]))).isSymbolicLink()).toBe(true)
        expect(await execute(["git", "diff", "--exit-code"], root)).toBe("")
        expect((await sourceIdentity(root)).files.find((file) => file.file === files[0])?.kind).toBe("symlink")
        await unlink(path.join(root, files[0]))
        await Bun.write(path.join(root, files[0]), "user-edited text")
        await expect(repairWindowsLinks(root)).rejects.toThrow("Refusing to overwrite")
        expect(await Bun.file(path.join(root, files[0])).text()).toBe("user-edited text")
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }
    },
  )
})
