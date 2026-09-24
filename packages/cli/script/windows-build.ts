import { mkdir, mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import {
  channel,
  deployVerifiedWindowsBinary,
  execute,
  executeRaw,
  sha256,
  sourceIdentity,
  upstreamBaseline,
} from "./windows-runtime"
import { repairWindowsLinks } from "./repair-windows-links"

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 is required")
if (Bun.version !== "1.4.2") throw new Error("Bun 1.4.2 is required")
const root = path.resolve(import.meta.dir, "../../..")
await repairWindowsLinks(root)
const base = await upstreamBaseline(root)
const lock = await sha256(path.join(root, "bun.lock"))
const env = {
  ...process.env,
  PATH: `${path.dirname(process.execPath)};${process.env.PATH ?? ""}`,
  BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR ?? "D:\\Program\\bun\\cache",
  ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? "D:\\Program\\bun\\electron-cache",
  HUSKY: "0",
  OPENCODE_CHANNEL: channel,
  OPENCODE_VERSION: base.version,
  OPENCODE_RELEASE: undefined,
  OPENCODE_BUMP: undefined,
  BUN_COMPILE_RELEASE: undefined,
}
if (!process.argv.includes("--skip-install")) {
  const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
    cwd: root,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  })
  if ((await install.exited) !== 0) throw new Error("Frozen install failed; do not change the lockfile to bypass it")
}
if ((await sha256(path.join(root, "bun.lock"))) !== lock) throw new Error("Install changed bun.lock")
const identity = await sourceIdentity(root)
const commit = await execute(["git", "rev-parse", "HEAD"], root)
const status = await execute(["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"], root)
const diff = await executeRaw(["git", "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"], root)
const id = `v2-${base.version}-${identity.sha256.slice(0, 12)}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
const parent = path.join(root, "packages", "cli", "dist", "windows")
await mkdir(parent, { recursive: true })
const output = path.join(parent, id)
await mkdir(output) // Never reuse a previous build directory.
await Bun.write(path.join(output, "source.diff"), diff)
const args = [
  "script/build.ts",
  "--single",
  "--skip-web-ui",
  "--skip-install",
  `--outdir=${path.join(output, "compiled")}`,
]
const build = Bun.spawn([process.execPath, ...args], {
  cwd: path.join(root, "packages", "cli"),
  env,
  stdio: ["ignore", "inherit", "inherit"],
})
if ((await build.exited) !== 0) throw new Error(`Build failed; output retained at ${output}`)
if ((await sha256(path.join(root, "bun.lock"))) !== lock) throw new Error("Build changed bun.lock")
if ((await sourceIdentity(root)).sha256 !== identity.sha256)
  throw new Error("Source changed during build; do not deploy a mixed artifact")
const binary = path.join(output, "compiled", "cli-windows-x64", "bin", "opencode.exe")
const metadata = {
  id,
  upstream: base.commit,
  version: base.version,
  channel,
  forkCommit: commit,
  dirty: status.length > 0,
  gitStatus: status.split("\0").filter(Boolean),
  diffSha256: await sha256(path.join(output, "source.diff")),
  source: identity,
  lockSha256: lock,
  binarySha256: await sha256(binary),
  bunVersion: Bun.version,
  bunSha256: await sha256(process.execPath),
  builtAt: new Date().toISOString(),
  args,
  webUI: false,
}
await Bun.write(path.join(output, "build-metadata.json"), JSON.stringify(metadata, null, 2) + "\n")
console.log(`Build: ${output}`)
if (process.argv.includes("--build-only")) process.exit(0)
const smoke = Bun.spawn([process.execPath, path.join(import.meta.dir, "smoke-win.ts"), output], {
  cwd: root,
  env,
  stdio: ["ignore", "inherit", "inherit"],
})
if ((await smoke.exited) !== 0) throw new Error("Isolated smoke failed; deployment blocked")
if (process.argv.includes("--no-deploy")) process.exit(0)
const deploy = path.resolve(
  process.argv.find((arg) => arg.startsWith("--deploy-root="))?.slice(14) ?? "D:\\Program\\opencode",
)
const checkRoot = await mkdtemp(path.join(output, "deploy-check-"))
try {
  const destination = await deployVerifiedWindowsBinary(binary, deploy, base.version, metadata.binarySha256, checkRoot)
  console.log(`Versioned deployment (NOT activated): ${destination}`)
} finally {
  await rm(checkRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
