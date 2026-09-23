export * as FileMode from "./file-mode.js"

import { chmod, lstat } from "node:fs/promises"
import { resolve } from "node:path"

export class AlreadyExists extends Error {
  constructor() {
    super("Private file already exists")
  }
}

/** owned=true is only for an explicitly application-owned directory. Custom
 * directories must already be private; checking them never changes their ACL.
 */
export async function directory(path: string, options: { owned?: boolean; signal?: AbortSignal } = {}) {
  if (process.platform !== "win32") return
  const { FileModeWindows } = await import("./file-mode-windows.js")
  await FileModeWindows.execute(FileModeWindows.directoryScript, {
    OPENCODE_ACL_DIRECTORY: resolve(path),
    OPENCODE_ACL_OWNED_DIRECTORY: String(options.owned === true),
  }, { signal: options.signal })
}

/** Only explicit owner-only modes opt in. Never change unrelated user files. */
export function privateMode(mode: number | undefined): mode is number {
  return mode !== undefined && (mode & 0o077) === 0 && (mode & 0o700) !== 0
}

export async function apply(path: string, mode: number, signal?: AbortSignal) {
  if (process.platform !== "win32" || !privateMode(mode)) return chmod(path, mode)
  await lstat(path)
  await windows(path, mode, false, false, signal)
}

/** Create an empty private file, or tighten an existing file before writing secrets.
 * Missing files are left alone when create=false. Unix callers retain their mode/flags.
 */
export async function prepare(
  path: string,
  options: { create?: boolean; exclusive?: boolean; mode?: number; signal?: AbortSignal } = {},
) {
  if (process.platform !== "win32") return
  // Missing SQLite sidecars and first-run service registrations need no process.
  if (options.create === false) {
    const found = await lstat(path).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
      throw error
    })
    if (!found) return
  }
  await windows(path, options.mode ?? 0o600, options.create ?? true, options.exclusive ?? false, options.signal)
}

async function windows(path: string, mode: number, create: boolean, exclusive: boolean, signal?: AbortSignal) {
  const { FileModeWindows } = await import("./file-mode-windows.js")
  // DELETE permits rename-over-existing and SQLite cleanup; WRITE_DAC preserves
  // owner recovery. The DACL is submitted once with the current SID already in
  // place. A killed host leaves either the original or the complete private ACL,
  // never an intermediate empty DACL. Do NOT reset/widen it on timeout.
  const result = await FileModeWindows.execute(FileModeWindows.script, {
    OPENCODE_ACL_PATH: resolve(path),
    OPENCODE_ACL_RIGHTS: String(
      (mode & 0o400 ? 131209 : 0) |
      (mode & 0o200 ? 278 : 0) |
      (mode & 0o100 ? 32 : 0) |
      65536 | 131072 | 262144,
    ),
    OPENCODE_ACL_ACCESS: String((mode & 0o400 ? 1 : 0) | (mode & 0o200 ? 2 : 0)),
    OPENCODE_ACL_CREATE: String(create),
    OPENCODE_ACL_EXCLUSIVE: String(exclusive),
  }, { signal })
  if (result === "exists") throw new AlreadyExists()
}
