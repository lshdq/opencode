import { expect } from "bun:test"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect"
import { McpStdio } from "@opencode/core/mcp/stdio"
import { Environment } from "@opencode/core/environment/index"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { hostEnvironmentLayer } from "./fixture/environment"
import { alive, edgeFixture, waitFor } from "./fixture/platform-edge"
import { testEffect } from "./lib/effect"

const live = testEffect(hostEnvironmentLayer)
const windows = process.platform === "win32" ? live.live : live.live.skip

for (const mode of ["mcp", "mcp-early", "mcp-detached", "mcp-early-detached"]) {
  windows(
    `MCP closes its owned descendant after wrapper exit (${mode})`,
    Effect.gen(function* () {
      const tmp = yield* edgeFixture()
      const ready = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      const transport = yield* McpStdio.make({
        server: `platform-edge-${mode}`,
        command: "node",
        args: [tmp.script, mode],
        cwd: tmp.path,
        environment: {},
      })
      transport.onmessage = () => Deferred.doneUnsafe(ready, Exit.void)
      transport.onclose = () => Deferred.doneUnsafe(closed, Exit.void)
      yield* Effect.promise(() => transport.start())
      yield* Deferred.await(ready).pipe(Effect.timeout("5 seconds"))
      const pid = yield* Effect.promise(() => tmp.pid("child"))
      const started = Date.now()
      if (mode.startsWith("mcp-early")) yield* Deferred.await(closed).pipe(Effect.timeout("7 seconds"))
      yield* Effect.promise(() => Promise.all([transport.close(), transport.close()])).pipe(Effect.timeout("7 seconds"))
      expect(Date.now() - started).toBeLessThan(8000)
      expect(alive(yield* Effect.promise(() => tmp.pid("parent")))).toBe(false)
      yield* Effect.promise(() => waitFor(() => !alive(pid), 1000))
      expect(alive(pid)).toBe(false)
    }),
    15000,
  )
}

windows(
  "cancelling the MCP transport scope closes the job with detached children",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const ready = yield* Deferred.make<void>()
    const fiber = yield* Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* McpStdio.make({
          server: "cancelled-transport",
          command: "node",
          args: [tmp.script, "mcp-detached"],
          cwd: tmp.path,
          environment: {},
        })
        transport.onmessage = () => Deferred.doneUnsafe(ready, Exit.void)
        yield* Effect.promise(() => transport.start())
        yield* Effect.never
      }),
    ).pipe(Effect.forkScoped)
    yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"))
    const child = yield* Effect.promise(() => tmp.pid("child"))
    expect(alive(child)).toBe(true)
    yield* Fiber.interrupt(fiber).pipe(Effect.timeout("7 seconds"))
    yield* Effect.promise(() => waitFor(() => !alive(child)))
    expect(alive(child)).toBe(false)
  }),
  25000,
)

windows(
  "closing while the Windows MCP host is still starting leaves no late target",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const transport = yield* McpStdio.make({
      server: "late-host",
      command: "node",
      args: [tmp.script, "mcp-detached"],
      cwd: tmp.path,
      environment: {},
    })
    const start = transport.start()
    const close = transport.close()
    expect(transport.close()).toBe(close)
    yield* Effect.promise(() => Promise.all([start, close])).pipe(Effect.timeout("10 seconds"))
    yield* Effect.sleep("500 millis")
    for (const name of ["parent", "child"] as const) {
      if (!(yield* Effect.promise(() => Bun.file(path.join(tmp.path, `${name}.pid`)).exists()))) continue
      expect(alive(yield* Effect.promise(() => tmp.pid(name)))).toBe(false)
    }
  }),
  20000,
)

testEffect(Layer.empty).live(
  "MCP sends the original command and configured env to a remote execution plane",
  Effect.gen(function* () {
    const commands: ChildProcess.StandardCommand[] = []
    const environment = Layer.succeed(
      Environment.Service,
      Environment.Service.of({
        files: Environment.makeFiles(Environment.makeMemoryDriver()),
        spawner: ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline")
          commands.push(command)
          return Effect.succeed(
            makeHandle({
              pid: ProcessId(123),
              exitCode: Effect.succeed(ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.never,
              stderr: Stream.empty,
              all: Stream.never,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          )
        }),
      }),
    )
    yield* Effect.gen(function* () {
      const transport = yield* McpStdio.make({
        server: "remote-linux-on-windows-host",
        command: "/usr/local/bin/remote-mcp",
        args: ["--stdio", "remote value"],
        cwd: "/workspace/not-on-the-host",
        environment: { REMOTE_ONLY: "value" },
      })
      yield* Effect.promise(() => transport.start())
      yield* Effect.promise(() => transport.close())
    }).pipe(Effect.provide(environment))
    expect(commands).toHaveLength(1)
    expect(commands[0].command).toBe("/usr/local/bin/remote-mcp")
    expect(commands[0].args).toEqual(["--stdio", "remote value"])
    expect(commands[0].options.cwd).toBe("/workspace/not-on-the-host")
    expect(commands[0].options.env).toEqual({ REMOTE_ONLY: "value" })
  }),
)
