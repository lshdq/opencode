import { Effect } from "effect"
import path from "node:path"
import { Standalone } from "../../src/services/standalone"
import { OPENCODE_VERSION } from "../../src/version"

// Like standalone-owner.ts, but a private file gives the test the generated credential.
// Closing the control pipe releases the real Standalone scope; SIGKILL exercises its ownership pipe.
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const endpoint = yield* Standalone.start({
        command: [process.execPath, path.join(import.meta.dir, "../../src/index.ts"), "serve"],
      })
      yield* Effect.promise(() =>
        Bun.write(process.argv[2]!, JSON.stringify({
          id: "task-queue-fixture",
          version: OPENCODE_VERSION,
          pid: endpoint.pid,
          url: endpoint.url,
          password: endpoint.auth.password,
        })),
      )
      yield* Effect.callback<void>((resume) => {
        const close = () => resume(Effect.void)
        process.stdin.once("end", close)
        process.stdin.resume()
        return Effect.sync(() => {
          process.stdin.off("end", close)
          process.stdin.pause()
        })
      })
    }),
  ),
)
