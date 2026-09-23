import { lstat } from "node:fs/promises"
import path from "node:path"
import { execute } from "./windows-runtime"

export async function repairWindowsLinks(root: string) {
  if (process.platform !== "win32") return
  for (const file of ["packages/app/src/custom-elements.d.ts", "packages/enterprise/src/custom-elements.d.ts"]) {
    const indexed = await execute(["git", "ls-files", "--stage", "--", file], root)
    if (!indexed.startsWith("120000 ")) throw new Error(`Expected tracked symlink: ${file}`)
    if ((await lstat(path.join(root, file))).isSymbolicLink()) continue
    const target = await execute(["git", "show", `:${file}`], root)
    if ((await Bun.file(path.join(root, file)).text()) !== target)
      throw new Error(`Refusing to overwrite modified symlink placeholder: ${file}`)
    // Per-command only: no changes to local/global git configuration or index content.
    await execute(["git", "-c", "core.symlinks=true", "checkout-index", "-f", "--", file], root)
    if (!(await lstat(path.join(root, file))).isSymbolicLink())
      throw new Error(`Symlink creation failed; enable Windows Developer Mode or symlink privilege: ${file}`)
    await execute(["git", "diff", "--exit-code", "--", file], root)
    console.log(`Restored tracked symlink: ${file}`)
  }
}

if (import.meta.main) await repairWindowsLinks(path.resolve(import.meta.dir, "../../.."))
