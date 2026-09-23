import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { serviceSmokeEnvironment } from "./service-smoke"
import { execute, isolatedEnvironment, prepareIsolatedDatabaseDirectory } from "./windows-runtime"

test("service smoke retains only portable execution keys and its own explicit config roots", () => {
  const root = path.join(os.tmpdir(), "smoke-owned")
  const inherited = {
    PATH: "trusted-path",
    SystemRoot: "trusted-system",
    LANG: "en_US.UTF-8",
    CI: "true",
    OPENCODE_CONFIG_DIR: "bait",
    opencode_config: "bait",
    OPENCODE_SERVER: "bait",
    OPENCODE_SERVER_PASSWORD: "bait",
    OPENCODE_PASSWORD: "bait",
    OPENCODE_DB: "bait",
    OPENCODE_CONFIG_CONTENT: "bait",
    OPENCODE_CONFIG_PROJECT_DISABLE: "false",
    OPENCODE_FILEWATCHER_DISABLE: "true",
    OPENCODE_PTY_HANDOFF: "bait",
    OPENCODE_FUTURE_OVERRIDE: "bait",
    XDG_CONFIG_DIRS: "bait",
    XDG_RUNTIME_DIR: "bait",
    NODE_OPTIONS: "bait",
    BUN_INSPECT: "bait",
    OPENAI_API_KEY: "bait",
    ANTHROPIC_AUTH_TOKEN: "bait",
    AWS_SESSION_TOKEN: "bait",
    GITHUB_TOKEN: "bait",
    SSH_AUTH_SOCK: "bait",
    HTTP_PROXY: "bait",
    HTTPS_PROXY: "bait",
    ALL_PROXY: "bait",
    OTEL_EXPORTER_OTLP_ENDPOINT: "bait",
    OTEL_EXPORTER_OTLP_HEADERS: "bait",
    UNKNOWN_FUTURE_SECRET: "bait",
  }
  const env = serviceSmokeEnvironment(root, inherited)
  expect(Object.values(env)).not.toContain("bait")
  expect(env).toMatchObject({ PATH: "trusted-path", SystemRoot: "trusted-system", LANG: "en_US.UTF-8", CI: "true" })
  expect(env.OPENCODE_CONFIG_DIR).toBe(path.join(root, ".opencode"))
  expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("true")
  expect(env.OPENCODE_DB).toBe(path.join(root, "data", "smoke.db"))
  expect(env.TEMP).toBe(path.join(root, "tmp"))
  expect(env.PWD).toBe(root)
  expect(env).not.toHaveProperty("OPENCODE_FILEWATCHER_DISABLE")
  // The newer Windows smoke still uses its original explicit config location and disables ancestor scanning.
  expect(isolatedEnvironment(root, inherited).OPENCODE_CONFIG_DIR).toBe(path.join(root, "config", "opencode"))
})

