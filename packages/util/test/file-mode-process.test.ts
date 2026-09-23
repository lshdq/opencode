import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileMode } from "../src/file-mode.js"
import { FileModeWindows } from "../src/file-mode-windows.js"
import { acl, grantEveryone } from "./fixture/file-acl.js"

function variables(file: string, create = true) {
  return {
    OPENCODE_ACL_PATH: file,
    OPENCODE_ACL_RIGHTS: "459167", // 0600 data access plus DELETE, READ_CONTROL and WRITE_DAC
    OPENCODE_ACL_ACCESS: "3",
    OPENCODE_ACL_CREATE: String(create),
    OPENCODE_ACL_EXCLUSIVE: "false",
    OPENCODE_ACL_MARKER: file + ".pid",
  }
}

// Keep the production script intact. Hang only after its real ACL operation,
// while still in the same host, to exercise timeout/abort without mocking exec.
const hang = FileModeWindows.script + `
[System.IO.File]::WriteAllText($env:OPENCODE_ACL_MARKER, [string]$PID)
[System.Threading.Thread]::Sleep(60000)
`

test.skipIf(process.platform !== "win32")("system PS5.1 works without pwsh or PATH", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-ps51-中文 ' "))
  const original = process.env.PATH
  try {
    process.env.PATH = ""
    expect(FileModeWindows.command().toLowerCase()).toEndWith("\\windowspowershell\\v1.0\\powershell.exe")
    const file = path.join(root, "private")
    await FileMode.prepare(file)
    await writeFile(file, "fixture")
    await grantEveryone(file)
    await FileMode.prepare(file)
    const found = await acl(file)
    expect(found.protected).toBe(true)
    expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
    await FileMode.prepare(file + ".tmp")
    await writeFile(file + ".tmp", "replacement")
    await rename(file + ".tmp", file)
    expect(await readFile(file, "utf8")).toBe("replacement")
  } finally {
    if (original === undefined) delete process.env.PATH
    else process.env.PATH = original
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32" || !Bun.which("pwsh.exe"))("PS7 uses the same creation, replacement and recovery contract", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-ps7-acl-"))
  const file = path.join(root, "private")
  const command = Bun.which("pwsh.exe") ?? undefined
  try {
    await FileModeWindows.execute(FileModeWindows.script, variables(file), { command })
    await writeFile(file, "fixture")
    await grantEveryone(file)
    await FileModeWindows.execute(FileModeWindows.script, variables(file), { command })
    const found = await acl(file)
    expect(found.protected).toBe(true)
    expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
    await FileModeWindows.execute(FileModeWindows.script, variables(file + ".tmp"), { command })
    await writeFile(file + ".tmp", "replacement")
    await rename(file + ".tmp", file)
    expect(await readFile(file, "utf8")).toBe("replacement")
    await grantEveryone(file)
    const original = await acl(file)
    await chmod(file, 0o400)
    await expect(FileModeWindows.execute(FileModeWindows.script, variables(file), { command })).rejects.toThrow()
    expect((await acl(file)).sddl).toBe(original.sddl)
  } finally {
    await chmod(file, 0o600).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32").each([true, false])("timeout kills/reaps the host and retains owner access (create=%s)", async (create) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-timeout-"))
  const file = path.join(root, "private")
  try {
    if (!create) {
      await writeFile(file, "fixture")
      await grantEveryone(file)
    }
    const started = Date.now()
    await expect(FileModeWindows.execute(hang, variables(file, create), { timeout: 4_000 })).rejects.toThrow("timeout or cancellation")
    expect(Date.now() - started).toBeLessThan(8_000)
    const pid = Number(await readFile(file + ".pid", "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
    const found = await acl(file)
    expect(found.protected).toBe(true)
    expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
    expect(await readFile(file, "utf8")).toBe(create ? "" : "fixture")
    await writeFile(file, "still-writable")
    await rename(file, file + ".moved")
    expect(await readFile(file + ".moved", "utf8")).toBe("still-writable")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test.skipIf(process.platform !== "win32")("abort waits for host cleanup without resetting its private DACL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-abort-"))
  const file = path.join(root, "private")
  const controller = new AbortController()
  const result = FileModeWindows.execute(hang, variables(file), { signal: controller.signal }).catch((error: unknown) => error)
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await stat(file + ".pid").then(() => true, () => false)) break
      await Bun.sleep(25)
    }
    const pid = Number(await readFile(file + ".pid", "utf8"))
    const started = Date.now()
    controller.abort()
    expect(await result).toBeInstanceOf(Error)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(() => process.kill(pid, 0)).toThrow()
    expect((await acl(file)).protected).toBe(true)
    await writeFile(file, "after-abort")
    expect(await readFile(file, "utf8")).toBe("after-abort")
  } finally {
    controller.abort()
    await result
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)

test.skipIf(process.platform !== "win32")("pre-aborted preparation reports failure without writing content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-pre-abort-"))
  try {
    const controller = new AbortController()
    controller.abort()
    const file = path.join(root, "private")
    await expect(FileMode.prepare(file, { signal: controller.signal })).rejects.toThrow()
    await expect(stat(file)).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 20_000)
