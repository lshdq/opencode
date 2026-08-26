import { execFile } from "node:child_process"
import { constants } from "node:fs"
import { chmod, open } from "node:fs/promises"
import {
  accessFailureStatus,
  completeACL,
  powershellEnvironment,
  resolveSystemRoot,
  restoreACL,
  windowsCommands,
  type TightenResult,
} from "./file-mode-state"

/**
 * Apply a Unix file mode. On Windows `chmod` only toggles the read-only bit,
 * so owner-only modes like 0o600 do not actually restrict access; tighten the
 * ACL to the current user on a best-effort basis.
 */
export async function applyFileMode(path: string, mode: number): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, mode)
    return
  }
  const modeApplied = await chmod(path, mode).then(
    () => true,
    () => false,
  )
  if (!modeApplied) return
  // Group/other permissions cannot be represented in the ACL tightening below.
  if (mode & 0o077) return
  const rights =
    ((mode & 0o400) !== 0 ? 131209 : 0) | ((mode & 0o200) !== 0 ? 278 : 0) | ((mode & 0o100) !== 0 ? 32 : 0)
  if (!rights) return
  const sid = await currentUserSID()
  if (!sid) return
  // Set-Acl applies the in-memory DACL in one update. The SecurityIdentifier
  // avoids account-name resolution and the script restores the old ACL if its
  // structural verification fails.
  const result = await tightenACL(path, sid, rights)
  await completeACL(result, {
    restore: () => restoreFileACL(path, accessFlag(mode)),
    verify: async () => {
      const flag = accessFlag(mode)
      if (!flag) return true
      // A busy file keeps its structurally verified ACL; an access denial restores it.
      return (await accessStatus(path, flag)) !== "denied"
    },
  })
}

function exec(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(command, args, { encoding: "latin1", env, windowsHide: true }, (error) => resolve(!error))
  })
}

function tightenACL(path: string, sid: string, rights: number): Promise<TightenResult> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$changed = $false",
    "try {",
    "$original = Get-Acl -LiteralPath $env:OPENCODE_FILE_MODE_PATH",
    "$acl = Get-Acl -LiteralPath $env:OPENCODE_FILE_MODE_PATH",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($existing in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existing) }",
    "$sid = [System.Security.Principal.SecurityIdentifier]$env:OPENCODE_FILE_MODE_SID",
    "$rights = [System.Security.AccessControl.FileSystemRights][int]$env:OPENCODE_FILE_MODE_RIGHTS",
    "$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Allow)",
    "$acl.AddAccessRule($rule)",
    "$changed = $true",
    "Set-Acl -LiteralPath $env:OPENCODE_FILE_MODE_PATH -AclObject $acl",
    "$actual = Get-Acl -LiteralPath $env:OPENCODE_FILE_MODE_PATH",
    "$rules = @($actual.Access)",
    "if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IsInherited) { throw 'Unexpected ACL shape' }",
    "$actualSid = $rules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "if ($actualSid -ne $sid.Value -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or [int]$rules[0].FileSystemRights -ne [int]$rule.FileSystemRights) { throw 'Unexpected ACL rule' }",
    "[Console]::Out.Write('tightened')",
    "} catch {",
    "if (-not $changed) { [Console]::Out.Write('safe'); exit 0 }",
    "try {",
    "Set-Acl -LiteralPath $env:OPENCODE_FILE_MODE_PATH -AclObject $original",
    "$restored = Get-Acl -LiteralPath $env:OPENCODE_FILE_MODE_PATH",
    "if ($restored.Sddl -ne $original.Sddl) { throw 'ACL restoration mismatch' }",
    "[Console]::Out.Write('safe')",
    "} catch { [Console]::Out.Write('unsafe'); exit 1 }",
    "}",
  ].join("; ")
  return new Promise((resolve) => {
    execFile(
      windowsCommands(systemRoot()).powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "latin1",
        windowsHide: true,
        env: powershellEnvironment(systemRoot(), {
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          OPENCODE_FILE_MODE_PATH: path,
          OPENCODE_FILE_MODE_SID: sid,
          OPENCODE_FILE_MODE_RIGHTS: String(rights),
        }),
      },
      (_error, stdout) => {
        if (stdout === "tightened" || stdout === "safe" || stdout === "unsafe") return resolve(stdout)
        resolve("unknown")
      },
    )
  })
}

function restoreFileACL(path: string, flag: "r" | "r+" | number | undefined): Promise<boolean> {
  return restoreACL({
    reset: () => exec(windowsCommands(systemRoot()).icacls, [path, "/reset"]),
    inherit: () => exec(windowsCommands(systemRoot()).icacls, [path, "/inheritance:e"]),
    verify: async () => !flag || (await accessStatus(path, flag)) !== "denied",
    wait: () => new Promise((resolve) => setTimeout(resolve, 100)),
  })
}

// whoami prints "<domain>\<user>","<sid>"; the SID is plain ASCII, so latin1
// decoding keeps extraction immune to console codepages such as GBK.
function currentUserSID(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      windowsCommands(systemRoot()).whoami,
      ["/user", "/fo", "csv", "/nh"],
      { encoding: "latin1", windowsHide: true },
      (error, stdout) => resolve(error ? undefined : /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(stdout)?.[1]),
    )
  })
}

function systemRoot(): string {
  return resolveSystemRoot(process.env.SystemRoot)
}

function accessFlag(mode: number): "r" | "r+" | number | undefined {
  if ((mode & 0o600) === 0o600) return "r+"
  if (mode & 0o200) return constants.O_WRONLY
  if (mode & 0o400) return "r"
}

async function accessStatus(
  path: string,
  flag: "r" | "r+" | number,
  attempt = 0,
): Promise<"accessible" | "busy" | "denied"> {
  const result = await open(path, flag).then(
    (handle) => ({ handle }),
    (error: unknown) => ({ error }),
  )
  if ("handle" in result) {
    await result.handle.close().catch(() => {})
    return "accessible"
  }
  const status = accessFailureStatus(accessErrorCode(result.error), attempt === 49)
  if (status !== "retry") return status
  await new Promise((resolve) => setTimeout(resolve, 100))
  return accessStatus(path, flag, attempt + 1)
}

function accessErrorCode(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("code" in error)) return
  return error.code
}
