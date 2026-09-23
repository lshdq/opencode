import { expect, spyOn } from "bun:test"
import { Effect, Fiber } from "effect"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { FileModeWindows } from "../../src/file-mode-windows.js"

// Fault injection only at the subprocess boundary: execute the entire real
// production script, then keep that same real host alive. FileMode is not mocked.
export async function interruptDuringACL<A, E>(
  root: string,
  operation: Effect.Effect<A, E>,
  select: (variables: NodeJS.ProcessEnv) => boolean = () => true,
) {
  const marker = path.join(root, "acl-host.pid")
  const closed = { value: false }
  const completed = { value: false }
  const execute = FileModeWindows.execute
  const observer = spyOn(FileModeWindows, "execute").mockImplementation(async (script, variables, options) => {
    if (!select(variables)) return execute(script, variables, options)
    try {
      return await execute(script + `
[System.IO.File]::WriteAllText($env:OPENCODE_ACL_TEST_PID, [string]$PID)
[System.Threading.Thread]::Sleep(60000)
`, { ...variables, OPENCODE_ACL_TEST_PID: marker }, options)
    } finally {
      closed.value = true
    }
  })
  const fiber = Effect.runFork(operation.pipe(Effect.tap(() => Effect.sync(() => { completed.value = true }))))
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await stat(marker).then(() => true, () => false)) break
      await Bun.sleep(25)
    }
    const pid = Number(await readFile(marker, "utf8"))
    expect(closed.value).toBe(false)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(closed.value).toBe(true)
    expect(completed.value).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
    observer.mockRestore()
  }
}
