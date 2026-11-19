import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string>) {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-check-greys-"))
  cleanup.push(directory)
  // The script locates its scan roots relative to itself, so copy the real entry point unchanged.
  await Bun.write(
    path.join(directory, "script/check-greys.ts"),
    Bun.file(path.resolve(import.meta.dir, "../../../script/check-greys.ts")),
  )
  await Promise.all(Object.entries(files).map(([file, source]) => Bun.write(path.join(directory, file), source)))
  return directory
}

async function run(directory: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, "script/check-greys.ts", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, code }
}

test("native paths retain directory and exact-file exemptions and allow shared tokens", async () => {
  const cases = [
    ["services/site/src/component/video-editor/editor.css", "Internal video editor"],
    ["services/site/src/component/site/device-preview.css", "Device preview tool: device frames"],
    [
      "services/site/src/style/token/color.css",
      "Legacy tokens: to remove when the dropdown, language picker, 404 and limits graph move to site tokens",
    ],
  ]
  const tokens = [
    ["packages/nav-menus/src/token.css", "#ffffff"],
    ["packages/data/app/src/token.css", "#161616"],
  ]
  const directory = await fixture({
    ...Object.fromEntries(cases.map(([file]) => [file, ".fixture {\n  color: #777777;\n}\n"])),
    ...Object.fromEntries(tokens.map(([file, hex]) => [file, `:root { --surface: ${hex}; }\n`])),
  })
  const [normal, json] = await Promise.all([run(directory), run(directory, "--json")])
  expect(normal.stderr).toBe("")
  expect(normal).toEqual({ stdout: "", stderr: "", code: 0 })
  expect(json.stderr).toBe("")
  expect(json.code).toBe(0)
  const report = JSON.parse(json.stdout)
  expect(Object.keys(report).sort()).toEqual(["entries", "exceptions", "scale"])
  expect(report.entries).toHaveLength(5)
  cases.forEach(([file, reason]) => {
    expect(report.entries).toContainEqual({
      file: path.normalize(file),
      line: 2,
      property: "color",
      hex: "#777777",
      alpha: false,
      text: "color: #777777",
      outcome: `exception: ${reason}`,
    })
  })
  tokens.forEach(([file, hex]) => {
    expect(report.entries).toContainEqual({
      file: path.normalize(file),
      line: 1,
      property: "--surface",
      hex,
      alpha: false,
      text: `--surface: ${hex}`,
      outcome: "token",
    })
  })
})

test("near-miss paths and ordinary grey violations still fail with native diagnostic paths", async () => {
  const cases = [
    ["services/site/src/component/video-editor-copy/editor.css", "#777777", "not on the scale"],
    ["services/site/src/component/site/device-preview.other.css", "#777777", "not on the scale"],
    ["services/site/src/style/token/colors.css", "#777777", "not on the scale"],
    ["services/site/src/ordinary.css", "#ffffff", "use a token"],
  ]
  const directory = await fixture(
    Object.fromEntries(cases.map(([file, hex]) => [file, `.fixture {\n  color: ${hex};\n}\n`])),
  )
  const [normal, json] = await Promise.all([run(directory), run(directory, "--json")])
  expect(json.stderr).toBe("")
  // Audit mode intentionally returns success even when it lists problems.
  expect(json.code).toBe(0)
  const report = JSON.parse(json.stdout)
  expect(report.entries).toHaveLength(cases.length)
  cases.forEach(([file, hex, reason]) => {
    expect(normal.stderr).toContain(`${path.normalize(file)}:2  ${hex}  ${reason}  (color: ${hex})`)
    expect(report.entries).toContainEqual({
      file: path.normalize(file),
      line: 2,
      property: "color",
      hex,
      alpha: false,
      text: `color: ${hex}`,
      outcome: `problem: ${reason}`,
    })
  })
  expect(normal.stderr).toContain("4 greys off the shared scale (script/check-greys.ts).")
  expect(normal.stdout).toBe("")
  expect(normal.code).toBe(1)
})
