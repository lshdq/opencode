export * as FileModeWindows from "./file-mode-windows.js"

import { existsSync } from "node:fs"
import { delimiter, isAbsolute, join, win32 } from "node:path"

// Prefer the OS-shipped host: no PowerShell 7 installation or PATH lookup is
// needed on normal Windows. Both hosts use security descriptors at creation.
export function command() {
  const system = win32.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (existsSync(system)) return system
  const core = process.env.PATH?.split(delimiter)
    .filter(isAbsolute)
    .map((directory) => join(directory, "pwsh.exe"))
    .find(existsSync)
  if (!core) throw new Error("Windows file permissions require system PowerShell 5.1 or PowerShell 7")
  return core
}

function systemRoot() {
  return process.env.SystemRoot && /^[A-Za-z]:[\\/]/.test(process.env.SystemRoot)
    ? win32.normalize(process.env.SystemRoot)
    : "C:\\Windows"
}

/** Wait for close, not just the abort callback: the killed host and its pipes
 * must be reaped before the failed permission operation returns to its caller.
 * The script never launches descendants. No application environment is copied.
 */
export async function execute(
  script: string,
  variables: NodeJS.ProcessEnv,
  options: { command?: string; timeout?: number; signal?: AbortSignal } = {},
) {
  const { execFile } = await import("node:child_process")
  const timeout = options.timeout ?? 10_000
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 10_000) throw new RangeError("Invalid ACL timeout")
  return new Promise<string>((resolve, reject) => {
    let complete = () => reject(new Error("Windows file permission process exited without a result"))
    const child = execFile(
      options.command ?? command(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        timeout,
        killSignal: "SIGKILL",
        signal: options.signal,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        env: {
          SystemRoot: systemRoot(),
          windir: systemRoot(),
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          PSModulePath: "",
          ...variables,
        },
      },
      (error, stdout) => {
        complete = () => error
          ? reject(new Error(error.code === 2 && stdout === "unsafe-directory"
            ? "Unsafe custom SQLite directory: configure a protected current-user FullControl (OI)(CI) ACL or use the default database location; no directory permissions were changed"
            : "Failed to protect private file (process error, timeout or cancellation)", { cause: error }))
          : resolve(stdout)
      },
    )
    child.once("close", () => complete())
    child.stdin?.end()
  })
}

