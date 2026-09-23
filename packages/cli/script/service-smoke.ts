#!/usr/bin/env bun

import { NodeFileSystem } from "@effect/platform-node"
import { Service } from "@opencode/client/effect/service"
import { ServerInfo } from "@opencode/protocol/groups/server"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execute, isolatedEnvironment, prepareIsolatedDatabaseDirectory } from "./windows-runtime"
import { loopbackRequest } from "./loopback-http"

export function serviceSmokeEnvironment(root: string, inherited = process.env) {
  return {
    ...isolatedEnvironment(root, inherited),
    // Keep the original plugin fixture path without enabling the unbounded ancestor config walk.
    OPENCODE_CONFIG_DIR: path.join(root, ".opencode"),
  }
}

export async function runServiceSmoke(binary: string, inherited = process.env) {
  const executable = await fs.realpath(binary)
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-smoke-")))
  const env = serviceSmokeEnvironment(root, inherited)
  const processes: Array<ReturnType<typeof Bun.spawn>> = []
  const errors: Array<Promise<string>> = []
  const observed = { root, registration: "", config: "", pid: 0, port: 0 }
  let failure: unknown
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
      ].map((directory) => fs.mkdir(directory, { recursive: true })),
    )
    await prepareIsolatedDatabaseDirectory(root)
    await fs.mkdir(path.join(root, ".opencode", "plugins"), { recursive: true })
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })
    const port = reservation.port
    await reservation.stop(true)
    if (port === undefined) throw new Error("Could not reserve a smoke port")
    spawnService(port)
    spawnService(port)
    const registration = await waitForRegistration()
    const info = await Schema.decodeUnknownPromise(Service.Info)(await Bun.file(registration).json())
    if (info.id === undefined || info.password === undefined || info.version === undefined)
      throw new Error("Registration is missing service identity")
    const winner = processes.find((process) => process.pid === info.pid)
    const loser = processes.find((process) => process.pid !== info.pid)
    if (!winner || !loser) throw new Error("Compiled contenders did not elect one registered owner")
    const endpoint = new URL(info.url)
    if (
      endpoint.protocol !== "http:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.port !== String(port) ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error("Registration is not the owned loopback endpoint")
    const config = path.join(env.OPENCODE_CONFIG_DIR, path.basename(registration))
    if ((await Bun.file(config).json()).password !== info.password)
      throw new Error("Service credential was not written to the isolated configuration")
    Object.assign(observed, { registration, config, pid: info.pid, port })
    const credential = btoa(`opencode:${info.password}`)
    const headers = { authorization: "Basic " + credential }
    const token = encodeURIComponent(credential)
    const serverInfo = await waitForReady(info.url, headers)
    if (serverInfo.pid !== info.pid || serverInfo.version !== info.version)
      throw new Error("Server info does not match registration")
    const tokenInfo = await loopbackRequest(new URL(`/api/info?auth_token=${token}`, info.url), {
      signal: AbortSignal.timeout(5_000),
    })
    if (tokenInfo.status !== 200) throw new Error("Compiled service rejected query authentication")
    const tokenOpenApi = await loopbackRequest(new URL(`/openapi.json?auth_token=${token}`, info.url), {
      signal: AbortSignal.timeout(5_000),
    })
    if (tokenOpenApi.status !== 200) throw new Error("Compiled application rejected query authentication")
    if ((await pluginIDs(info.url, headers)).includes("smoke")) throw new Error("Smoke plugin existed before creation")
    const plugin = path.join(root, ".opencode", "plugins", "smoke.ts")
    await fs.writeFile(plugin, pluginSource())
    await waitForPlugin(info.url, headers, plugin)

    const unauthorizedInfo = await loopbackRequest(new URL("/api/info", info.url), {
      signal: AbortSignal.timeout(5_000),
    })
    if (unauthorizedInfo.status !== 401) throw new Error("Compiled service exposed info without authentication")
    const unauthorizedOpenApi = await loopbackRequest(new URL("/openapi.json", info.url), {
      signal: AbortSignal.timeout(5_000),
    })
    if (unauthorizedOpenApi.status !== 401)
      throw new Error("Compiled service exposed application routes without authentication")
    const stopRoute = await loopbackRequest(new URL("/api/service/stop", info.url), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ instanceID: info.id }),
      signal: AbortSignal.timeout(5_000),
    })
    if (stopRoute.status !== 404) throw new Error("Compiled service exposed the removed HTTP stop route")
    if (!(await exitsWithin(loser, 10_000))) throw new Error("Losing compiled contender did not exit")
    if (loser.exitCode !== 0) throw new Error("Losing compiled contender failed instead of yielding ownership")

    const current = await Schema.decodeUnknownPromise(Service.Info)(await Bun.file(registration).json())
    if (
      current.id !== info.id ||
      current.pid !== info.pid ||
      current.url !== info.url ||
      current.password !== info.password
    )
      throw new Error("Smoke service ownership changed; refusing stop")
    await Effect.runPromise(Service.stop({ file: registration }).pipe(Effect.provide(NodeFileSystem.layer)))
    if (!(await exitsWithin(winner, 10_000))) throw new Error("Compiled service did not stop")
    for (let attempt = 0; attempt < 200 && (await Bun.file(registration).exists()); attempt++) await Bun.sleep(25)
    if (await Bun.file(registration).exists()) throw new Error("Compiled service registration was not removed")
  } catch (cause) {
    failure = cause
  } finally {
    await Promise.all(
      processes.map(async (child) => {
        if (child.exitCode !== null) return
        if (process.platform === "win32")
          await execute(["taskkill.exe", "/pid", String(child.pid), "/T", "/F"], root, env, 10_000).catch(() =>
            child.kill(),
          )
        else child.kill()
        if (!(await exitsWithin(child, 10_000))) throw new Error("Owned smoke process did not exit")
      }),
    ).catch((cause: unknown) => {
      failure ??= cause
    })
    if (failure)
      errors.push(fs.readFile(path.join(root, "data", "opencode", "log", "opencode.log"), "utf8").catch(() => ""))
  }

  const output = await Promise.all(errors)
  // Windows can retain directory handles briefly after the service processes exit.
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch((cause: unknown) => {
    console.error("Failed to remove service smoke-test directory", cause)
    failure ??= cause
  })
  if (failure)
    throw new Error(output.filter(Boolean).join("\n") || "Compiled service lifecycle smoke test failed", {
      cause: failure,
    })
  return observed

  function spawnService(port: number) {
    const process = Bun.spawn([executable, "serve", "--service", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: root,
      env,
      stdout: "ignore",
      stderr: "pipe",
    })
    processes.push(process)
    errors.push(new Response(process.stderr).text())
  }

  async function waitForRegistration() {
    const directory = path.join(root, "state", "opencode")
    for (let attempt = 0; attempt < 400; attempt++) {
      const files = await fs.readdir(directory).catch(() => [])
      const file = files.find(
        (file) => file === "service.json" || (file.startsWith("service-") && file.endsWith(".json")),
      )
      if (file) return path.join(directory, file)
      await Bun.sleep(25)
    }
    throw new Error("Compiled service did not publish registration")
  }

  async function pluginIDs(url: string, headers: HeadersInit) {
    const endpoint = new URL("/api/plugin", url)
    endpoint.searchParams.set("location[directory]", root)
    const response = await loopbackRequest(endpoint, { headers, signal: AbortSignal.timeout(5_000) })
    const body: unknown = await response.json()
    if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data))
      throw new Error("Compiled service returned an invalid plugin list")
    return body.data.flatMap((plugin) =>
      typeof plugin === "object" && plugin !== null && "id" in plugin && typeof plugin.id === "string"
        ? [plugin.id]
        : [],
    )
  }

  async function waitForPlugin(url: string, headers: HeadersInit, plugin: string) {
    const deadline = Date.now() + 10_000
    let attempt = 0
    while (Date.now() < deadline) {
      if ((await pluginIDs(url, headers)).includes("smoke")) return
      await Bun.sleep(25)
      // Native watchers may coalesce a single creation edge. Keep changing valid source so
      // the smoke proves that a later native event is delivered.
      if (++attempt % 10 === 0) await fs.writeFile(plugin, `${pluginSource()}// watcher retry ${attempt}\n`)
    }
    throw new Error("Compiled service did not discover the created plugin")
  }
}

async function waitForReady(url: string, headers: HeadersInit) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const response = await loopbackRequest(new URL("/api/info", url), {
      headers,
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined)
    if (response?.ok) return Schema.decodeUnknownPromise(ServerInfo)(await response.json())
    await Bun.sleep(25)
  }
  throw new Error("Compiled service did not become ready")
}

function exitsWithin(process: Bun.Subprocess, milliseconds: number) {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), milliseconds)
    process.exited.then(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

function pluginSource() {
  return 'export default { id: "smoke", setup: async () => {} }\n'
}

if (import.meta.main) {
  const nodeBuild = process.argv.includes("--node")
  const target = `cli${nodeBuild ? "-node" : ""}-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  const directory = path.join(import.meta.dir, "..", "dist", ...(nodeBuild ? ["node"] : []), target, "bin")
  const binary = path.join(
    directory,
    `${nodeBuild ? "opencode2-node" : "opencode"}${process.platform === "win32" ? ".exe" : ""}`,
  )
  if (!(await Bun.file(binary).exists())) throw new Error(`Missing compiled CLI in ${directory}`)
  await runServiceSmoke(binary)
}
