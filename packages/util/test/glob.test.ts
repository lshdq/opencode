import { expect, test } from "bun:test"
import { readdir } from "node:fs"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { glob } from "glob"
import { Glob } from "../src/glob.js"

test("checked glob reports swallowed readdir failures without changing missing or empty matches", async () => {
  const root = await fs.mkdtemp(path.join(process.platform === "win32" ? "D:\\temp\\systemp\\opencode" : tmpdir(), "glob-check-"))
  const directory = path.join(root, "rules")
  const file = path.join(directory, "rule.md")
  try {
    await fs.mkdir(directory)
    await fs.writeFile(file, "rule")
    const options = { cwd: root, absolute: true, include: "file" as const, dot: true }
    expect(await Glob.scan("rules/*.md", options)).toEqual([file])
    expect(await Glob.scanChecked("rules/*.md", options)).toEqual([file])
    expect(await Glob.scanChecked("absent/*.md", options)).toEqual([])
    expect(await Glob.scanChecked("rules/*.txt", options)).toEqual([])

    const error = Object.assign(new Error("simulated denied directory"), { code: "EACCES" })
    const failing: NonNullable<Parameters<typeof Glob.scanChecked>[2]> = (dir, opts, callback) =>
      dir === directory ? callback(error) : readdir(dir, opts, callback)
    // This is the dependency's actual swallowed-error behavior, not a stubbed [] result.
    expect(await glob("rules/*.md", { ...options, fs: { readdir: failing } })).toEqual([])
    await expect(Glob.scanChecked("rules/*.md", options, failing)).rejects.toBe(error)

    const missing: NonNullable<Parameters<typeof Glob.scanChecked>[2]> = (dir, opts, callback) =>
      dir === directory
        ? callback(Object.assign(new Error("missing"), { code: "ENOENT" }))
        : readdir(dir, opts, callback)
    expect(await Glob.scanChecked("rules/*.md", options, missing)).toEqual([])
    const notDirectory: NonNullable<Parameters<typeof Glob.scanChecked>[2]> = (dir, opts, callback) =>
      dir === directory
        ? callback(Object.assign(new Error("not a directory"), { code: "ENOTDIR" }))
        : readdir(dir, opts, callback)
    expect(await Glob.scanChecked("rules/*.md", options, notDirectory)).toEqual([])

    await fs.rm(file)
    expect(await Glob.scanChecked("rules/*.md", options)).toEqual([])
    expect(await Glob.scan("rules/*.md", options)).toEqual([])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
