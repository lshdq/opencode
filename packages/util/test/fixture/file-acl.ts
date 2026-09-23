import { execFile } from "node:child_process"
import { FileModeWindows } from "../../src/file-mode-windows.js"

export function powershell(script: string, file: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(FileModeWindows.command(), ["-NoProfile", "-NonInteractive", "-Command", `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PSModulePath = $PSHOME + '\\Modules'
${script}`], {
      windowsHide: true,
      timeout: 10_000,
      killSignal: "SIGKILL",
      env: { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, PSModulePath: "", ACL_TEST_PATH: file },
    }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()))
  })
}

export async function acl(file: string) {
  return JSON.parse(await powershell(`
$ErrorActionPreference = 'Stop'
$file = [System.IO.FileInfo]::new($env:ACL_TEST_PATH)
$acl = if ($PSVersionTable.PSEdition -eq 'Core') { [System.IO.FileSystemAclExtensions]::GetAccessControl($file) } else { $file.GetAccessControl() }
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; inherited = $_.IsInherited; allow = ($_.AccessControlType -eq 'Allow'); rights = [int]$_.FileSystemRights }
})
@{ current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; protected = $acl.AreAccessRulesProtected; rules = $rules; sddl = $acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All) } | ConvertTo-Json -Compress -Depth 5
`, file)) as { current: string; protected: boolean; sddl: string; rules: { sid: string; inherited: boolean; allow: boolean; rights: number }[] }
}

export async function grantEveryone(file: string) {
  await powershell(`
$ErrorActionPreference = 'Stop'
$file = [System.IO.FileInfo]::new($env:ACL_TEST_PATH)
$acl = if ($PSVersionTable.PSEdition -eq 'Core') { [System.IO.FileSystemAclExtensions]::GetAccessControl($file) } else { $file.GetAccessControl() }
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow))
if ($PSVersionTable.PSEdition -eq 'Core') { [System.IO.FileSystemAclExtensions]::SetAccessControl($file, $acl) } else { $file.SetAccessControl($acl) }
`, file)
}