// .NET Framework (PS5.1) exposes instance ACL methods and the FileStream
// FileSecurity constructor; .NET Core (PS7) exposes FileSystemAclExtensions.
// In both cases CreateNew receives the DACL in its native CreateFile call.
export const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PSModulePath = $PSHOME + '\\Modules'
function Read-FileAcl($file) {
  if ($PSVersionTable.PSEdition -eq 'Core') {
    return [System.IO.FileSystemAclExtensions]::GetAccessControl($file, [System.Security.AccessControl.AccessControlSections]::Access)
  }
  return $file.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
}
function Write-FileAcl($file, $acl) {
  if ($PSVersionTable.PSEdition -eq 'Core') {
    [System.IO.FileSystemAclExtensions]::SetAccessControl($file, $acl)
    return
  }
  $file.SetAccessControl($acl)
}
function Protect-File {
$file = [System.IO.FileInfo]::new($env:OPENCODE_ACL_PATH)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [System.Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights][int]$env:OPENCODE_ACL_RIGHTS, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$original = $null
$changed = $false
$created = $false
try {
  if ($env:OPENCODE_ACL_CREATE -eq 'true') {
    try {
      if ($PSVersionTable.PSEdition -eq 'Core') {
        $stream = [System.IO.FileSystemAclExtensions]::Create($file, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::ReadWrite, 4096, [System.IO.FileOptions]::None, $acl)
      } else {
        $stream = [System.IO.FileStream]::new($file.FullName, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::ReadWrite, 4096, [System.IO.FileOptions]::None, $acl)
      }
      $stream.Dispose()
      $created = $true
    } catch [System.IO.IOException] {
      if (-not $file.Exists) { throw }
      if ($env:OPENCODE_ACL_EXCLUSIVE -eq 'true') { [Console]::Out.Write('exists'); return }
    }
  }
  if (-not $created) {
    if (-not $file.Exists -and $env:OPENCODE_ACL_CREATE -ne 'true') { return }
    if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing private ACL on a reparse point' }
    $original = Read-FileAcl $file
    $acl = Read-FileAcl $file
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existing in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($existing) }
    $acl.AddAccessRule($rule)
    $changed = $true
    Write-FileAcl $file $acl
  }
  $actual = Read-FileAcl $file
  $rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IsInherited -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne $rule.FileSystemRights) { throw 'Private ACL verification failed' }
  $access = [System.IO.FileAccess][int]$env:OPENCODE_ACL_ACCESS
  if ([int]$access -ne 0) {
    $stream = [System.IO.File]::Open($file.FullName, [System.IO.FileMode]::Open, $access, [System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
    $stream.Dispose()
  }
} catch {
  if ($changed) {
    $sections = [System.Security.AccessControl.AccessControlSections]::Access
    $restore = [System.Security.AccessControl.FileSecurity]::new()
    $restore.SetSecurityDescriptorSddlForm($original.GetSecurityDescriptorSddlForm($sections), $sections)
    Write-FileAcl $file $restore
    $restored = Read-FileAcl $file
    if ($restored.GetSecurityDescriptorSddlForm($sections) -ne $original.GetSecurityDescriptorSddlForm($sections)) { throw 'Private ACL recovery failed' }
  }
  if ($created) { $file.Delete() }
  throw
}
}
Protect-File
`

// A private inheritable parent is required BEFORE SQLite can create any file.
// Checking the resulting file afterwards cannot revoke a previously opened handle.
export const directoryScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PSModulePath = $PSHOME + '\\Modules'
$directory = [System.IO.DirectoryInfo]::new($env:OPENCODE_ACL_DIRECTORY)
if (-not $directory.Exists -or ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'SQLite requires an existing non-reparse private directory' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sections = [System.Security.AccessControl.AccessControlSections]::Access
function Read-DirectoryAcl {
  if ($PSVersionTable.PSEdition -eq 'Core') { return [System.IO.FileSystemAclExtensions]::GetAccessControl($directory, $sections) }
  return $directory.GetAccessControl($sections)
}
function Write-DirectoryAcl($acl) {
  if ($PSVersionTable.PSEdition -eq 'Core') { [System.IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl); return }
  $directory.SetAccessControl($acl)
}
function Test-PrivateDirectory($acl) {
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  return ($acl.AreAccessRulesProtected -and $rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $sid.Value -and $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and $rules[0].InheritanceFlags -eq ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -and $rules[0].PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None)
}
$original = Read-DirectoryAcl
if (-not (Test-PrivateDirectory $original)) {
  if ($env:OPENCODE_ACL_OWNED_DIRECTORY -ne 'true') { [Console]::Out.Write('unsafe-directory'); exit 2 }
  $acl = Read-DirectoryAcl
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) { $acl.RemoveAccessRuleSpecific($rule) }
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit), [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow))
  try {
    Write-DirectoryAcl $acl
    if (-not (Test-PrivateDirectory (Read-DirectoryAcl))) { throw 'Private directory ACL verification failed' }
  } catch {
    $restore = [System.Security.AccessControl.DirectorySecurity]::new()
    $restore.SetSecurityDescriptorSddlForm($original.GetSecurityDescriptorSddlForm($sections), $sections)
    Write-DirectoryAcl $restore
    if ((Read-DirectoryAcl).GetSecurityDescriptorSddlForm($sections) -ne $original.GetSecurityDescriptorSddlForm($sections)) { throw 'Private directory ACL recovery failed' }
    throw
  }
}
`
