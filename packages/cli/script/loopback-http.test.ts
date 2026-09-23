import { expect, test } from "bun:test"
import { createServer } from "node:http"
import type { Socket } from "node:net"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import path from "node:path"
import ts from "typescript"
import { loopbackRequest } from "./loopback-http"
import { execute, isolatedEnvironment } from "./windows-runtime"

test.each([
  "https://127.0.0.1:1234",
  "http://outside.invalid:1234",
  "http://127.0.0.2:1234",
  "http://localhost.example:1234",
  "http://localhost",
  "http://127.0.0.1:0",
  "http://user:secret@127.0.0.1:1234",
  "http://[::1]:1234/#fragment",
])("rejects unsafe endpoint before connecting: %s", async (url) => {
  await expect(loopbackRequest(url)).rejects.toThrow()
})

test("rejects proxy/tunnel/header overrides and unbounded options", async () => {
  const url = "http://127.0.0.1:1234"
  await expect(loopbackRequest(url, { method: "CONNECT" })).rejects.toThrow()
  for (const name of ["host", "proxy-authorization", "proxy-connection"])
    await expect(loopbackRequest(url, { headers: { [name]: "fixture" } })).rejects.toThrow()
  for (const timeoutMs of [0, Infinity, 120_001]) await expect(loopbackRequest(url, { timeoutMs })).rejects.toThrow()
  for (const maxResponseBytes of [0, Infinity, 16 * 1024 * 1024 + 1])
    await expect(loopbackRequest(url, { maxResponseBytes })).rejects.toThrow()
  await expect(loopbackRequest(url, { body: new Uint8Array(16 * 1024 * 1024 + 1) })).rejects.toThrow()
})

test("parent proxy cannot intercept auth; RPC/status/headers/abort/limits release every socket", async () => {
  const parent = path.resolve(import.meta.dir, "../dist")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(path.join(parent, "loopback-http-"))
  const sockets = new Set<Socket>()
  const targetRequests: Array<{ route: string; auth?: string }> = []
  const proxyRequests: string[] = []
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      proxyRequests.push(request.headers.get("authorization") ?? "unauthenticated")
      return new Response("proxy trap")
    },
  })
  const target = createServer((request, response) => {
    const route = request.url ?? ""
    targetRequests.push({ route, auth: request.headers.authorization })
    response.setHeader("x-target", "owned")
    if (route === "/hang") return
    if (route === "/slow-body") {
      response.writeHead(200)
      response.write("prefix")
      return
    }
    if (route === "/large") {
      response.writeHead(200, { "content-length": "100000" })
      response.end()
      return
    }
    if (route === "/large-head") {
      response.writeHead(200, { "content-length": "100000" })
      response.end()
      return
    }
    if (route === "/chunked") {
      response.writeHead(200)
      response.write(Buffer.alloc(128))
      response.end()
      return
    }
    if (route === "/truncated") {
      response.writeHead(200, { "content-length": "1000" })
      response.write("prefix")
      setTimeout(() => response.destroy(), 25)
      return
    }
    if (route === "/unauthorized") {
      response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' })
      response.end("denied")
      return
    }
    if (route === "/failed") {
      response.writeHead(500)
      response.end('{"error":"fixture"}')
      return
    }
    if (route === "/redirect") {
      response.writeHead(302, { location: "http://outside.invalid:1234/" })
      response.end()
      return
    }
    if (route === "/empty") {
      response.writeHead(204)
      response.end()
      return
    }
    if (route === "/cors") {
      response.writeHead(204, { "access-control-allow-origin": request.headers.origin ?? "" })
      response.end()
      return
    }
    const chunks: Uint8Array[] = []
    request.on("data", (chunk: Uint8Array) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks)
      if (route === "/binary") {
        response.end(body)
        return
      }
      response.writeHead(route === "/rpc" ? 201 : 200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({ auth: request.headers.authorization, body: body.length ? JSON.parse(body.toString()) : null }),
      )
    })
  })
  target.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      target.once("error", reject)
      target.listen(0, "127.0.0.1", resolve)
    })
    const address = target.address()
    if (!address || typeof address === "string") throw new Error("No target port")
    const env = isolatedEnvironment(root)
    await mkdir(env.TEMP, { recursive: true })
    const proxyURL = `http://127.0.0.1:${proxy.port}`
    const output = await execute(
      [process.execPath, path.join(import.meta.dir, "fixture/loopback-client.ts"), `http://127.0.0.1:${address.port}`],
      root,
      {
        ...env,
        HTTP_PROXY: proxyURL,
        HTTPS_PROXY: proxyURL,
        ALL_PROXY: proxyURL,
        http_proxy: proxyURL,
        https_proxy: proxyURL,
        NO_PROXY: "",
        no_proxy: "",
      },
      30_000,
    )
    expect(output).toContain("loopback transport assertions passed")
    expect(proxyRequests).toEqual([])
    expect(targetRequests.some((request) => request.auth === "Basic synthetic-loopback-only")).toBe(true)
    expect(targetRequests.some((request) => request.route === "/must-not-run")).toBe(false)
    for (let attempt = 0; attempt < 100 && sockets.size; attempt++) await Bun.sleep(10)
    expect(sockets.size).toBe(0)
  } finally {
    sockets.forEach((socket) => socket.destroy())
    await new Promise<void>((resolve) => target.close(() => resolve()))
    await proxy.stop(true)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 45_000)

test("explicit IPv6 loopback is supported without DNS", async () => {
  const target = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ipv6") })
  try {
    expect(await (await loopbackRequest(`http://[::1]:${target.port}`)).text()).toBe("ipv6")
  } finally {
    await target.stop(true)
  }
})

test("all authenticated validation scripts use the shared boundary rather than global fetch", async () => {
  for (const file of [
    "smoke-win.ts",
    "compiled-integration-win.ts",
    "diagnose-source-win.ts",
    "service-smoke.ts",
    "../test/service.test.ts",
    "../test/web-ui.test.ts",
    "../test/fixture/standalone-owner.ts",
  ]) {
    const code = await readFile(path.join(import.meta.dir, file), "utf8")
    expect(code).toContain("import { loopbackRequest }")
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
    const calls: string[] = []
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === "fetch") ||
          (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "fetch"))
      )
        calls.push(node.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(calls).toEqual([])
  }
})
