import path from "path"
import * as Process from "./process"

function powershell() {
  return Process.run(["pwsh", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { nothrow: true }).then(
    (result) => (result.code === 0 ? "pwsh" : "powershell"),
  )
}

export async function extractZip(zipPath: string, destDir: string) {
  if (process.platform === "win32") {
    if (Bun.which("tar.exe")) {
      await Process.run(["tar.exe", "-xf", path.resolve(zipPath), "-C", path.resolve(destDir)])
      return
    }
    const shell = await powershell()
    // $global:ProgressPreference suppresses PowerShell's blue progress bar popup.
    // Paths are passed via environment variables to avoid quoting/injection issues.
    const cmd = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath $env:OPENCODE_ZIP_PATH -DestinationPath $env:OPENCODE_ZIP_DEST -Force`
    const env: Record<string, string> = {
      OPENCODE_ZIP_PATH: path.resolve(zipPath),
      OPENCODE_ZIP_DEST: path.resolve(destDir),
    }
    if (shell === "powershell") {
      // an inherited pwsh7 PSModulePath makes 5.1 resolve the PS7-only
      // Microsoft.PowerShell.Archive first and fail to load it; pin the 5.1 system path
      const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
      env["PSModulePath"] = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules")
    }
    await Process.run([shell, "-NoProfile", "-NonInteractive", "-Command", cmd], { env })
    return
  }

  await Process.run(["unzip", "-o", "-q", zipPath, "-d", destDir])
}

export * as Archive from "./archive"
