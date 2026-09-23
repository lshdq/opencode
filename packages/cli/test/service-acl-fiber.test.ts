import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ServiceConfig } from "../src/services/service-config"
import { interruptDuringACL } from "../../util/test/fixture/file-mode-fiber"

test.skipIf(process.platform !== "win32")("ServiceConfig Fiber.interrupt joins ACL close and retry retains a complete password", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-service-fiber-"))
  const operation = ServiceConfig.password("fixture-after-retry").pipe(
    Effect.provideService(Global.Service, Global.make({ home: root, data: root, config: root, state: root, cache: root, tmp: root, bin: root, log: root, repos: root })),
    Effect.provide(NodeFileSystem.layer),
  )
  try {
    await interruptDuringACL(root, operation)
    await expect(stat(path.join(root, ServiceConfig.filename()))).rejects.toThrow()
    await Effect.runPromise(operation)
    expect(JSON.parse(await readFile(path.join(root, ServiceConfig.filename()), "utf8")).password).toBe("fixture-after-retry")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

for (const kind of ["config", "registration"] as const) {
  test.skipIf(process.platform !== "win32")(`${kind} migration interruption during private creation reaps host and removes its owned temp directory`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opencode-migration-create-interrupt-"))
    const source = path.join(root, "legacy.json")
    const target = path.join(root, "target.json")
    const content = JSON.stringify(kind === "config"
      ? { password: "legacy-fixture", port: 4321 }
      : { id: "fixture", version: "fixture-version", url: "http://127.0.0.1:4321", pid: 42, password: "legacy-fixture" })
    const operation = (kind === "config"
      ? ServiceConfig.migrateConfig(source, target)
      : ServiceConfig.migrateRegistration(source, target, "preview", "fixture-version")
    ).pipe(Effect.provide(NodeFileSystem.layer))
    try {
      await writeFile(source, content)
      await interruptDuringACL(root, operation, (variables) => variables.OPENCODE_ACL_PATH?.endsWith(path.sep + "content") === true)
      await expect(stat(target)).rejects.toThrow()
      expect((await readdir(root)).some((file) => file.startsWith(".migration-"))).toBe(false)
      expect(await readFile(source, "utf8")).toBe(content)
      await Effect.runPromise(operation)
      expect(await readFile(target, "utf8")).toBe(content)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
