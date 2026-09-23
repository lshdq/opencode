import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { loopbackRequest } from "./loopback-http"
import { assertRegistration, execute, isolatedEnvironment, prepareIsolatedDatabaseDirectory } from "./windows-runtime"

// Source-only diagnostics; never discover or stop an existing service.
const target = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../../.."))
const arguments_ = process.argv.slice(3).filter((arg) => arg !== "--trace-imports")
if (
  !(arguments_.length === 1 && ["--version", "--help"].includes(arguments_[0])) &&
  arguments_.join(" ") !== "serve --service --port 0 --print-logs"
)
  throw new Error("Use --version, --help, or serve --service --port 0 --print-logs")
const parent = path.resolve(import.meta.dir, "../dist")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "source-diagnostic-"))
const env = isolatedEnvironment(root)
await Promise.all(
  [env.TEMP, env.OPENCODE_CONFIG_DIR, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME].map((dir) =>
    mkdir(dir, { recursive: true }),
  ),
)
await prepareIsolatedDatabaseDirectory(root).catch(async (error: unknown) => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  throw error
})
const trace = process.argv.includes("--trace-imports")
const preload = path.join(root, "trace.ts")
if (trace)
  await Bun.write(
    preload,
    `
console.error("TRACE preload", Date.now())
Bun.plugin({ name: "diagnostic-imports", setup(build) {
  build.onLoad({filter: /packages[\\\\/].*\\.ts$/}, async args => { console.error("TRACE", Date.now(), args.path); return { contents: await Bun.file(args.path).text(), loader: "ts" } })
} })
`,
  )
const command = [
  process.execPath,
  ...(trace ? ["--preload", preload] : []),
  path.join(target, "packages/cli/src/index.ts"),
  ...arguments_,
]
const child = Bun.spawn(command, { cwd: path.join(target, "packages/cli"), env, stdout: "pipe", stderr: "pipe" })
const started = performance.now()
const chunks = { stdout: "", stderr: "" }
const result = { ready: false }
const stdout = (async () => {
  for await (const value of child.stdout) chunks.stdout += new TextDecoder().decode(value)
})()
const stderr = (async () => {
  for await (const value of child.stderr) chunks.stderr += new TextDecoder().decode(value)
})()
try {
  const registration = path.join(env.XDG_STATE_HOME, "opencode", "service-local.json")
  for (let attempt = 0; attempt < 1800 && child.exitCode === null; attempt++) {
    if (await Bun.file(registration).exists()) {
      const info = assertRegistration(await Bun.file(registration).json(), child.pid, "local")
      console.log(
        JSON.stringify({
          registration: true,
          registrationMs: performance.now() - started,
          pid: info.pid,
          ownPID: child.pid,
          version: info.version,
        }),
      )
      const commandLine = await execute(
        [
          "pwsh.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}').CommandLine`,
        ],
        root,
        env,
      )
      if (!commandLine.includes(path.join(target, "packages/cli/src/index.ts")))
        throw new Error("Source process identity mismatch")
      for (let ready = 0; ready < 600; ready++) {
        const response = await loopbackRequest(new URL("/api/info", info.url), {
          headers: { authorization: `Basic ${btoa(`opencode:${info.password}`)}` },
          signal: AbortSignal.timeout(1_000),
        }).catch(() => undefined)
        if (response?.ok) {
          const body = await response.json()
          if (body.pid !== child.pid || body.version !== "local") throw new Error("API identity mismatch")
          console.log(JSON.stringify({ ready: true, pid: body.pid, status: response.status }))
          result.ready = true
          break
        }
        if (ready === 599) throw new Error("Source API not ready")
        await Bun.sleep(100)
      }
      break
    }
    await Bun.sleep(100)
  }
  console.log(
    JSON.stringify({
      target,
      args: arguments_,
      pid: child.pid,
      exit: child.exitCode,
      elapsedMs: performance.now() - started,
    }),
  )
  console.log(
    await execute(
      [
        "pwsh.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}' | Select-Object ProcessId,Name,ExecutablePath | ConvertTo-Json -Compress`,
      ],
      root,
      env,
    ),
  )
  if (arguments_[0] === "serve" ? !result.ready : child.exitCode !== 0)
    throw new Error("Source diagnostic failed or timed out")
} finally {
  if (child.exitCode === null)
    await execute(["taskkill.exe", "/pid", String(child.pid), "/T", "/F"], root, env).catch(() => child.kill())
  await child.exited
  await Promise.all([stdout, stderr])
  // Diagnostics only run --version/--help or managed service mode, never plaintext-password foreground serve.
  const lines = chunks.stderr.split("\n")
  console.log(
    JSON.stringify({
      stdout: chunks.stdout,
      stderr: lines.filter((line) => !line.startsWith("TRACE")).join("\n"),
      ...(trace
        ? {
            imports: lines.filter((line) =>
              /TRACE preload|cli[\\/]src[\\/](index|server-process)\.ts|handlers[\\/]serve\.ts|server[\\/]src[\\/]process\.ts|file-mode.*\.ts|sqlite.bun\.ts/.test(
                line,
              ),
            ),
          }
        : {}),
    }),
  )
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
