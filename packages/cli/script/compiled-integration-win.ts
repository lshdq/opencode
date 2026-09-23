// TC-013/015/017: run with an explicit build directory; never discovers a daily service.
import assert from "node:assert/strict"
import { Database } from "bun:sqlite"
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { Mcp } from "@opencode/schema/mcp"
import { Schema } from "effect"
import { loopbackRequest } from "./loopback-http"
import {
  assertRegistration,
  execute,
  isolatedEnvironment,
  prepareIsolatedDatabaseDirectory,
  sha256,
  upstream,
} from "./windows-runtime"
import { stopOwned, waitForInfo } from "../test/fixture/service-lifecycle"

if (process.platform !== "win32" || !process.argv[2])
  throw new Error("Usage on Windows: bun <absolute compiled-integration-win.ts> <build-directory>")
const output = await realpath(process.argv[2])
const metadata = await Bun.file(path.join(output, "build-metadata.json")).json()
assert.equal(metadata.upstream, upstream)
assert.equal(metadata.channel, "local")
assert.equal(metadata.version, "2.0.12")
const binary = await realpath(path.join(output, "compiled/cli-windows-x64/bin/opencode.exe"))
assert.equal(await sha256(binary), metadata.binarySha256)
assert.equal(await sha256(process.execPath), metadata.bunSha256)
assert.equal(await sha256(path.resolve(import.meta.dir, "../../../bun.lock")), metadata.lockSha256)
assert.equal(await sha256(path.join(output, "source.diff")), metadata.diffSha256)
const root = await mkdtemp(path.join(output, "integration-"))
const env = isolatedEnvironment(root)
const registration = path.join(env.XDG_STATE_HOME, "opencode/service-local.json")
const sample = {
  buildID: metadata.id,
  binarySha256: metadata.binarySha256,
  mcp: false,
  databaseCopy: false,
  cleaned: false,
}
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
    ].map((dir) => mkdir(dir, { recursive: true })),
  )
  const databaseDirectory = await prepareIsolatedDatabaseDirectory(root)

  // Build a synthetic baseline fixture from the fixed official generated DDL, not from live data.
  // This tests copy/open/data preservation, not arbitrary historical migrations or rollback of live sessions.
  const repo = path.resolve(import.meta.dir, "../../..")
  const schema = await execute(["git", "show", `${upstream}:packages/core/src/database/schema.gen.ts`], repo)
  const journal = await execute(["git", "show", `${upstream}:packages/core/src/database/migration.gen.ts`], repo)
  const statements = [...schema.matchAll(/tx\.run\(\s*`((?:\\.|[^`])*)`\s*,?\s*\)/g)].map((match) =>
    match[1].replaceAll("\\`", "`"),
  )
  assert.equal(statements.length, [...schema.matchAll(/tx\.run\(/g)].length)
  assert.ok(statements.length > 20)
  assert.ok(statements.every((sql) => !sql.includes("${")))
  const ids = [...journal.matchAll(/from "\.\/migration\/(.+)\.js"/g)].map((match) => match[1])
  assert.equal(ids.length, 47)
  const baseline = path.join(databaseDirectory, "official-base.db")
  const db = new Database(baseline)
  try {
    db.transaction(() => {
      statements.forEach((sql) => db.run(sql))
      db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
      ids.forEach((id) => db.run("INSERT INTO migration VALUES (?, ?)", [id, 1]))
      db.run("INSERT INTO kv VALUES (?, ?, ?, ?)", ["test-copy-sentinel", JSON.stringify({ fixture: true }), 1, 1])
    })()
  } finally {
    db.close()
  }
  const before = await sha256(baseline)
  await copyFile(baseline, env.OPENCODE_DB)
  const child = Bun.spawn([binary, "serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: root,
    env,
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    const info = assertRegistration(await waitForInfo(registration, [child]), child.pid, metadata.version)
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
    assert.equal(path.normalize(image).toLowerCase(), binary.toLowerCase())
    const headers = { authorization: `Basic ${btoa(`opencode:${info.password}`)}`, "content-type": "application/json" }
    async function request(route: string, method = "GET", body?: unknown) {
      const url = new URL(route, info.url)
      url.searchParams.set("location[directory]", root)
      return loopbackRequest(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
        timeoutMs: 60_000,
      })
    }
    const ready = await request("/api/info")
    assert.equal(ready.status, 200)
    assert.equal((await ready.json()).pid, child.pid)
    const pidfile = path.join(root, "mcp.pid")
    const add = await request("/api/experimental/mcp/compiled-fixture", "PUT", {
      config: {
        type: "local",
        command: [process.execPath, path.resolve(import.meta.dir, "../test/fixture/compiled-mcp.cjs"), pidfile],
        timeout: { startup: 20_000 },
      },
    })
    assert.equal(add.status, 204, `MCP add: ${await add.text()}`)
    // Add is asynchronous: pending is a valid intermediate state, not a bundle failure.
    async function connected() {
      const deadline = performance.now() + 30_000
      while (performance.now() < deadline) {
        const list = await request("/api/mcp")
        assert.equal(list.status, 200)
        const servers = Schema.decodeUnknownSync(Schema.Array(Mcp.Server))((await list.json()).data)
        const server = servers.find((server) => server.name === "compiled-fixture")
        assert.ok(server, "Fixture missing from MCP catalog")
        assert.notEqual(server.status.status, "failed", `MCP failed: ${JSON.stringify(server.status)}`)
        if (server.status.status === "connected") return
        await Bun.sleep(100)
      }
      throw new Error("MCP remained pending for 30s")
    }
    await connected()
    const pid = Number(await Bun.file(pidfile).text())
    assert.ok(Number.isSafeInteger(pid) && pid > 0)
    assert.doesNotThrow(() => process.kill(pid, 0))
    assert.equal((await request("/api/experimental/mcp/compiled-fixture", "DELETE")).status, 204)
    const deadline = performance.now() + 10_000
    while (performance.now() < deadline) {
      const alive = await execute(
        [
          "pwsh.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `@(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Count`,
        ],
        root,
        env,
        5_000,
      )
      if (alive === "0") break
      await Bun.sleep(100)
    }
    assert.throws(() => process.kill(pid, 0), "Removed MCP process survived")
    sample.mcp = true
    const current = assertRegistration(await Bun.file(registration).json(), child.pid, metadata.version)
    assert.deepEqual(current, info)
    await execute([binary, "service", "stop"], root, env, 30_000)
    assert.equal(await Promise.race([child.exited.then(() => true), Bun.sleep(15_000).then(() => false)]), true)
    assert.equal(await Bun.file(registration).exists(), false)
  } finally {
    await stopOwned(child)
  }
  const reopened = new Database(env.OPENCODE_DB, { readonly: true })
  try {
    assert.deepEqual(reopened.query("SELECT value FROM kv WHERE key = 'test-copy-sentinel'").get(), {
      value: '{"fixture":true}',
    })
    assert.deepEqual(reopened.query("PRAGMA integrity_check").get(), { integrity_check: "ok" })
    assert.deepEqual(reopened.query("SELECT count(*) AS total FROM migration").get(), { total: ids.length })
  } finally {
    reopened.close()
  }
  assert.equal(await sha256(baseline), before, "Read-only baseline copy changed")
  // Rollback means restoring the untouched offline snapshot, not downgrading the migrated live DB.
  await copyFile(baseline, path.join(databaseDirectory, "restored.db"))
  assert.equal(await sha256(path.join(databaseDirectory, "restored.db")), before)
  sample.databaseCopy = true
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  sample.cleaned = !(await Bun.file(path.join(env.XDG_DATA_HOME, "official-base.db")).exists())
  await Bun.write(path.join(output, "integration-result.json"), JSON.stringify(sample, null, 2) + "\n")
}
assert.equal(await sha256(binary), metadata.binarySha256)
console.log(`Compiled MCP and synthetic official-base database copy passed: ${metadata.id}`)
