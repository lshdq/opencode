import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { McpWindows } from "@opencode/util/mcp-windows"

// Bundled only by mcp-windows-host.test.ts and executed by the real Node runtime, not Bun.
Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* McpWindows.own(
        ChildProcess.make(process.execPath, [process.argv[2], "mcp-early-detached"], {
          cwd: process.argv[3],
          stdin: "ignore",
          forceKillAfter: 500,
        }),
      )
      const [code, output] = yield* Effect.all([handle.exitCode, Stream.mkString(Stream.decodeText(handle.stdout))], {
        concurrency: "unbounded",
      }).pipe(Effect.timeout("15 seconds"))
      if (code !== 0 || !output.includes('"method":"ready"'))
        throw new Error("Node host did not preserve root output/exit")
      const pid = Number(yield* Effect.promise(() => fs.readFile(path.join(process.argv[3], "child.pid"), "utf8")))
      const survived = yield* Effect.try(() => process.kill(pid, 0)).pipe(Effect.option)
      if (survived._tag === "Some") throw new Error("Node host left its detached descendant alive")
    }),
  ).pipe(Effect.provide(LayerNode.compile(CrossSpawnSpawner.node))),
).then(
  () => console.log(`NODE_MCP_JOB_OK ${process.version}`),
  (error) => {
    console.error(error)
    process.exitCode = 1
  },
)
