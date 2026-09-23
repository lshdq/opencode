import path from "node:path"

/** One bounded host invocation: establish/verify safe inheritance BEFORE open,
 * then protect the existing database and sidecars without truncating any file.
 * No post-creation chmod can close the retained-read-handle window.
 */
export async function prepareDatabase(filename: string, create: boolean, owned: boolean, signal?: AbortSignal) {
  if (process.platform !== "win32" || filename === ":memory:" || filename === "") return
  const { FileModeWindows } = await import("@opencode/util/file-mode-windows")
  await FileModeWindows.execute(FileModeWindows.directoryScript + `
$database = $env:OPENCODE_ACL_PATH
$createMain = $env:OPENCODE_ACL_CREATE
foreach ($suffix in @('', '-wal', '-shm', '-journal')) {
  $env:OPENCODE_ACL_PATH = $database + $suffix
  $env:OPENCODE_ACL_CREATE = if ($suffix -eq '') { $createMain } else { 'false' }
  if ($env:OPENCODE_ACL_CREATE -ne 'true' -and -not [System.IO.File]::Exists($env:OPENCODE_ACL_PATH)) { continue }
  ${FileModeWindows.script}
}
`, {
    OPENCODE_ACL_DIRECTORY: path.dirname(path.resolve(filename)),
    OPENCODE_ACL_OWNED_DIRECTORY: String(owned),
    OPENCODE_ACL_PATH: path.resolve(filename),
    OPENCODE_ACL_RIGHTS: "459167",
    OPENCODE_ACL_ACCESS: "3",
    OPENCODE_ACL_CREATE: String(create),
    OPENCODE_ACL_EXCLUSIVE: "false",
  }, { signal })
}
