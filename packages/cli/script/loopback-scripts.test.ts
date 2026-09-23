import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { execute, isolatedEnvironment, prepareIsolatedDatabaseDirectory } from "./windows-runtime"

const candidate = process.env.OPENCODE_SMOKE_TEST_BUILD
const repo = path.resolve(import.meta.dir, "../../..")

for (const script of ["smoke-win.ts", "compiled-integration-win.ts", "diagnose-source-win.ts"]) {
  test.skipIf(process.platform !== "win32" || (script !== "diagnose-source-win.ts" && !candidate))(
    `real ${script} never sends its owned service auth to a parent proxy`,
    async () => {
      const parent = path.resolve(import.meta.dir, "../dist")
      await mkdir(parent, { recursive: true })
      const root = await mkdtemp(path.join(parent, "script-proxy-"))
      const requests: Array<{ path: string; auth: boolean }> = []
      const proxy = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          requests.push({ path: new URL(request.url).pathname, auth: request.headers.has("authorization") })
          return new Response("synthetic proxy trap", { status: 502 })
        },
      })
      try {
        const env = isolatedEnvironment(root)
        await mkdir(env.TEMP, { recursive: true })
        const url = `http://127.0.0.1:${proxy.port}`
        const args =
          script === "diagnose-source-win.ts"
            ? [repo, "serve", "--service", "--port", "0", "--print-logs"]
            : [path.resolve(candidate!)]
        const output = await execute(
          [process.execPath, path.join(import.meta.dir, script), ...args],
          path.resolve(import.meta.dir, ".."),
          {
            ...env,
            HTTP_PROXY: url,
            HTTPS_PROXY: url,
            ALL_PROXY: url,
            http_proxy: url,
            https_proxy: url,
            all_proxy: url,
            NO_PROXY: "",
            no_proxy: "",
          },
          180_000,
        )
        expect(output).toContain(script === "diagnose-source-win.ts" ? '"ready":true' : "passed:")
        expect(requests).toEqual([])
        if (script === "compiled-integration-win.ts") {
          expect(await Bun.file(path.join(candidate!, "integration-result.json")).json()).toMatchObject({
            mcp: true,
            databaseCopy: true,
            cleaned: true,
          })
        }
      } finally {
        await proxy.stop(true)
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    },
    200_000,
  )
}

test("related service CORS and web UI validation also stay direct in a proxy-poisoned test process", async () => {
  const parent = path.resolve(import.meta.dir, "../dist")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "suite-proxy-"))
  const requests: string[] = []
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname)
      return new Response("synthetic suite proxy trap", { status: 502 })
    },
  })
  try {
    const env = isolatedEnvironment(root)
    await mkdir(env.TEMP, { recursive: true })
    await prepareIsolatedDatabaseDirectory(root)
    const url = `http://127.0.0.1:${proxy.port}`
    await execute(
      [
        process.execPath,
        "test",
        "--timeout",
        "150000",
        "test/web-ui.test.ts",
        "test/service.test.ts",
        "test/standalone.test.ts",
        "--test-name-pattern",
        "web UI|managed service applies CORS|concurrent service processes elect|a failed service stays registered|standalone server exits",
      ],
      path.resolve(import.meta.dir, ".."),
      {
        ...env,
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        ALL_PROXY: url,
        NO_PROXY: "",
        no_proxy: "",
      },
      240_000,
    )
    expect(requests).toEqual([])
  } finally {
    await proxy.stop(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 260_000)
