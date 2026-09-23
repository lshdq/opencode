// Read-only comparison loader: execute fixed Git sources against the same locked
// dependencies without checkout/stash or replacing concurrent worktree files.
import { plugin } from "bun"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
const ref = process.env.OPENCODE_COMPARE_REF
if (!ref) throw new Error("OPENCODE_COMPARE_REF must name the fixed comparison commit")
const { transformSolidSource } = await import(new URL("./solid-transform.js", import.meta.resolve("@opentui/solid/bun-plugin")).href)
const skip = process.env.OPENCODE_COMPARE_WORKING_TEST === "1"
const diff = Bun.spawnSync(["git", "diff", "--name-only", ref, "--", "packages"], { cwd: root })
if (diff.exitCode !== 0) throw new Error(new TextDecoder().decode(diff.stderr))
const modified = new TextDecoder().decode(diff.stdout).trim().split(/\r?\n/)
  .filter((file) => /\.(?:[cm]?[jt]sx?|json)$/.test(file))
  .filter((file) => !skip || file !== "packages/tui/test/command-selection.test.tsx")
const filter = new RegExp(`^(?:${modified.map((file) => path.join(root, file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`)
plugin.clearAll()
plugin({
  name: "fixed-git-baseline",
  setup(build) {
    build.onLoad({ filter }, async (args) => {
      const relative = path.relative(root, args.path).replaceAll("\\", "/")
      // Unchanged files are byte-identical to the commit. Only replace dirty
      // tracked modules, avoiding a Git process for every dependency import.
      const result = Bun.spawnSync(["git", "show", `${ref}:${relative}`], { cwd: root })
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
      const source = new TextDecoder().decode(result.stdout)
      console.error(`[fixed-git-baseline] load ${relative}`)
      if (/\.[jt]sx$/.test(relative)) {
        return { contents: await transformSolidSource(source, { filename: args.path, moduleName: "@opentui/solid" }), loader: "js" }
      }
      if (relative.endsWith(".json")) return { contents: `export default ${source}`, loader: "js" }
      return { contents: source, loader: relative.endsWith(".ts") ? "ts" : "js" }
    })
  },
})
plugin(createSolidTransformPlugin())
console.error(`[fixed-git-baseline] ref=${ref} test=${skip ? "working" : "fixed"} root=${root}`)
