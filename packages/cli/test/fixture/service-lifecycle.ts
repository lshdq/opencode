import { Service } from "@opencode/client/effect/service"
import { Schema } from "effect"

// The verified Windows source baseline takes 24–30s before registration, independently
// of the server's own bind/recognition deadlines. Keep startup and shutdown budgets separate.
export const startupTimeout = 60_000

export async function waitForInfo(file: string, owners: Bun.Subprocess[], timeout = startupTimeout) {
  const started = performance.now()
  while (performance.now() - started < timeout) {
    const value = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (value !== undefined) return Schema.decodeUnknownPromise(Service.Info)(value)
    if (owners.length && owners.every((owner) => owner.exitCode !== null)) break
    await Bun.sleep(50)
  }
  // Never include registration content, environment or subprocess output: these may contain credentials.
  throw new Error(
    `Service registration unavailable after ${Math.round(performance.now() - started)}ms (budget=${timeout}ms, file=${file}, owners=${owners.map((owner) => `${owner.pid}:${owner.exitCode ?? "running"}`).join(",")})`,
  )
}

export async function stopOwned(owner: Bun.Subprocess) {
  if (owner.exitCode === null) {
    if (process.platform === "win32") {
      const killer = Bun.spawn(["taskkill.exe", "/pid", String(owner.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      const timer = setTimeout(() => killer.kill(), 10_000)
      try {
        await killer.exited
      } finally {
        clearTimeout(timer)
      }
    }
    if (owner.exitCode === null) owner.kill("SIGKILL")
  }
  const exited = await Promise.race([owner.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!exited) throw new Error(`Owned service cleanup timed out: pid=${owner.pid}`)
}
