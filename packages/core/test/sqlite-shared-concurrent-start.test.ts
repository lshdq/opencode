import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

// Two CLI processes with separate HOME directories but one shared XDG
// data/state root (shared SQLite database and Flock locks) must both start and
// serve. The schema bootstrap race resolves through WAL + busy_timeout retries
// on the shared database file.

function userEnv(root: string, user: string) {
  const home = path.join(root, user)
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ["path", "systemroot", "windir", "comspec", "pathext", "systemdrive"].includes(key.toLowerCase()),
    )),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "appdata"),
    LOCALAPPDATA: path.join(home, "localappdata"),
    TEMP: path.join(home, "temp"),
    TMP: path.join(home, "temp"),
    OPENCODE_TEST_HOME: home,
    XDG_DATA_HOME: path.join(root, "shared-data"),
    XDG_CONFIG_HOME: path.join(root, "shared-config"),
    XDG_CACHE_HOME: path.join(root, "shared-cache"),
    XDG_STATE_HOME: path.join(root, "shared-state"),
    OPENCODE_CONFIG_DIR: path.join(root, "shared-config", "opencode"),
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_CHANNEL_DB: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    OPENCODE_SERVER_PASSWORD: "shared-fixture-only",
  }
}

async function startServe(root: string, user: string) {
  const child = Bun.spawn([
    process.execPath,
    "--preload", Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, "../../cli")),
    path.join(import.meta.dir, "../../cli/src/index.ts"),
    "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0",
  ], { cwd: root, env: userEnv(root, user), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const output = { text: "" }
  const stdout = (async () => {
    for await (const chunk of child.stdout) output.text += new TextDecoder().decode(chunk)
  })()
  const stderr = new Response(child.stderr).text()
  const deadline = Date.now() + 60_000
  while (!output.text.includes('"url":') && child.exitCode === null && Date.now() < deadline) await Bun.sleep(25)
  return { child, output, stdout, stderr }
}

test("two processes sharing one data root start and serve concurrently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-shared-start-"))
  const processes = await Promise.all([startServe(root, "user-a"), startServe(root, "user-b")])
  try {
    const urls: string[] = []
    for (const { child, output, stderr } of processes) {
      expect(child.exitCode, child.exitCode === null ? "server exited before ready" : await stderr).toBe(null)
      const line = output.text.split(/\r?\n/).find((line) => line.startsWith('{"url":'))
      expect(line, "no ready URL").toBeDefined()
      const address = JSON.parse(line ?? "{}") as { url: string }
      urls.push(address.url)
      const response = await fetch(new URL("/api/info", address.url), {
        headers: { authorization: "Basic " + btoa("opencode:shared-fixture-only") },
        signal: AbortSignal.timeout(5000),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ pid: child.pid })
    }
    // Port 0 hands each process its own listener.
    expect(new Set(urls).size).toBe(2)
    // Both processes opened the same shared database file.
    expect(await readdir(path.join(root, "shared-data", "opencode"))).toContain("opencode.db")
    for (const { child } of processes) child.stdin.end()
    for (const { child } of processes)
      expect(await Promise.race([child.exited, Bun.sleep(10_000).then(() => "shutdown-timeout")])).toBe(0)
  } finally {
    for (const { child } of processes) {
      if (child.exitCode !== null) continue
      if (process.platform === "win32") {
        const killer = Bun.spawn(["taskkill.exe", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
        await killer.exited
      }
      child.kill()
      await child.exited
    }
    await Promise.all(processes.map((process) => Promise.all([process.stdout, process.stderr])))
    await rm(root, { recursive: true, force: true })
  }
}, 150_000)
