import { createHash } from "node:crypto"
import { constants, copyFile, lstat, mkdir, readlink, rm, stat } from "node:fs/promises"
import path from "node:path"

export const channel = "local"

export async function upstreamBaseline(root: string) {
  const commit = await execute(["git", "merge-base", "HEAD", "upstream/v2"], root)
  return { commit, ...(await upstreamAtCommit(root, commit)) }
}

export async function upstreamAtCommit(root: string, commit: string) {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error("Invalid upstream baseline commit")
  const packageJSON: unknown = JSON.parse(await execute(["git", "show", `${commit}:package.json`], root))
  if (
    typeof packageJSON !== "object" ||
    packageJSON === null ||
    !("version" in packageJSON) ||
    typeof packageJSON.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(packageJSON.version) ||
    !("packageManager" in packageJSON) ||
    packageJSON.packageManager !== "bun@1.4.2"
  )
    throw new Error("Unexpected upstream baseline package metadata")
  return { version: packageJSON.version }
}

export async function deployWindowsBinary(
  binary: string,
  root: string,
  version: string,
  expectedHash: string,
  at = new Date(),
) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid deployment version")
  if (!(await stat(root)).isDirectory()) throw new Error("Deployment parent must already exist")
  const stamp = [at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes()]
    .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
    .join("")
  const destination = path.join(root, `opencode-${version}-${stamp}.exe`)
  // Exclusive creation prevents a same-minute rerun (including a concurrent one) from overwriting an older build.
  await copyFile(binary, destination, constants.COPYFILE_EXCL)
  if ((await sha256(destination)) !== expectedHash) {
    await rm(destination)
    throw new Error("Deployed binary hash mismatch")
  }
  return destination
}

export async function deployVerifiedWindowsBinary(
  binary: string,
  root: string,
  version: string,
  expectedHash: string,
  checkRoot: string,
  at = new Date(),
) {
  const destination = await deployWindowsBinary(binary, root, version, expectedHash, at)
  // Validate the renamed executable, not the original build path; only our exclusive copy may be removed on failure.
  try {
    if (cliVersion(await execute([destination, "--version"], checkRoot, isolatedEnvironment(checkRoot), 30_000)) !== version)
      throw new Error("Renamed deployed binary version mismatch")
  } catch (error) {
    await rm(destination)
    throw error
  }
  return destination
}

export function cliVersion(output: string) {
  const match = /^(?:opencode v)?(\d+\.\d+\.\d+)$/.exec(output.trim())
  if (!match) throw new Error("Unexpected CLI version output")
  return match[1]
}

export function isolatedEnvironment(root: string, inherited = process.env) {
  // Keep OS execution/locale hints only, not an open-ended list of ambient credentials or overrides.
  const allowed = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SYSTEMDRIVE",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "CI",
  ])
  const clean = Object.fromEntries(Object.entries(inherited).filter(([key]) => allowed.has(key.toUpperCase())))
  return {
    ...clean,
    HOME: root,
    USERPROFILE: root,
    PWD: root,
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    OPENCODE_TEST_HOME: root,
    OPENCODE_CONFIG_DIR: path.join(root, "config", "opencode"),
    OPENCODE_CONFIG_CONTENT: '{"update":"disable"}',
    OPENCODE_CLI_CONFIG_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DB: path.join(root, "data", "smoke.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    BUN_INSTALL_CACHE_DIR: path.join(root, "cache", "bun"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "cache", "bun-transpiler"),
  }
}

// The caller owns this fresh mkdtemp root. Never derive an owned directory from a user DB override.
export async function prepareIsolatedDatabaseDirectory(root: string) {
  const directory = path.join(root, "data")
  await mkdir(directory, { recursive: true })
  const { FileMode } = await import("@opencode/util/file-mode")
  await FileMode.directory(directory, { owned: true })
  return directory
}

export async function execute(command: string[], cwd: string, env = process.env, timeout = 120_000) {
  return new TextDecoder().decode(await executeRaw(command, cwd, env, timeout)).trimEnd()
}

// Artifact output must not pass through text decoding or whitespace normalization.
export async function executeRaw(command: string[], cwd: string, env = process.env, timeout = 120_000) {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), timeout)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).arrayBuffer(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0) throw new Error(`${path.basename(command[0])} exited ${code}: ${stderr.trimEnd()}`)
    return new Uint8Array(stdout)
  } finally {
    clearTimeout(timer)
  }
}

export async function sha256(file: string) {
  return createHash("sha256")
    .update(new Uint8Array(await Bun.file(file).arrayBuffer()))
    .digest("hex")
}

export async function sourceIdentity(root: string) {
  const tracked = new Set((await execute(["git", "ls-files", "-z", "--cached"], root)).split("\0"))
  const files = (await execute(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], root))
    .split("\0")
    .filter(Boolean)
  const entries = await Promise.all(
    [...new Set(files)].sort().map(async (file) => {
      const absolute = path.join(root, file)
      const info = await lstat(absolute).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return
        throw error
      })
      const link = info?.isSymbolicLink() ? await readlink(absolute) : undefined
      return {
        file,
        tracked: tracked.has(file),
        kind: info === undefined ? "deleted" : link === undefined ? "file" : "symlink",
        ...(link === undefined ? {} : { target: link }),
        sha256:
          info === undefined
            ? "deleted"
            : link === undefined
              ? await sha256(absolute)
              : createHash("sha256").update(link).digest("hex"),
      }
    }),
  )
  return { sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), files: entries }
}

export function assertRegistration(value: unknown, pid: number, version: string) {
  if (typeof value !== "object" || value === null) throw new Error("Missing smoke registration")
  if (!("pid" in value) || value.pid !== pid) throw new Error("Registration is not owned by the spawned process")
  if (!("version" in value) || value.version !== version) throw new Error("Wrong registered version")
  if (!("id" in value) || typeof value.id !== "string" || !value.id) throw new Error("Missing service identity")
  if (!("password" in value) || typeof value.password !== "string" || !value.password)
    throw new Error("Missing private smoke credential")
  if (!("url" in value) || typeof value.url !== "string") throw new Error("Missing smoke URL")
  const url = new URL(value.url)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password)
    throw new Error("Refusing a non-loopback smoke endpoint")
  return { pid, version, id: value.id, password: value.password, url: value.url }
}