test("real CLI config reads stay in the owned root and leave outside bait bytes and ACL unchanged", async () => {
  const fixture = await bait()
  const root = path.join(fixture.root, "owned")
  const env = serviceSmokeEnvironment(root, fixture.env)
  try {
    await mkdir(env.TEMP, { recursive: true })
    await mkdir(env.OPENCODE_CONFIG_DIR, { recursive: true })
    await prepareIsolatedDatabaseDirectory(root)
    const own = path.join(env.OPENCODE_CONFIG_DIR, "service-local.json")
    await writeFile(own, JSON.stringify({ hostname: "127.0.0.1", password: "owned-fixture-only" }))
    const value = await execute(
      [process.execPath, path.resolve(import.meta.dir, "../src/index.ts"), "service", "get", "hostname"],
      path.resolve(import.meta.dir, ".."),
      env,
      90_000,
    )
    expect(value).toBe("127.0.0.1")
    if (process.platform === "win32") {
      const { acl } = await import("../../util/test/fixture/file-acl")
      expect((await acl(own)).protected).toBe(true)
    }
  } finally {
    try {
      expect(await snapshot(fixture.outside)).toEqual(fixture.before)
      expect(fixture.requests.length).toBe(0)
    } finally {
      await fixture.listener.stop(true)
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
}, 120_000)

test.skipIf(!process.env.OPENCODE_SMOKE_TEST_BINARY)(
  "compiled service smoke preserves watcher/auth/election checks with poisoned parent env",
  async () => {
    const fixture = await bait()
    try {
      const binary = process.env.OPENCODE_SMOKE_TEST_BINARY
      if (!binary) throw new Error("Missing explicit compiled candidate")
      // Execute the same exported implementation in a fresh harness process, including poisoned proxy env.
      const program = `const { runServiceSmoke } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "service-smoke.ts")).href)}); console.log(JSON.stringify(await runServiceSmoke(process.argv[1])))`
      const output = await execute([process.execPath, "-e", program, binary], fixture.root, fixture.env, 120_000)
      const value = JSON.parse(output)
      expect(value.pid).toBeGreaterThan(0)
      expect(value.port).toBeGreaterThan(0)
      expect(value.config).toBe(path.join(value.root, ".opencode", path.basename(value.registration)))
      expect(value.registration.startsWith(path.join(value.root, "state") + path.sep)).toBe(true)
      await expect(lstat(value.root)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      try {
        expect(await snapshot(fixture.outside)).toEqual(fixture.before)
        expect(fixture.requests.length).toBe(0)
      } finally {
        await fixture.listener.stop(true)
        await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  },
  150_000,
)

test("failed smoke contenders clean their owned root without touching poisoned config or endpoints", async () => {
  const fixture = await bait()
  try {
    // Bun itself is not a compiled CLI: both contenders fail before publishing a registration.
    // A fresh harness keeps os.tmpdir() and any cleanup observation inside this fixture.
    const program = `
      const { runServiceSmoke } = await import(${JSON.stringify(pathToFileURL(path.join(import.meta.dir, "service-smoke.ts")).href)})
      const { readdir } = await import("node:fs/promises")
      const failure = await runServiceSmoke(process.execPath).then(() => null, (error) => ({ message: String(error), cause: String(error.cause) }))
      const remaining = (await readdir(process.env.TEMP)).filter((name) => name.startsWith("opencode-service-smoke-"))
      console.log(JSON.stringify({ failure, remaining }))
    `
    const output = await execute([process.execPath, "-e", program], fixture.root, fixture.env, 90_000)
    const value = JSON.parse(output)
    expect(value.failure.message).toContain("serve")
    expect(value.failure.cause).toBe("Error: Compiled service did not publish registration")
    expect(value.remaining).toEqual([])
  } finally {
    try {
      expect(await snapshot(fixture.outside)).toEqual(fixture.before)
      expect(fixture.requests.length).toBe(0)
    } finally {
      await fixture.listener.stop(true)
      await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }
}, 120_000)

async function bait() {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-smoke-bait-"))
  const outside = path.join(root, "outside")
  await mkdir(outside)
  await mkdir(path.join(root, "tmp"))
  await Promise.all([
    writeFile(
      path.join(outside, "service-local.json"),
      JSON.stringify({ hostname: "outside.invalid", password: "bait-only" }),
    ),
    writeFile(
      path.join(outside, "service.json"),
      JSON.stringify({ hostname: "outside.invalid", password: "bait-only" }),
    ),
    writeFile(path.join(outside, "config.json"), '{"update":"disable"}'),
    writeFile(path.join(outside, "database"), "untouched-bait-database"),
  ])
  if (process.platform === "win32") {
    const { grantEveryone } = await import("../../util/test/fixture/file-acl")
    await grantEveryone(path.join(outside, "service-local.json"))
    await grantEveryone(path.join(outside, "service.json"))
  }
  const requests: string[] = []
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return new Response("bait-only", { status: 503 })
    },
  })
  const url = `http://127.0.0.1:${listener.port}`
  return {
    root,
    outside,
    listener,
    requests,
    before: await snapshot(outside),
    env: {
      ...process.env,
      TEMP: path.join(root, "tmp"),
      TMP: path.join(root, "tmp"),
      TMPDIR: path.join(root, "tmp"),
      // Bun selects its own source cache before executing the harness under test.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "tmp", "harness-transpiler"),
      OPENCODE_CONFIG_DIR: outside,
      OPENCODE_CONFIG: path.join(outside, "config.json"),
      OPENCODE_CONFIG_CONTENT: "invalid-bait-config",
      OPENCODE_CLI_CONFIG_CONTENT: "invalid-bait-config",
      OPENCODE_DB: path.join(outside, "database"),
      OPENCODE_SERVER: url,
      OPENCODE_PASSWORD: "bait-only",
      OPENCODE_SERVER_PASSWORD: "bait-only",
      OPENCODE_FILEWATCHER_DISABLE: "true",
      OPENCODE_CONFIG_PROJECT_DISABLE: "false",
      XDG_CONFIG_HOME: outside,
      XDG_DATA_HOME: outside,
      XDG_STATE_HOME: outside,
      XDG_CACHE_HOME: outside,
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      ALL_PROXY: url,
      OTEL_EXPORTER_OTLP_ENDPOINT: url,
      OTEL_EXPORTER_OTLP_HEADERS: "bait-only",
      OPENAI_API_KEY: "bait-only",
    },
  }
}

async function snapshot(directory: string) {
  return Promise.all(
    ["", ...(await readdir(directory, { recursive: true })).sort()].map(async (entry) => {
      const file = path.join(directory, entry)
      const info = await lstat(file)
      const security =
        process.platform === "win32"
          ? await (async () => {
              const { FileModeWindows } = await import("@opencode/util/file-mode-windows")
              const security = await execute(
                [
                  FileModeWindows.command(),
                  "-NoProfile",
                  "-NonInteractive",
                  "-Command",
                  `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PSModulePath = $PSHOME + '\\Modules'
$item = Get-Item -LiteralPath $env:SMOKE_BAIT_PATH -Force
$acl = if ($PSVersionTable.PSEdition -eq 'Core') { [System.IO.FileSystemAclExtensions]::GetAccessControl($item) } else { $item.GetAccessControl() }
[Console]::Out.Write($acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All))
`,
                ],
                path.dirname(directory),
                {
                  SystemRoot: process.env.SystemRoot,
                  TEMP: process.env.TEMP,
                  SMOKE_BAIT_PATH: file,
                },
                10_000,
              )
              if (!security.includes("D:")) throw new Error("ACL probe returned no DACL")
              return security
            })()
          : String(info.mode)
      return {
        entry,
        security,
        hash: info.isFile()
          ? createHash("sha256")
              .update(await readFile(file))
              .digest("hex")
          : null,
      }
    }),
  )
}
