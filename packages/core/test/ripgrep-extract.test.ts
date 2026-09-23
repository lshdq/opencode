import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { FSUtil } from "@opencode/util/fs-util"
import { extractZip } from "../src/ripgrep/extract-zip"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(LayerNode.compile(FSUtil.node), LayerNode.compile(CrossSpawnSpawner.node)))
const tools = {
  "tar.exe": Bun.which("tar.exe"),
  "pwsh.exe": Bun.which("pwsh.exe"),
  "powershell.exe": Bun.which("powershell.exe"),
}

const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rg 中文 space ' "))
    return { root }
  }),
  ({ root }) => Effect.promise(() => fs.rm(root, { recursive: true, force: true })),
).pipe(
  Effect.flatMap(({ root }) =>
    Effect.promise(async () => {
      const source = path.join(root, "source")
      const directory = path.join(root, "输出 '")
      const archive = path.join(root, "压缩 ' [literal].zip")
      const relative = path.join("ripgrep-15.1.0-x86_64-pc-windows-msvc", "rg.exe")
      await fs.mkdir(path.join(source, path.dirname(relative)), { recursive: true })
      await fs.mkdir(directory)
      await fs.writeFile(path.join(source, relative), "real ZIP fixture — 中文")
      const shell = tools["pwsh.exe"] ?? tools["powershell.exe"]
      if (!shell) throw new Error("PowerShell is required to create ZIP fixtures")
      const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${source.replaceAll("'", "''")}', '${archive.replaceAll("'", "''")}')`
      const proc = Bun.spawn(
        [shell, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { stdout: "pipe", stderr: "pipe" },
      )
      expect(await proc.exited).toBe(0)
      const poison = path.join(root, "modules", "Microsoft.PowerShell.Archive")
      await fs.mkdir(poison, { recursive: true })
      await fs.writeFile(
        path.join(poison, "Microsoft.PowerShell.Archive.psd1"),
        "@{ ModuleVersion = '99.0'; RootModule = 'poison.psm1'; PowerShellVersion = '5.1'; GUID = '94e51041-a42c-49be-a28d-a2a39d8be140'; FunctionsToExport = @('Expand-Archive') }",
      )
      await fs.writeFile(
        path.join(poison, "poison.psm1"),
        "function Expand-Archive { throw 'poisoned PSModulePath' }; Export-ModuleMember -Function Expand-Archive",
      )
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"))
      return { archive, directory, executable: path.join(directory, relative), env: { ...env, PSModulePath: path.dirname(poison) } }
    }),
  ),
)

describe.skipIf(process.platform !== "win32")("ripgrep cold ZIP extraction (isolated)", () => {
  for (const name of ["tar.exe", "pwsh.exe", "powershell.exe"] as const) {
    const run = tools[name] ? it.live : it.live.skip
    run(`${name} extracts real ZIP with polluted modules and literal Unicode paths`, () =>
      Effect.gen(function* () {
        const input = yield* fixture
        const before = process.env.PSModulePath
        yield* extractZip({ ...input, find: (key) => (key === name ? tools[name] : undefined) })
        expect(yield* Effect.promise(() => fs.readFile(input.executable, "utf8"))).toBe("real ZIP fixture — 中文")
        expect(process.env.PSModulePath).toBe(before)
        expect(input.env.PSModulePath).toContain("modules")
      }),
      30_000,
    )
  }

  for (const failure of ["exit", "spawn"] as const) {
    it.live(`failed tar ${failure} falls back to pwsh before PS5.1`, () =>
      Effect.gen(function* () {
        const input = yield* fixture
        const calls: string[] = []
        yield* extractZip({
          ...input,
          find: (name) => {
            calls.push(name)
            if (name === "tar.exe") return failure === "exit" ? process.execPath : path.join(input.directory, "missing.exe")
            if (name === "pwsh.exe") return tools["pwsh.exe"] ?? undefined
            return tools["powershell.exe"] ?? undefined
          },
        })
        expect(calls).toEqual(
          tools["pwsh.exe"] ? ["tar.exe", "pwsh.exe"] : ["tar.exe", "pwsh.exe", "powershell.exe"],
        )
        expect(yield* Effect.promise(() => fs.readFile(input.executable, "utf8"))).toBe("real ZIP fixture — 中文")
      }),
      30_000,
    )
  }

  const ps51 = tools["powershell.exe"] ? it.live : it.live.skip
  ps51("failed pwsh falls back to clean PS5.1", () =>
    Effect.gen(function* () {
      const input = yield* fixture
      yield* extractZip({
        ...input,
        find: (name) =>
          name === "pwsh.exe" ? process.execPath : name === "powershell.exe" ? tools[name] : undefined,
      })
      expect(yield* Effect.promise(() => fs.readFile(input.executable, "utf8"))).toBe("real ZIP fixture — 中文")
    }),
    30_000,
  )

  it.live("successful exit without the expected artifact is rejected by every extractor", () =>
    Effect.gen(function* () {
      const input = yield* fixture
      const calls: string[] = []
      const error = yield* extractZip({
        ...input,
        executable: path.join(input.directory, "absent.exe"),
        find: (name) => {
          calls.push(name)
          return tools[name as keyof typeof tools]
        },
      }).pipe(Effect.flip)
      expect(error.message).toContain("missing executable")
      expect(calls).toEqual(["tar.exe", "pwsh.exe", "powershell.exe"])
    }),
    30_000,
  )

  ps51("inherited poisoned PSModulePath reproduces the PS5.1 failure", () =>
    Effect.gen(function* () {
      const input = yield* fixture
      const shell = tools["powershell.exe"]
      if (!shell) return
      const result = yield* Effect.promise(async () => {
        const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; try { Expand-Archive -LiteralPath '${input.archive.replaceAll("'", "''")}' -DestinationPath '${input.directory.replaceAll("'", "''")}' -Force } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`
        const proc = Bun.spawn(
          [shell, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          { env: input.env, stdout: "pipe", stderr: "pipe" },
        )
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
        return { code, stderr }
      })
      expect(result.code).not.toBe(0)
      expect(result.stderr).toMatch(/poisoned PSModulePath|Microsoft\.PowerShell\.Archive/)
      yield* extractZip({ ...input, find: (name) => (name === "powershell.exe" ? shell : undefined) })
      expect(yield* Effect.promise(() => fs.readFile(input.executable, "utf8"))).toBe("real ZIP fixture — 中文")
    }),
    30_000,
  )

  it.live("corrupt ZIP fails without installing an artifact", () =>
    Effect.gen(function* () {
      const input = yield* fixture
      yield* Effect.promise(() => fs.writeFile(input.archive, "not a zip"))
      const error = yield* extractZip({ ...input, find: (name) => tools[name as keyof typeof tools] }).pipe(Effect.flip)
      expect(error.message).toContain("ripgrep ZIP extraction failed")
      expect(yield* Effect.promise(() => Bun.file(input.executable).exists())).toBe(false)
    }),
    30_000,
  )

  for (const name of ["pwsh.exe", "powershell.exe"] as const) {
    const run = tools[name] ? it.live : it.live.skip
    run(`${name} returns readable UTF-8 errors and can retry`, () =>
      Effect.gen(function* () {
        const input = yield* fixture
        const find = (key: string) => (key === name ? tools[name] : undefined)
        const error = yield* extractZip({
          ...input,
          archive: path.join(input.directory, "不存在 中文.zip"),
          find,
        }).pipe(Effect.flip)
        expect(error.message).toContain("不存在 中文.zip")
        expect(error.message).not.toContain("\uFFFD")
        expect(yield* Effect.promise(() => Bun.file(input.executable).exists())).toBe(false)
        yield* extractZip({ ...input, find })
        expect(yield* Effect.promise(() => fs.readFile(input.executable, "utf8"))).toBe("real ZIP fixture — 中文")
      }),
      30_000,
    )
  }
})
