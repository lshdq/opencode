import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Flock } from "@opencode/util/flock"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Global } from "@opencode/util/global"
import { RipgrepBinary } from "../src/ripgrep/binary"
import { it } from "./lib/effect"

// Concurrent first resolves of the ripgrep binary serialize behind the shared
// lock: after another process publishes a verified target, both waiting callers
// must re-check it instead of starting another download. Do not manufacture a
// release ZIP here: the production path now requires the upstream pinned hash.

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
const install = (root: string, archive: Buffer, state: { downloads: number; active: number; peak: number }, acquiring: Effect.Effect<void> = Effect.void) => {
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
    replacements: [
      LayerNodePlatform.httpClient.replace(http),
      Global.node.replace(global),
      EffectFlock.node.replace(
        Layer.effect(
          EffectFlock.Service,
          Effect.map(EffectFlock.Service, (flock) => EffectFlock.Service.of({
            ...flock,
            acquire: (key, directory, options) => acquiring.pipe(Effect.andThen(flock.acquire(key, directory, options))),
          })),
        ).pipe(Layer.provide(LayerNode.compile(EffectFlock.node, { replacements: [Global.node.replace(global)] }))),
      ),
    ],
  })
  return Effect.flatMap(RipgrepBinary.Service, (service) => service.filepath).pipe(Effect.provide(layer), Effect.scoped)
}

describe.skipIf(!ripgrepPlatform || !shell)("ripgrep binary install lock", () => {
  it.live("concurrent callers wait for a publisher and recheck its target without downloading", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-rg-lock-")))
      const state = { downloads: 0, active: 0, peak: 0 }
      const ready = yield* Deferred.make<void>()
      let waiting = 0
      const acquiring = Effect.suspend(() => {
        waiting++
        return waiting === 2 ? Deferred.succeed(ready, undefined).pipe(Effect.asVoid) : Effect.void
      })
      const savedPath = process.env.PATH
      let release: (() => Promise<void>) | undefined
      // A system rg.exe on PATH would short-circuit the install path under test.
      process.env.PATH = ""
      try {
        const lease = yield* Effect.promise(() => Flock.acquire(`ripgrep-binary:${VERSION}`, { dir: path.join(root, "state", "locks") }))
        release = () => lease.release()
        const running = yield* Effect.all([
          install(root, Buffer.from("unverified"), state, acquiring),
          install(root, Buffer.from("unverified"), state, acquiring),
        ], { concurrency: "unbounded" }).pipe(Effect.forkChild)
        yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
        const target = path.join(root, "cache", "bin", "rg.exe")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, "real ripgrep fixture")
          await lease.release()
          release = undefined
        })
        const [first, second] = yield* Fiber.join(running)
        expect(first).toBe(target)
        expect(second).toBe(target)
        expect(state.downloads).toBe(0)
        expect(waiting).toBe(2)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("real ripgrep fixture")
        // Waiting callers leave no download or partial files.
        expect(yield* Effect.promise(() => fs.readdir(path.dirname(target)))).toEqual(["rg.exe"])
      } finally {
        process.env.PATH = savedPath
        if (release) yield* Effect.promise(release)
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
      }
    }))

  it.live("rejects an unverified archive without publishing an executable", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-rg-hash-")))
      const savedPath = process.env.PATH
      process.env.PATH = ""
      try {
        const archive = yield* Effect.promise(() => makeArchive(root))
        const state = { downloads: 0, active: 0, peak: 0 }
        const result = yield* install(root, archive, state).pipe(Effect.exit)
        expect(result).toMatchObject({ _tag: "Failure" })
        expect(state.downloads).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(path.join(root, "cache", "bin", "rg.exe")).exists())).toBe(false)
      } finally {
        process.env.PATH = savedPath
        yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
      }
    }),
  )
})
