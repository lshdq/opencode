import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { FSUtil } from "@opencode/util/fs-util"

// Kept separate from binary discovery so cold extraction can be exercised without the global rg cache.
export const extractZip = Effect.fnUntraced(function* (input: {
  archive: string
  directory: string
  executable: string
  find: (name: string) => string | null | undefined
  env?: NodeJS.ProcessEnv
}) {
  const fs = yield* FSUtil.Service
  const spawner = yield* ChildProcessSpawner
  // A pwsh-launched parent can put PS7-only modules ahead of PS5.1's built-ins.
  // Do not merge this environment back into process.env (or extend it at spawn).
  const env = Object.fromEntries(
    Object.entries(input.env ?? process.env).flatMap(([key, value]) =>
      value !== undefined && key.toLowerCase() !== "psmodulepath" ? [[key, value]] : [],
    ),
  )
  const script = [
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [Console]::OutputEncoding",
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `try { Expand-Archive -LiteralPath '${input.archive.replaceAll("'", "''")}' -DestinationPath '${input.directory.replaceAll("'", "''")}' -Force } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`,
  ].join("; ")
  const errors: string[] = []
  for (const name of ["tar.exe", "pwsh.exe", "powershell.exe"]) {
    const command = yield* Effect.sync(() => input.find(name))
    if (!command) continue
    const result = yield* Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          command,
          name === "tar.exe"
            ? ["-xf", input.archive, "-C", input.directory]
            : ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          { stdin: "ignore", extendEnv: false, env },
        ),
      )
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(handle.stdout)),
          Stream.mkString(Stream.decodeText(handle.stderr)),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      )
      // PATH may resolve GNU tar, which cannot read ZIP. Exit status AND the expected artifact
      // establish support; a missing/broken tool must not prevent PowerShell fallback.
      if (code === 0 && (yield* fs.isFile(input.executable))) return true
      errors.push(
        `${name}: ${stderr.trim() || stdout.trim() || `exit ${code}; missing executable: ${input.executable}`}`,
      )
      return false
    }).pipe(
      Effect.scoped,
      Effect.catch((error) => {
        errors.push(`${name}: ${String(error)}`)
        return Effect.succeed(false)
      }),
    )
    if (result) return
  }
  return yield* Effect.fail(new Error(`ripgrep ZIP extraction failed: ${errors.join("\n") || "no extractor found"}`))
})
