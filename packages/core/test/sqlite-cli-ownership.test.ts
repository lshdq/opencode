import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { acl } from "../../util/test/fixture/file-acl"

// Multi-user sharing: the CLI graph must never tighten Windows ACLs. Both the
// default data root and a custom shared OPENCODE_DB directory keep inheriting
// their parent's ACL while the server runs. Covers database-path -> CLI
// ServerProcess -> Server routes/graph -> Database -> native driver.
for (const mode of ["default", "shared-custom"] as const) {
  test.skipIf(process.platform !== "win32")(`CLI graph leaves shared database ACLs inherited: ${mode}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-cli-db-shared-"))
    const data = path.join(root, "data", "opencode")
    const custom = path.join(root, "shared")
    const directory = mode === "default" ? data : custom
    const filename = path.join(directory, "opencode.db")
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(root, "unrelated"), "outside-app-data")
      await writeFile(path.join(directory, "sibling"), "preserved-sibling")
      const outside = await Promise.all([root, path.join(root, "unrelated")].map(acl))
      const before = await Promise.all([directory, path.join(directory, "sibling")].map(acl))
      expect(before[0].protected).toBe(false)

      for (const reopen of mode === "default" ? [false, true] : [false]) {
        const existing = reopen ? await acl(filename) : undefined
        const env = {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            ["path", "systemroot", "windir", "comspec", "pathext", "systemdrive"].includes(key.toLowerCase()),
          )),
          HOME: root,
          USERPROFILE: root,
          APPDATA: path.join(root, "appdata"),
          LOCALAPPDATA: path.join(root, "localappdata"),
          TEMP: root,
          TMP: root,
          OPENCODE_TEST_HOME: root,
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          XDG_STATE_HOME: path.join(root, "state"),
          OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
          OPENCODE_CONFIG_PROJECT_DISABLE: "1",
          OPENCODE_DISABLE_CHANNEL_DB: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_FFF: "1",
          OPENCODE_FILEWATCHER_DISABLE: "1",
          OPENCODE_SERVER_PASSWORD: "shared-fixture-only",
          ...(mode === "default" ? {} : { OPENCODE_DB: filename }),
        }
        const child = Bun.spawn([
          process.execPath,
          "--preload", Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, "../../cli")),
          path.join(import.meta.dir, "../../cli/src/index.ts"),
          "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0",
        ], { cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
        const output = { text: "" }
        const stdout = (async () => {
          for await (const chunk of child.stdout) output.text += new TextDecoder().decode(chunk)
        })()
        const stderr = new Response(child.stderr).text()
        try {
          const deadline = Date.now() + 60_000
          while (!output.text.includes('"url":') && child.exitCode === null && Date.now() < deadline) await Bun.sleep(25)
          expect(child.exitCode, child.exitCode === null ? "server exited before ready" : await stderr).toBe(null)
          const line = output.text.split(/\r?\n/).find((line) => line.startsWith('{"url":'))
          expect(line, `No ready URL on ${reopen ? "reopen" : "first open"}`).toBeDefined()
          const address = JSON.parse(line ?? "{}") as { url: string }
          const response = await fetch(new URL("/api/info", address.url), {
            headers: { authorization: "Basic " + btoa("opencode:shared-fixture-only") },
            signal: AbortSignal.timeout(5000),
          })
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({ pid: child.pid })
          // The open database and its sidecars keep inheriting the parent ACL.
          for (const suffix of ["", "-wal", "-shm"]) {
            const found = await acl(filename + suffix)
            expect(found.protected).toBe(false)
            if (existing && suffix === "") expect(found.sddl).toBe(existing.sddl)
          }
          expect((await acl(directory)).protected).toBe(false)
          child.stdin.end()
          expect(await Promise.race([child.exited, Bun.sleep(10_000).then(() => "shutdown-timeout")])).toBe(0)
          expect(() => process.kill(child.pid, 0)).toThrow()
          await expect(stat(filename + "-wal")).rejects.toThrow()
          await expect(stat(filename + "-shm")).rejects.toThrow()
        } finally {
          if (child.exitCode === null) {
            const killer = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
            await killer.exited
            child.kill()
          }
          await child.exited
          await stdout
          await stderr
        }
      }
      expect((await Promise.all([root, path.join(root, "unrelated")].map(acl))).map((item) => item.sddl))
        .toEqual(outside.map((item) => item.sddl))
      expect((await Promise.all([directory, path.join(directory, "sibling")].map(acl))).map((item) => item.sddl))
        .toEqual(before.map((item) => item.sddl))
      expect(await readFile(path.join(directory, "sibling"), "utf8")).toBe("preserved-sibling")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 150_000)
}
