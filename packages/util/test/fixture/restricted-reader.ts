import { randomUUID } from "node:crypto"
import { stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { FileModeWindows } from "../../src/file-mode-windows.js"

export const windowSecret = "ACL-WINDOW-FIXTURE-NOT-A-CREDENTIAL"

export async function waitForMarker(file: string) {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (await stat(file).then(() => true, () => false)) return
    await Bun.sleep(25)
  }
  throw new Error("Restricted reader did not reach its marker")
}

// A real restricted token must pass BOTH the ordinary token access check and
// an Everyone-only restricting-SID check. It can read an Everyone-readable
// control file but cannot use the owner's SID to open a private file. No account
// creation, admin privilege, ACL mocks or production VFS changes are involved.
export function restrictedReader(files: string[], root: string) {
  const marker = path.join(root, randomUUID() + ".reader")
  const state = { done: false }
  const result = FileModeWindows.execute(script, {
    OPENCODE_READER_FILES: files.join("|"),
    OPENCODE_READER_MARKER: marker,
    OPENCODE_READER_SECRET: windowSecret,
  }, { command: Bun.which("pwsh.exe") ?? undefined }).then((text) => {
    const fields = text.trim().split("|")
    return { opened: Number(fields[0]), denied: Number(fields[1]), missing: Number(fields[2]), readSecret: fields[3] === "True" }
  }).finally(() => { state.done = true })
  void result.catch(() => {})
  return {
    state,
    ready: () => waitForMarker(marker),
    opened: () => waitForMarker(marker + ".opened"),
    read: () => waitForMarker(marker + ".read"),
    close: async () => {
      await writeFile(marker + ".stop", "stop")
      return result
    },
  }
}

const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PSModulePath = $PSHOME + '\\Modules'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class RestrictedReader {
  [StructLayout(LayoutKind.Sequential)] public struct SidAttributes { public IntPtr Sid; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disabledCount, IntPtr disabled, uint deletedCount, IntPtr deleted, uint restrictedCount, SidAttributes[] restricted, out IntPtr result);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool ImpersonateLoggedOnUser(IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool RevertToSelf();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint attributes, IntPtr template);
  public static string Watch(string[] paths, string marker, string secret) {
    IntPtr token = IntPtr.Zero, restricted = IntPtr.Zero, sidMemory = IntPtr.Zero;
    var streams = new FileStream[paths.Length];
    int opened = 0, denied = 0, missing = 0;
    bool read = false;
    try {
      if (!OpenProcessToken(GetCurrentProcess(), 14, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var sid = new SecurityIdentifier("S-1-1-0");
      var bytes = new byte[sid.BinaryLength];
      sid.GetBinaryForm(bytes, 0);
      sidMemory = Marshal.AllocHGlobal(bytes.Length);
      Marshal.Copy(bytes, 0, sidMemory, bytes.Length);
      var sids = new[] { new SidAttributes { Sid = sidMemory, Attributes = 0 } };
      if (!CreateRestrictedToken(token, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, sids, out restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
      File.WriteAllText(marker, "ready");
      var clock = Stopwatch.StartNew();
      var buffer = new byte[1048576];
      while (clock.ElapsedMilliseconds < 8000 && !File.Exists(marker + ".stop")) {
        for (int i = 0; i < paths.Length; i++) {
          if (streams[i] == null) {
            if (!ImpersonateLoggedOnUser(restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr handle;
            int error;
            try { handle = CreateFileW(paths[i], 0x80000000, 7, IntPtr.Zero, 3, 128, IntPtr.Zero); error = Marshal.GetLastWin32Error(); }
            finally { if (!RevertToSelf()) throw new Win32Exception(Marshal.GetLastWin32Error()); }
            if (handle != new IntPtr(-1)) {
              streams[i] = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read);
              opened++;
              File.WriteAllText(marker + ".opened", "opened");
            } else if (error == 5) denied++;
            else if (error == 2 || error == 3 || error == 32) missing++;
            else throw new Win32Exception(error);
          }
          if (streams[i] != null) {
            if (!ImpersonateLoggedOnUser(restricted)) throw new Win32Exception(Marshal.GetLastWin32Error());
            bool found;
            try {
              streams[i].Position = 0;
              int count = streams[i].Read(buffer, 0, buffer.Length);
              found = Encoding.UTF8.GetString(buffer, 0, count).Contains(secret);
            } finally { if (!RevertToSelf()) throw new Win32Exception(Marshal.GetLastWin32Error()); }
            if (found) {
              read = true;
              File.WriteAllText(marker + ".read", "read");
            }
          }
        }
        Thread.Sleep(1);
      }
      return opened + "|" + denied + "|" + missing + "|" + read;
    } finally {
      foreach (var stream in streams) if (stream != null) stream.Dispose();
      if (restricted != IntPtr.Zero) CloseHandle(restricted);
      if (token != IntPtr.Zero) CloseHandle(token);
      if (sidMemory != IntPtr.Zero) Marshal.FreeHGlobal(sidMemory);
    }
  }
}
'@
[Console]::Out.Write([RestrictedReader]::Watch($env:OPENCODE_READER_FILES.Split([char]'|'), $env:OPENCODE_READER_MARKER, $env:OPENCODE_READER_SECRET))
`
