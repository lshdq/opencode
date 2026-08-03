import path from "path"
import * as Process from "./process"

function powershell() {
  return Process.run(["pwsh", "-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { nothrow: true }).then(
    (result) => (result.code === 0 ? "pwsh" : "powershell"),
  )
}

export async function extractZip(zipPath: string, destDir: string) {
  if (process.platform === "win32") {
    const shell = await powershell()
    // $global:ProgressPreference suppresses PowerShell's blue progress bar popup.
    // Paths are passed via environment variables to avoid quoting/injection issues.
    const cmd = `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath $env:OPENCODE_ZIP_PATH -DestinationPath $env:OPENCODE_ZIP_DEST -Force`
    await Process.run([shell, "-NoProfile", "-NonInteractive", "-Command", cmd], {
      env: {
        OPENCODE_ZIP_PATH: path.resolve(zipPath),
        OPENCODE_ZIP_DEST: path.resolve(destDir),
      },
    })
    return
  }

  await Process.run(["unzip", "-o", "-q", zipPath, "-d", destDir])
}

export * as Archive from "./archive"
