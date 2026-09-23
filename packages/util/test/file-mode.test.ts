import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileMode } from "../src/file-mode.js"
import { acl, grantEveryone } from "./fixture/file-acl.js"

test.skipIf(process.platform !== "win32")("private creation, existing explicit ACE removal, replacement and deletion use the real SID", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-中文 ' "))
  const file = path.join(root, "credential.json")
  const temp = path.join(root, "credential.tmp")
  const username = process.env.USERNAME
  try {
    process.env.USERNAME = "not-the-current-user"
    await FileMode.prepare(path.relative(process.cwd(), file))
    expect(await readFile(file, "utf8")).toBe("")
    const created = await acl(file)
    expect(created.protected).toBe(true)
    expect(created.rules).toEqual([{ sid: created.current, inherited: false, allow: true, rights: 1507743 }])
    await writeFile(file, "fixture-only")
    await grantEveryone(file)
    await FileMode.prepare(file)
    expect((await acl(file)).rules).toEqual(created.rules)
    await expect(FileMode.prepare(file, { exclusive: true })).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe("fixture-only")
    await FileMode.prepare(temp)
    await writeFile(temp, "replacement")
    await rename(temp, file)
    expect((await acl(file)).rules).toEqual(created.rules)
    await writeFile(file, "read-write-after-replace")
    expect(await readFile(file, "utf8")).toBe("read-write-after-replace")
  } finally {
    if (username === undefined) delete process.env.USERNAME
    else process.env.USERNAME = username
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32")("shared modes do not tighten ACLs; failed paths do not create files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-modes-"))
  try {
    const file = path.join(root, "shared")
    await writeFile(file, "shared")
    const original = await acl(file)
    await FileMode.apply(file, 0o644)
    expect((await acl(file)).sddl).toBe(original.sddl)
    await expect(FileMode.prepare(path.join(root, "missing", "private"))).rejects.toThrow()
    await FileMode.prepare(path.join(root, "absent"), { create: false })
    await expect(stat(path.join(root, "absent"))).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform === "win32")("Unix apply preserves chmod semantics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-mode-"))
  try {
    const file = path.join(root, "file")
    await writeFile(file, "fixture")
    await FileMode.apply(file, 0o600)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await FileMode.apply(file, 0o640)
    expect((await stat(file)).mode & 0o777).toBe(0o640)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "win32")("owner read-only and write-only modes enforce data access without losing ACL recovery", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-owner-modes-"))
  const file = path.join(root, "private")
  try {
    await FileMode.prepare(file)
    await writeFile(file, "fixture")
    await FileMode.apply(file, 0o400)
    expect(await readFile(file, "utf8")).toBe("fixture")
    await expect(writeFile(file, "denied")).rejects.toThrow()
    await FileMode.apply(file, 0o200)
    await writeFile(file, "write-only")
    await expect(readFile(file, "utf8")).rejects.toThrow()
    await FileMode.apply(file, 0o600)
    expect(await readFile(file, "utf8")).toBe("write-only")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32")("failed read-write verification restores the original DACL without locking out its owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-recovery-"))
  const file = path.join(root, "readonly")
  try {
    await writeFile(file, "fixture")
    const original = await acl(file)
    await chmod(file, 0o400)
    await expect(FileMode.prepare(file)).rejects.toThrow()
    expect((await acl(file)).sddl).toBe(original.sddl)
    expect(await readFile(file, "utf8")).toBe("fixture")
    await chmod(file, 0o600)
    await writeFile(file, "recovered")
    expect(await readFile(file, "utf8")).toBe("recovered")
  } finally {
    await chmod(file, 0o600).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
