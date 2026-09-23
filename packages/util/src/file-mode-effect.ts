export * as FileModeEffect from "./file-mode-effect.js"

import { Cause, Effect } from "effect"

/** Unlike tryPromise, cancellation owns and joins the pending permission job.
 * Only cleanup is uninterruptible; the actual OS operation remains cancellable.
 */
export function run<A>(operation: (signal: AbortSignal) => Promise<A>) {
  return Effect.callback<A, Cause.UnknownError>((resume) => {
    const controller = new AbortController()
    const pending = Promise.resolve().then(() => operation(controller.signal))
    pending.then(
      (value) => resume(Effect.succeed(value)),
      (cause) => resume(Effect.fail(new Cause.UnknownError(
        cause,
        cause instanceof Error ? cause.message : "File permission operation failed",
      ))),
    )
    return Effect.promise(() => {
      controller.abort()
      return pending.then(() => {}, () => {})
    }).pipe(Effect.uninterruptible)
  })
}
