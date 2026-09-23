import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { loopbackRequest } from "./loopback-http"
import {
  assertRegistration,
  channel,
  cliVersion,
  execute,
  isolatedEnvironment,
  prepareIsolatedDatabaseDirectory,
  sha256,
} from "./windows-runtime"

if (process.platform !== "win32") throw new Error("Windows smoke requires Windows")
if (!process.argv[2]) throw new Error("Usage: bun script/smoke-win.ts <versioned-build-directory>")
const output = await realpath(process.argv[2])
await rm(path.join(output, "smoke-result.json"), { force: true })
const metadata = await Bun.file(path.join(output, "build-metadata.json")).json()
if (metadata.channel !== channel || metadata.version !== "2.0.12") throw new Error("Unexpected build identity")
const binary = await realpath(path.join(output, "compiled", "cli-windows-x64", "bin", "opencode.exe"))
if ((await sha256(binary)) !== metadata.binarySha256) throw new Error("Binary differs from build metadata")
const root = await mkdtemp(path.join(output, "smoke-"))
const env = isolatedEnvironment(root)
const registration = path.join(env.XDG_STATE_HOME, "opencode", "service-local.json")
const measurements: Array<{ phase: string; readyMs: number; pid: number; serviceID: string; executable: string }> = []
try {
  await Promise.all(
    [
      env.TEMP,
      env.APPDATA,
      env.LOCALAPPDATA,
      env.XDG_CONFIG_HOME,
      env.XDG_DATA_HOME,
      env.XDG_STATE_HOME,
      env.XDG_CACHE_HOME,
      env.OPENCODE_CONFIG_DIR,
    ].map((directory) => mkdir(directory, { recursive: true })),
  )
  await prepareIsolatedDatabaseDirectory(root)
  await Bun.write(path.join(env.OPENCODE_CONFIG_DIR, "config.json"), '{"update":"disable"}\n')
  if (cliVersion(await execute([binary, "--version"], root, env, 30_000)) !== metadata.version)
    throw new Error("Compiled version mismatch")
  await execute([binary, "--help"], root, env, 30_000)
  // Independent cold/warm service starts, not performance claims or live TUI coverage.
  for (const phase of ["cold", "warm"]) {
    if (await Bun.file(registration).exists()) throw new Error("Unexpected registration before spawn")
    const started = performance.now()
    const child = Bun.spawn([binary, "serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: root,
      env,
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await waitUntil(
        async () => {
          if (child.exitCode !== null) throw new Error(`Service exited before registration (${child.exitCode})`)
          return Bun.file(registration).exists()
        },
        60_000,
        "registration",
      )
      const info = assertRegistration(await Bun.file(registration).json(), child.pid, metadata.version)
      // Same semantic version is insufficient: check the OS image of our exact child PID before any HTTP or stop.
      const image = await execute(
        [
          "pwsh.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}').ExecutablePath`,
        ],
        root,
        env,
        15_000,
      )
      if (path.normalize(image).toLowerCase() !== path.normalize(binary).toLowerCase())
        throw new Error("Service executable identity mismatch")
      const headers = { authorization: `Basic ${btoa(`opencode:${info.password}`)}` }
      await waitUntil(
        async () => {
          const response = await loopbackRequest(new URL("/api/info", info.url), {
            headers,
            signal: AbortSignal.timeout(2_000),
          }).catch(() => undefined)
          if (!response?.ok) return false
          const body = await response.json()
          if (body.pid !== child.pid || body.version !== metadata.version)
            throw new Error("HTTP service identity mismatch")
          return true
        },
        60_000,
        "readiness",
      )
      measurements.push({
        phase,
        readyMs: performance.now() - started,
        pid: child.pid,
        serviceID: info.id,
        executable: image,
      })
      const unauthorized = await loopbackRequest(new URL("/api/info", info.url), { signal: AbortSignal.timeout(5_000) })
      if (unauthorized.status !== 401) throw new Error("Service permits unauthenticated access")
      const current = assertRegistration(await Bun.file(registration).json(), child.pid, metadata.version)
      if (current.id !== info.id || current.url !== info.url || current.password !== info.password)
        throw new Error("Service ownership changed; refusing stop")
      await execute([binary, "service", "stop"], root, env, 30_000)
      await waitUntil(async () => child.exitCode !== null, 15_000, "service exit")
      await waitUntil(async () => !(await Bun.file(registration).exists()), 5_000, "registration cleanup")
    } finally {
      // Only our still-owned process tree, including a possible in-flight ACL host.
      // Never kill by image name or discover a daily service.
      if (child.exitCode === null)
        await execute(["taskkill.exe", "/pid", String(child.pid), "/T", "/F"], root, env).catch(() => child.kill())
      await waitUntil(async () => child.exitCode !== null, 10_000, "owned process cleanup")
    }
  }
  if ((await sha256(binary)) !== metadata.binarySha256) throw new Error("Binary changed during smoke")
} finally {
  // Remove credentials and test databases even on failure; published evidence never contains passwords.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

await Bun.write(
  path.join(output, "smoke-result.json"),
  JSON.stringify(
    {
      buildID: metadata.id,
      binarySha256: metadata.binarySha256,
      version: metadata.version,
      channel,
      passed: true,
      measuredAt: new Date().toISOString(),
      measurements,
      limitations: [
        "No interactive TUI test",
        "Two samples only; not a benchmark",
        "No historical data migration test",
      ],
    },
    null,
    2,
  ) + "\n",
)
console.log(`Isolated smoke passed: ${metadata.id}`)

async function waitUntil(check: () => Promise<boolean>, timeout: number, label: string) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
