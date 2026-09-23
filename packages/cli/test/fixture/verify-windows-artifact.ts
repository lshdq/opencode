// Read-only artifact audit. Run before fixture edits when comparing the current tracked diff.
// Usage: bun test/fixture/verify-windows-artifact.ts <build-directory>
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises"
import path from "node:path"

const output = path.resolve(process.argv[2])
const repo = path.resolve(import.meta.dir, "../../../..")
const metadata = await Bun.file(path.join(output, "build-metadata.json")).json()
const digest = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
assert.equal(metadata.upstream, "080b7671dea45a693b537c1e358e89ab14463d0d")
assert.equal(metadata.version, "2.0.12")
assert.equal(metadata.channel, "local")
assert.equal(metadata.bunVersion, Bun.version)
assert.equal(digest(await readFile(process.execPath)), metadata.bunSha256)
assert.equal(digest(await readFile(path.join(repo, "bun.lock"))), metadata.lockSha256)
assert.equal(
  digest(await readFile(path.join(output, "compiled/cli-windows-x64/bin/opencode.exe"))),
  metadata.binarySha256,
)
assert.equal(digest(JSON.stringify(metadata.source.files)), metadata.source.sha256)
for (const entry of metadata.source.files) {
  const file = path.join(repo, entry.file)
  if (entry.kind === "deleted") {
    assert.equal(
      await lstat(file).then(
        () => true,
        () => false,
      ),
      false,
      entry.file,
    )
    continue
  }
  const data = entry.kind === "symlink" ? await readlink(file) : await readFile(file)
  if (entry.kind === "symlink") assert.equal(data, entry.target, entry.file)
  assert.equal(digest(data), entry.sha256, entry.file)
}
const patch = await readFile(path.join(output, "source.diff"))
assert.equal(digest(patch), metadata.diffSha256)
assert.equal(patch.at(-1), 10)
const temp = await mkdtemp(path.join(output, "audit-"))
async function git(args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 60_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    assert.equal(code, 0, stderr)
    return stdout
  } finally {
    clearTimeout(timer)
  }
}
try {
  const reference = path.join(temp, "git-output.diff")
  await git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", `--output=${reference}`])
  assert.deepEqual(patch, await readFile(reference), "Artifact patch differs from direct Git output")
  console.log(await git(["apply", "--stat", path.join(output, "source.diff")]))
  await git(["apply", "--check", "--reverse", path.join(output, "source.diff")])
  console.log(
    JSON.stringify(
      {
        buildID: metadata.id,
        binarySha256: metadata.binarySha256,
        sourceSha256: metadata.source.sha256,
        diffSha256: metadata.diffSha256,
        sourceFiles: metadata.source.files.length,
        patchBytes: patch.length,
        passed: true,
      },
      null,
      2,
    ),
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
