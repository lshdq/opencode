import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { McpWindows } from "@opencode/util/mcp-windows"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { alive, edgeFixture, waitFor } from "./fixture/platform-edge"
import { testEffect } from "./lib/effect"

const live = testEffect(LayerNode.compile(CrossSpawnSpawner.node)).live
const windows = process.platform === "win32" ? live : live.skip

windows(
  "the target inherits KILL_ON_JOB_CLOSE and cannot request CREATE_BREAKAWAY_FROM_JOB",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const source = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InspectMcpJob {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, byte[] info, int size, out int returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string app, StringBuilder line, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, IntPtr startup, IntPtr info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr value);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr value, uint timeout);
  public static void Run() {
    byte[] limits = new byte[IntPtr.Size == 8 ? 144 : 112];
    int returned;
    if (!QueryInformationJobObject(IntPtr.Zero, 9, limits, limits.Length, out returned)) throw new Exception("No inherited job");
    int size = IntPtr.Size == 8 ? 104 : 68;
    IntPtr startup = Marshal.AllocHGlobal(size), info = Marshal.AllocHGlobal(IntPtr.Size * 2 + 8);
    try {
      for (int i = 0; i < size; i++) Marshal.WriteByte(startup, i, 0);
      Marshal.WriteInt32(startup, size);
      bool escaped = CreateProcessW(null, new StringBuilder("cmd.exe /d /c exit 0"), IntPtr.Zero, IntPtr.Zero,
        false, 0x09000000, IntPtr.Zero, null, startup, info);
      int error = Marshal.GetLastWin32Error();
      if (escaped) {
        WaitForSingleObject(Marshal.ReadIntPtr(info), 5000);
        CloseHandle(Marshal.ReadIntPtr(info)); CloseHandle(Marshal.ReadIntPtr(info, IntPtr.Size));
      }
      Console.Write(BitConverter.ToUInt32(limits, 16) + ":" + escaped + ":" + error);
    } finally { Marshal.FreeHGlobal(startup); Marshal.FreeHGlobal(info); }
  }
}`
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition @'
${source}
'@
[InspectMcpJob]::Run()`
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const output = yield* spawner
      .string(
        McpWindows.own(
          ChildProcess.make(
            path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
            ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
            { cwd: tmp.path, forceKillAfter: 500 },
          ),
        ),
      )
      .pipe(Effect.timeout("20 seconds"))
    expect(output).toBe("8192:False:5")
  }),
  30000,
)

for (const runtime of [process.execPath, "node"]) {
  live(
    `MCP-owned process preserves binary stdio and root exit code (${runtime})`,
    Effect.gen(function* () {
      const tmp = yield* edgeFixture()
      const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 256)
      const ready = yield* Deferred.make<void>()
      const script = path.join(tmp.path, "bytes.cjs")
      yield* Effect.promise(() =>
        fs.writeFile(
          script,
          `
const chunks = []
process.stdout.write("READY\\n")
process.stdin.on("data", chunk => chunks.push(chunk))
process.stdin.on("end", () => {
  const bytes = Buffer.concat(chunks)
  process.stdout.write(bytes, () => process.stderr.write(bytes, () => process.exit(37)))
})
`,
        ),
      )
      const handle = yield* McpWindows.own(
        ChildProcess.make(runtime, [script], {
          cwd: tmp.path,
          // Send and close only after the target has started, not merely while PS is compiling.
          stdin: Stream.fromEffect(Deferred.await(ready).pipe(Effect.as(bytes))),
          forceKillAfter: 500,
        }),
      )
      const [code, stdout, stderr] = yield* Effect.all(
        [
          handle.exitCode,
          Stream.mkUint8Array(handle.stdout.pipe(Stream.tap(() => Deferred.succeed(ready, undefined)))),
          Stream.mkUint8Array(handle.stderr),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.timeout("15 seconds"))
      expect(code).toBe(ChildProcessSpawner.ExitCode(37))
      expect(stdout.byteLength).toBe(bytes.byteLength + 6)
      expect(stderr.byteLength).toBe(bytes.byteLength)
      expect(new TextDecoder().decode(stdout.subarray(0, 6))).toBe("READY\n")
      expect(stdout.subarray(6)).toEqual(bytes)
      expect(stderr).toEqual(bytes)
    }),
    25000,
  )
}

