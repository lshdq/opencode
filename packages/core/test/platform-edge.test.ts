import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Exit, Fiber, FileSystem, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { testEffect } from "./lib/effect"
import { alive, edgeFixture, waitFor } from "./fixture/platform-edge"

const live = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem])))
const windows = process.platform === "win32" ? live.live : live.live.skip

describe("Windows platform edge baseline", () => {
  for (const runtime of [process.execPath, "node"]) {
    windows(
      `bounds inherited output without killing normally exiting descendants (${runtime})`,
      Effect.gen(function* () {
        const tmp = yield* edgeFixture()
        const started = Date.now()
        const child = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make(runtime, [tmp.script, "shell"], {
              cwd: tmp.path,
              stdin: "ignore",
              forceKillAfter: 500,
            })
            const [code, out, err] = yield* Effect.all(
              [
                handle.exitCode,
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.timeout("5 seconds"))
            expect(code).toBe(ChildProcessSpawner.ExitCode(0))
            expect(out).toContain('"method":"ready"')
            expect(err).toBe("foreground-error\n")
            return yield* Effect.promise(() => tmp.pid("child"))
          }),
        )
        expect(Date.now() - started).toBeLessThan(6000)
        // The process scope has closed too: changing scope release into unconditional kill is a regression.
        expect(alive(child)).toBe(true)
      }),
      15000,
    )

    windows(
      `kills a live wrapper and its owned descendant (${runtime})`,
      Effect.gen(function* () {
        const tmp = yield* edgeFixture()
        const handle = yield* ChildProcess.make(runtime, [tmp.script, "running"], {
          cwd: tmp.path,
          stdin: "ignore",
          forceKillAfter: 500,
        })
        yield* Effect.promise(() => waitFor(() => Bun.file(path.join(tmp.path, "child.ready")).exists()))
        const child = yield* Effect.promise(() => tmp.pid("child"))
        expect(alive(child)).toBe(true)
        yield* handle.kill({ forceKillAfter: 500 }).pipe(Effect.timeout("5 seconds"))
        yield* Effect.promise(() => waitFor(() => !alive(child)))
        expect(alive(Number(handle.pid))).toBe(false)
      }),
      15000,
    )
  }

  windows(
    "interrupting a process scope cleans a live owned process tree",
    Effect.gen(function* () {
      const tmp = yield* edgeFixture()
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ChildProcess.make(process.execPath, [tmp.script, "running"], {
            cwd: tmp.path,
            stdin: "ignore",
            forceKillAfter: 500,
          })
          yield* Effect.never
        }),
      ).pipe(Effect.forkScoped)
      yield* Effect.promise(() => waitFor(() => Bun.file(path.join(tmp.path, "child.ready")).exists()))
      const parent = yield* Effect.promise(() => tmp.pid("parent"))
      const child = yield* Effect.promise(() => tmp.pid("child"))
      yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"))
      yield* Effect.promise(() => waitFor(() => !alive(parent) && !alive(child)))
      expect(alive(child)).toBe(false)
    }),
    15000,
  )

  windows(
    "reports repeated spawn errors and invalid cwd without a watchdog",
    Effect.gen(function* () {
      const tmp = yield* edgeFixture()
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      for (const cwd of [tmp.path, path.join(tmp.path, "missing")]) {
        for (let attempt = 0; attempt < 5; attempt++) {
          const result = yield* spawner
            .exitCode(ChildProcess.make(path.join(tmp.path, "absent.exe"), [], { cwd }))
            .pipe(Effect.exit, Effect.timeout("3 seconds"))
          expect(Exit.isFailure(result) || result.value !== 0).toBe(true)
        }
      }
    }),
    15000,
  )

  windows(
    "Git for Windows accepts the official /dev/null untracked diff arguments",
    Effect.gen(function* () {
      const tmp = yield* edgeFixture()
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "untracked 中文.txt"), "first\nsecond\n"))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      expect(yield* spawner.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd: tmp.path }))).toBe(
        ChildProcessSpawner.ExitCode(0),
      )
      for (const format of ["--patch", "--numstat"]) {
        const handle = yield* ChildProcess.make(
          "git",
          [
            "-c",
            "core.quotepath=false",
            "diff",
            "--no-index",
            format,
            "--no-ext-diff",
            "--no-renames",
            "--",
            "/dev/null",
            "untracked 中文.txt",
          ],
          { cwd: tmp.path, forceKillAfter: 500 },
        )
        const [code, text, error] = yield* Effect.all(
          [
            handle.exitCode,
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.timeout("5 seconds"))
        expect(code).toBe(ChildProcessSpawner.ExitCode(1))
        expect(error).toBe("")
        if (format === "--patch") {
          expect(text).toContain("--- /dev/null")
          expect(text).toContain("+first\n+second")
          continue
        }
        expect(text).toStartWith("2\t0\t")
      }
    }),
    15000,
  )

  windows(
    "characterizes exclusive Windows file locks and recovery after release",
    Effect.gen(function* () {
      const tmp = yield* edgeFixture()
      const file = path.join(tmp.path, "locked.txt")
      yield* Effect.promise(() => fs.writeFile(file, "original"))
      const script = path.join(tmp.path, "lock.ps1")
      yield* Effect.promise(() =>
        fs.writeFile(
          script,
          [
            '$ErrorActionPreference = "Stop"',
            '$handle = [System.IO.File]::Open((Join-Path $PWD "locked.txt"), "Open", "ReadWrite", "None")',
            "try {",
            '  [System.IO.File]::WriteAllText((Join-Path $PWD "lock.ready"), "ready")',
            "  $deadline = [DateTime]::UtcNow.AddSeconds(10)",
            '  while (!(Test-Path -LiteralPath (Join-Path $PWD "attempt")) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }',
            "  Start-Sleep -Milliseconds 750",
            "} finally { $handle.Dispose() }",
          ].join("\n"),
        ),
      )
      const handle = yield* ChildProcess.make("pwsh.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
        cwd: tmp.path,
        forceKillAfter: 500,
      })
      yield* Effect.promise(() => waitFor(() => Bun.file(path.join(tmp.path, "lock.ready")).exists(), 5000))
      const files = yield* FileSystem.FileSystem
      const started = Date.now()
      yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "attempt"), "attempt"))
      const locked = yield* files.writeFileString(file, "replacement").pipe(Effect.exit, Effect.timeout("2 seconds"))
      expect(Exit.isFailure(locked)).toBe(true)
      expect(Date.now() - started).toBeLessThan(2000)
      expect(yield* handle.exitCode.pipe(Effect.timeout("3 seconds"))).toBe(ChildProcessSpawner.ExitCode(0))
      expect(yield* files.readFileString(file)).toBe("original")
      yield* files.writeFileString(file, "replacement")
      expect(yield* files.readFileString(file)).toBe("replacement")
    }),
    15000,
  )
})
