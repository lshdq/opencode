/// <reference path="./cross-spawn-parse.d.ts" />
import path from "node:path"
import parse from "cross-spawn/lib/parse.js"
import type { ChildProcess } from "effect/unstable/process"
import type { SpawnOptions } from "node:child_process"

// A process-local capability, not a command option: remote drivers receive the unchanged command.
// Only the local CrossSpawnSpawner consumes it, at the point where execution placement is known.
const owned = new WeakSet<ChildProcess.StandardCommand>()

export function own(command: ChildProcess.StandardCommand) {
  owned.add(command)
  return command
}

export function isOwned(command: ChildProcess.StandardCommand) {
  return owned.has(command)
}

export function wrap(command: ChildProcess.StandardCommand, options: SpawnOptions) {
  const parsed = parse(command.command, [...command.args], options)
  const variable = `OPENCODE_MCP_JOB_${crypto.randomUUID().replaceAll("-", "")}`
  const line = [
    quote(parsed.command),
    ...parsed.args.map((arg) => (parsed.options.windowsVerbatimArguments ? arg : quote(arg))),
  ].join(" ")
  const seen = new Set<string>()
  // PowerShell changes PSModulePath during startup. Give CreateProcess the original environment,
  // not the host's mutated one; chunk metadata to stay below the Windows per-variable size limit.
  const block = Buffer.from(
    Object.entries(options.env ?? process.env)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([key, value]) => {
        if (value === undefined || seen.has(key.toLowerCase())) return []
        seen.add(key.toLowerCase())
        return [`${key}=${value}`]
      })
      .join("\0") + "\0\0",
    "utf16le",
  ).toString("base64")
  const chunks = block.match(/.{1,16000}/g) ?? []
  const script = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $line = [Environment]::GetEnvironmentVariable('${variable}_LINE')
  $cwd = [Environment]::GetEnvironmentVariable('${variable}_CWD')
  [Environment]::SetEnvironmentVariable('${variable}_LINE', $null)
  [Environment]::SetEnvironmentVariable('${variable}_CWD', $null)
  $encoded = ''
  for ($i = 0; $i -lt ${chunks.length}; $i++) {
    $key = '${variable}_ENV_' + $i
    $encoded += [Environment]::GetEnvironmentVariable($key)
    [Environment]::SetEnvironmentVariable($key, $null)
  }
  $environment = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
  Add-Type -TypeDefinition @'
${host}
'@
  [OpenCodeMcpJob]::Run($line, $cwd, $environment)
} catch {
  [Console]::Error.WriteLine('OpenCode MCP job host: ' + $_.Exception.Message)
  [Environment]::Exit(127)
}`
  return {
    command: path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    options: {
      ...options,
      shell: false,
      env: {
        ...options.env,
        [`${variable}_LINE`]: line,
        [`${variable}_CWD`]: options.cwd?.toString() ?? process.cwd(),
        ...Object.fromEntries(chunks.map((chunk, index) => [`${variable}_ENV_${index}`, chunk])),
      },
    },
  }
}

// CommandLineToArgvW / CRT quoting, including empty args and trailing backslashes.
function quote(value: string) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`
}

// The host owns the only (non-inheritable) job handle. It joins before CreateProcess, so no target
// instruction can execute outside the job, including CREATE_NEW_PROCESS_GROUP/DETACHED_PROCESS.
// Do not enable BREAKAWAY_OK or SILENT_BREAKAWAY_OK. Failure to establish containment is fatal.
const host = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class OpenCodeMcpJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public uint Size;
    public string Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedPointer, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread;
    public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr copy, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder line, IntPtr processAttributes, IntPtr threadAttributes,
    bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr Copy(int id) {
    IntPtr copy;
    Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(id), GetCurrentProcess(), out copy, 0, true, 2));
    return copy;
  }
  public static void Run(string line, string cwd, string environment) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    Check(job != IntPtr.Zero);
    ExtendedLimit limits = new ExtendedLimit();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway
    Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
    Check(AssignProcessToJobObject(job, GetCurrentProcess()));
    StartupInfo startup = new StartupInfo();
    startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
    startup.Flags = 0x100; // STARTF_USESTDHANDLES: inherit bytes, never PowerShell text pipelines
    startup.Input = Copy(-10); startup.Output = Copy(-11); startup.Error = Copy(-12);
    ProcessInfo child;
    IntPtr env = Marshal.StringToHGlobalUni(environment);
    try {
      Check(CreateProcessW(null, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, true, 0x08000400,
        env, cwd, ref startup, out child)); // CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT
    } finally { Marshal.FreeHGlobal(env); }
    CloseHandle(startup.Input); CloseHandle(startup.Output); CloseHandle(startup.Error);
    CloseHandle(child.Thread);
    Check(WaitForSingleObject(child.Process, 0xffffffff) == 0);
    uint code;
    Check(GetExitCodeProcess(child.Process, out code));
    CloseHandle(child.Process);
    // Waiting on the root process handle, not stdio EOF: helpers can retain the pipes forever.
    // Process teardown closes our job handle and kills every remaining member, including detached helpers.
    Environment.Exit(unchecked((int)code));
  }
}
`

export * as McpWindows from "./mcp-windows.js"