for (const extension of ["exe", "cmd", "bat"]) {
  windows(
    `MCP job host preserves argv/cwd/env for ${extension}`,
    Effect.gen(function* () {
      const tmp = yield* edgeFixture()
      const script = path.join(tmp.path, "arguments.cjs")
      yield* Effect.promise(() =>
        fs.writeFile(
          script,
          `
process.stdout.write(JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), value: process.env.MCP_JOB_TEST_VALUE, modulePath: process.env.PSModulePath,
  leaked: Object.keys(process.env).filter(key => key.startsWith("OPENCODE_MCP_JOB_"))}))
`,
        ),
      )
      const shim = path.join(tmp.path, `echo & shim.${extension}`)
      if (extension !== "exe") {
        yield* Effect.promise(() =>
          fs.writeFile(shim, `@echo off\r\n"${process.execPath}" "%~dp0arguments.cjs" %*\r\n`),
        )
      }
      const args = [
        "",
        "plain",
        "space value",
        "中文😀",
        'quote"inside',
        "trailing\\",
        "space end\\",
        "a&b",
        "a|b",
        "a^b",
        "%PATH%",
        "!name!",
      ]
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const command = ChildProcess.make(
        extension === "exe" ? process.execPath : shim,
        extension === "exe" ? [script, ...args] : args,
        {
          cwd: tmp.path,
          env: { MCP_JOB_TEST_VALUE: "环境 ' value", PSModulePath: "D:\\mcp-test-no-modules" },
          extendEnv: true,
          forceKillAfter: 500,
        },
      )
      const baseline = yield* spawner.string(command)
      const output = yield* spawner.string(McpWindows.own(command)).pipe(Effect.timeout("15 seconds"))
      expect(output).toBe(baseline)
      const result = JSON.parse(output)
      if (extension === "exe") expect(result.args).toEqual(args)
      expect(result.cwd).toBe(tmp.path)
      expect(result.value).toBe("环境 ' value")
      expect(result.modulePath).toBe("D:\\mcp-test-no-modules")
      expect(result.leaked).toEqual([])
    }),
    25000,
  )
}

