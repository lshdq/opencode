import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"

export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeout = 3000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error(`Platform fixture condition timed out after ${timeout}ms`)
}

export const edgeFixture = () =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-edge-中文 ' "))
      await fs.copyFile(path.join(import.meta.dir, "platform-edge-process.cjs"), path.join(dir, "process.cjs"))
      return {
        path: dir,
        script: path.join(dir, "process.cjs"),
        async pid(name: "parent" | "child") {
          const pid = Number(await fs.readFile(path.join(dir, `${name}.pid`), "utf8"))
          if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("Invalid fixture pid")
          return pid
        },
      }
    }),
    (fixture) =>
      Effect.promise(async () => {
        // Cooperative cleanup avoids signalling a PID which may have been recycled after a successful kill.
        await fs.writeFile(path.join(fixture.path, "stop"), "stop")
        const pids = await Promise.all([fixture.pid("parent").catch(() => 0), fixture.pid("child").catch(() => 0)])
        await waitFor(() => pids.every((pid) => !pid || !alive(pid)), 3000)
        await fs.rm(fixture.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      }),
  )
