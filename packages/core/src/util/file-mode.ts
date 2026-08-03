import { execFile } from "node:child_process"
import { chmod } from "node:fs/promises"

/**
 * Apply a Unix file mode. On Windows `chmod` only toggles the read-only bit,
 * so owner-only modes like 0o600 do not actually restrict access; tighten the
 * ACL to the current user via icacls on a best-effort basis.
 */
export async function applyFileMode(path: string, mode: number): Promise<void> {
  await chmod(path, mode)
  if (process.platform !== "win32") return
  // Group/other permissions cannot be represented in the ACL tightening below.
  if (mode & 0o077) return
  const user = process.env.USERNAME
  if (!user) return
  const perms = [(mode & 0o400) !== 0 && "R", (mode & 0o200) !== 0 && "W", (mode & 0o100) !== 0 && "X"]
    .filter(Boolean)
    .join(",")
  if (!perms) return
  await new Promise<void>((resolve) =>
    execFile("icacls", [path, "/inheritance:r", "/grant:r", `${user}:(${perms})`], () => resolve()),
  )
}
