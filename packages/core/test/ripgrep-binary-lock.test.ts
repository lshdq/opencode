import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Flock } from "@opencode/util/flock"
import { Global } from "@opencode/util/global"
import { RipgrepBinary } from "../src/ripgrep/binary"
import { it } from "./lib/effect"

// Concurrent first resolves of the ripgrep binary serialize behind the shared
// Flock: the winner downloads, extracts, and publishes under the lock while the
// loser re-checks the target after acquiring the lock and reuses it without a
// second download. The lock also keeps a Windows copy onto a target being
// executed by another process from failing with EPERM.

const VERSION = "15.1.0"
const PLATFORM = {
  "arm64-win32": "aarch64-pc-windows-msvc",
  "ia32-win32": "i686-pc-windows-msvc",
  "x64-win32": "x86_64-pc-windows-msvc",
} as const
const ripgrepPlatform = PLATFORM[`${process.arch}-${process.platform}` as keyof typeof PLATFORM]
const shell = Bun.which("pwsh.exe") ?? Bun.which("powershell.exe")

async function makeArchive(root: string) {
  const source = path.join(root, "archive-source")
  const file = path.join(source, `ripgrep-${VERSION}-${ripgrepPlatform}`, "rg.exe")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "real ripgrep fixture")
  const archive = path.join(root, `ripgrep-${VERSION}-${ripgrepPlatform}.zip`)
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${source.replaceAll("'", "''")}', '${archive.replaceAll("'", "''")}')`
  const proc = Bun.spawn(
    [shell!, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdout: "ignore", stderr: "pipe" },
  )
  const stderr = await new Response(proc.stderr).text()
  expect(await proc.exited, stderr).toBe(0)
  await fs.rm(source, { recursive: true, force: true })
  return Buffer.from(await fs.readFile(archive))
}

// A separate service instance per contender: each instance caches its own
// filepath resolution, so both race the check-then-download path.
const install = (root: string, archive: Buffer, state: { downloads: number; active: number; peak: number }) => {
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        state.downloads += 1
        state.active += 1
        state.peak = Math.max(state.peak, state.active)
        // Long enough for the loser to reach the Flock and wait behind the winner.
        yield* Effect.sleep(300)
        state.active -= 1
        return HttpClientResponse.fromWeb(request, new Response(archive))
      }),
    ),
  )
  const global = Layer.succeed(
    Global.Service,
    Global.make({
      home: root,
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "cache", "bin"),
      log: path.join(root, "data", "log"),
      repos: path.join(root, "data", "repos"),
    }),
  )
  const layer = LayerNode.compile(RipgrepBinary.node, {
    replacements: [LayerNodePlatform.httpClient.replace(http), Global.node.replace(global)],
  })
  return Effect.flatMap(RipgrepBinary.Service, (service) => service.filepath).pipe(Effect.provide(layer), Effect.scoped)
}

describe.skipIf(!ripgrepPlatform || !shell)("ripgrep binary install lock", () => {
  it.live("concurrent installs download once and share the published target", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-rg-lock-")))
      const archive = yield* Effect.promise(() => makeArchive(root))
      const state = { downloads: 0, active: 0, peak: 0 }
      const savedPath = process.env.PATH
      // A system rg.exe on PATH would short-circuit the install path under test.
      process.env.PATH = ""
      Flock.setGlobal({ state: path.join(root, "state") })
      try {
        const [first, second] = yield* Effect.all([install(root, archive, state), install(root, archive, state)], {
          concurrency: "unbounded",
        })
        const target = path.join(root, "cache", "bin", "rg.exe")
        expect(first).toBe(target)
        expect(second).toBe(target)
        expect(state.downloads).toBe(1)
        expect(state.peak).toBe(1)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("real ripgrep fixture")
        // The winner removed the archive; the loser left no partial files.
        expect(yield* Effect.promise(() => fs.readdir(path.dirname(target)))).toEqual(["rg.exe"])
      } finally {
        process.env.PATH = savedPath
        Flock.setGlobal({ state: Global.Path.state })
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
      }
    }), 60_000)
})
