import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { FileMode } from "../src/file-mode.js"
import { FileModeWindows } from "../src/file-mode-windows.js"
import { acl, grantEveryone } from "./fixture/file-acl.js"
import { restrictedReader, windowSecret } from "./fixture/restricted-reader.js"

test.skipIf(process.platform !== "win32")("control: tightening a public file cannot revoke a real restricted token's retained read handle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-handle-control-"))
  const file = path.join(root, "public")
  await writeFile(file, "empty-fixture")
  await grantEveryone(file)
  const reader = restrictedReader([file], root)
  try {
    await reader.ready()
    await reader.opened()
    await FileMode.apply(file, 0o600)
    await writeFile(file, windowSecret)
    await reader.read()
    const result = await reader.close()
    expect(result.opened).toBe(1)
    expect(result.readSecret).toBe(true)
    expect((await acl(file)).protected).toBe(true)
  } finally {
    await reader.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32")("app-owned inheritance does not traverse a junction into an unrelated directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-directory-junction-"))
  const owned = path.join(root, "owned")
  const outside = path.join(root, "outside")
  try {
    await mkdir(owned)
    await mkdir(outside)
    await writeFile(path.join(outside, "data"), "unrelated-data")
    await symlink(outside, path.join(owned, "reference"), "junction")
    const before = await Promise.all([root, outside, path.join(outside, "data")].map(acl))
    await FileMode.directory(owned, { owned: true })
    const after = await Promise.all([root, outside, path.join(outside, "data")].map(acl))
    expect(after.map((item) => item.sddl)).toEqual(before.map((item) => item.sddl))
    expect(await readFile(path.join(outside, "data"), "utf8")).toBe("unrelated-data")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32" || !Bun.which("pwsh.exe"))("PS7 establishes and rechecks the same inheritable directory contract without changing bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-directory-ps7-"))
  const file = path.join(root, "existing-data")
  try {
    await writeFile(file, "preserved-data")
    for (const owned of [true, false]) {
      await FileModeWindows.execute(FileModeWindows.directoryScript, {
        OPENCODE_ACL_DIRECTORY: root,
        OPENCODE_ACL_OWNED_DIRECTORY: String(owned),
      }, { command: Bun.which("pwsh.exe") ?? undefined })
    }
    expect(await readFile(file, "utf8")).toBe("preserved-data")
    const found = await acl(file)
    expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
    expect(found.rules.every((rule) => rule.inherited && rule.allow)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

test.skipIf(process.platform !== "win32")("private inheritable directory denies the first read handle, not just later path opens", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-acl-directory-"))
  const file = path.join(root, "born-private")
  const reader = restrictedReader([file], root)
  try {
    await reader.ready()
    await FileMode.directory(path.relative(process.cwd(), root), { owned: true })
    await writeFile(file, windowSecret)
    const found = await acl(file)
    expect(found.rules.map((rule) => rule.sid)).toEqual([found.current])
    expect(found.rules.every((rule) => rule.inherited && rule.allow)).toBe(true)
    expect(await readFile(file, "utf8")).toBe(windowSecret)
    expect(reader.state.done).toBe(false)
    const result = await reader.close()
    expect(result.opened).toBe(0)
    expect(result.denied).toBeGreaterThan(0)
    expect(result.readSecret).toBe(false)
  } finally {
    await reader.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