windows(
  "MCP command resolution honors configured PATH and PATHEXT",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const bin = path.join(tmp.path, "custom bin")
    yield* Effect.promise(() => fs.mkdir(bin))
    yield* Effect.promise(() =>
      fs.writeFile(path.join(bin, "mcp-path.cmd"), "@echo off\r\necho resolved-from-configured-path\r\n"),
    )
    const key = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH"
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const output = yield* spawner
      .string(
        McpWindows.own(
          ChildProcess.make("mcp-path", [], {
            cwd: tmp.path,
            env: { [key]: `${bin};${process.env[key] ?? ""}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
            extendEnv: true,
            forceKillAfter: 500,
          }),
        ),
      )
      .pipe(Effect.timeout("15 seconds"))
    expect(output.trim()).toBe("resolved-from-configured-path")
  }),
  25000,
)

windows(
  "cancelling a local MCP job scope kills detached descendants",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const fiber = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* McpWindows.own(
          ChildProcess.make("node", [tmp.script, "mcp-detached"], {
            cwd: tmp.path,
            forceKillAfter: 500,
          }),
        )
        yield* Effect.never
      }),
    ).pipe(Effect.forkScoped)
    yield* Effect.promise(() => waitFor(() => Bun.file(path.join(tmp.path, "child.ready")).exists(), 10000))
    const child = yield* Effect.promise(() => tmp.pid("child"))
    expect(alive(child)).toBe(true)
    yield* Fiber.interrupt(fiber).pipe(Effect.timeout("5 seconds"))
    yield* Effect.promise(() => waitFor(() => !alive(child)))
    expect(alive(child)).toBe(false)
  }),
  25000,
)

windows(
  "job host reports a missing target without starting uncontained work",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const result = yield* spawner
      .exitCode(
        McpWindows.own(
          ChildProcess.make(path.join(tmp.path, "absent.exe"), [], {
            cwd: tmp.path,
            forceKillAfter: 500,
          }),
        ),
      )
      .pipe(Effect.exit, Effect.timeout("15 seconds"))
    expect(Exit.isFailure(result) || result.value !== 0).toBe(true)
  }),
  25000,
)

windows(
  "the production MCP job spawner also works with a Node controller",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const build = yield* Effect.promise(() =>
      Bun.build({
        entrypoints: [path.join(import.meta.dir, "fixture/mcp-job-node.ts")],
        target: "node",
        format: "cjs",
      }),
    )
    if (!build.success) throw new AggregateError(build.logs, "Could not bundle Node fixture")
    const bundle = path.join(tmp.path, "controller.cjs")
    yield* Effect.promise(async () => fs.writeFile(bundle, await build.outputs[0].text()))
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const output = yield* spawner
      .string(
        ChildProcess.make("node", [bundle, tmp.script, tmp.path], {
          cwd: tmp.path,
          detached: true,
          forceKillAfter: 500,
        }),
      )
      .pipe(Effect.timeout("20 seconds"))
    expect(output).toContain("NODE_MCP_JOB_OK v")
  }),
  30000,
)

// TC-013: an owned job's release must not clean up a separate, still-live job.
windows(
  "closing one MCP job leaves another owned job alive",
  Effect.gen(function* () {
    const first = yield* edgeFixture()
    const second = yield* edgeFixture()
    const handles = yield* Effect.forEach([first, second], (tmp) =>
      McpWindows.own(ChildProcess.make("node", [tmp.script, "mcp-detached"], {
        cwd: tmp.path,
        forceKillAfter: 500,
      })),
    )
    yield* Effect.promise(() => Promise.all([first, second].map((tmp) =>
      waitFor(() => Bun.file(path.join(tmp.path, "child.ready")).exists(), 10000),
    )))
    const children = yield* Effect.promise(() => Promise.all([first.pid("child"), second.pid("child")]))
    expect(children.every(alive)).toBe(true)
    yield* handles[0].kill().pipe(Effect.timeout("5 seconds"))
    yield* Effect.promise(() => waitFor(() => !alive(children[0])))
    expect(alive(children[1])).toBe(true)
    expect(yield* handles[1].isRunning).toBe(true)
    yield* handles[1].kill().pipe(Effect.timeout("5 seconds"))
    yield* Effect.promise(() => waitFor(() => !alive(children[1])))
  }),
  30000,
)

windows(
  "MCP host preserves a chunked environment without inheriting controller variables",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const script = path.join(tmp.path, "environment.cjs")
    yield* Effect.promise(() => fs.writeFile(script, `
process.stdout.write(JSON.stringify({ large: process.env.MCP_LARGE, small: process.env.MCP_SMALL,
  leaked: Object.keys(process.env).filter(key => key.startsWith("OPENCODE_MCP_JOB_")),
  path: process.env.PATH, modulePath: process.env.PSModulePath }))
`))
    const large = "中文🌍".repeat(4000)
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const command = ChildProcess.make(process.execPath, [script], {
      cwd: tmp.path,
      // Bun inserts its own PATH when the key is omitted, even with env set.
      // An explicit empty value makes this a comparison of configured envs.
      env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: tmp.path, TMP: tmp.path, PATH: "",
        MCP_LARGE: large, MCP_SMALL: "a=b\nline", PSModulePath: "isolated-modules" },
      extendEnv: false,
      forceKillAfter: 500,
    })
    const baseline = yield* spawner.string(command)
    const output = yield* spawner.string(McpWindows.own(command)).pipe(Effect.timeout("15 seconds"))
    expect(output).toBe(baseline)
    expect(JSON.parse(output)).toEqual({ large, small: "a=b\nline", leaked: [], path: "", modulePath: "isolated-modules" })
  }),
  25000,
)

windows(
  "MCP job startup with a missing cwd fails without running the target",
  Effect.gen(function* () {
    const tmp = yield* edgeFixture()
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const result = yield* spawner.exitCode(McpWindows.own(ChildProcess.make(
      process.execPath,
      ["-e", `require('node:fs').writeFileSync(${JSON.stringify(path.join(tmp.path, "unexpected"))}, 'ran')`],
      { cwd: path.join(tmp.path, "missing"), forceKillAfter: 500 },
    ))).pipe(Effect.exit, Effect.timeout("10 seconds"))
    expect(Exit.isFailure(result) || result.value !== 0).toBe(true)
    expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "unexpected")).exists())).toBe(false)
  }),
  20000,
)
