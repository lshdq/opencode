import { Flag } from "@opencode/core/flag"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { TaskQueue } from "@opencode/core/task-queue"
import { ForbiddenError, InvalidRequestError, LocationNotFoundError, TaskQueueNotFoundError } from "@opencode/protocol/errors"
import type { ListQuery, StopPayload } from "@opencode/protocol/groups/task-queue"
import { Effect } from "effect"
import { HttpApiSchema } from "effect/http-api"
import { locationErrors } from "../location"

/**
 * `taskQueue.*` in the `server.experimental` group. Every route needs experimental.task_queue in the config of the
 * directory the queue runs in: a queue carries its own directory, so unlike schedules (which follow their Session's
 * location) the flag is read by providing that directory's location services here. Resolve aliases before gating
 * create/list so their config identity matches storage and every ID-based operation.
 */
export const makeTaskQueue = Effect.gen(function* () {
  const queues = yield* TaskQueue.Service
  const locations = yield* LocationServiceMap.Service

  const allowed = (directory: AbsolutePath) =>
    Effect.gen(function* () {
      const flags = yield* Flag.Service
      if (yield* flags.enabled("task_queue")) return
      return yield* new ForbiddenError({ message: disabledMessage })
    }).pipe(
      Effect.provide(locations.get(LocationServiceMap.canonical({ directory }))),
      locationErrors,
    )

  // Service errors cross the wire as protocol errors; InvalidError carries the state-machine refusals.
  const invalid = (error: TaskQueue.InvalidError) =>
    new InvalidRequestError({ message: error.message, kind: "task_queue" })
  const mapErrors = <A>(effect: Effect.Effect<A, TaskQueue.NotFoundError | TaskQueue.InvalidError>) =>
    effect.pipe(
      Effect.catchTags({
        "TaskQueue.NotFoundError": (error) => Effect.fail(missingQueue(error)),
        "TaskQueue.InvalidError": (error) => Effect.fail(invalid(error)),
      }),
    )

  // A queue whose directory is gone, or whose directory has the flag off, reads as not found, forbidden, or
  // location-not-found, like a schedule whose Session's location turned the flag off.
  const find = (id: TaskQueue.ID) =>
    queues.get(id).pipe(
      Effect.mapError(missingQueue),
      Effect.tap((info) => allowed(info.directory)),
    )

  return {
    create: (payload: TaskQueue.CreateInput) =>
      Effect.gen(function* () {
        const directory = yield* resolveDirectory(payload.directory)
        yield* allowed(directory)
        return { data: yield* queues.create({ ...payload, directory }).pipe(Effect.mapError(invalid)) }
      }),
    list: (query: ListQuery) =>
      Effect.gen(function* () {
        const directory = yield* resolveDirectory(query.directory)
        yield* allowed(directory)
        return { data: yield* queues.list({ directory }) }
      }),
    get: (id: TaskQueue.ID) => find(id).pipe(Effect.map((data) => ({ data }))),
    start: (id: TaskQueue.ID) =>
      Effect.gen(function* () {
        yield* find(id)
        return { data: yield* mapErrors(queues.start(id)) }
      }),
    heartbeat: (id: TaskQueue.ID) =>
      Effect.gen(function* () {
        yield* find(id)
        return { data: yield* mapErrors(queues.heartbeat(id)) }
      }),
    stop: (id: TaskQueue.ID, payload: StopPayload) =>
      Effect.gen(function* () {
        yield* find(id)
        return { data: yield* mapErrors(queues.stop(id, payload.reason)) }
      }),
    resume: (id: TaskQueue.ID) =>
      Effect.gen(function* () {
        yield* find(id)
        return { data: yield* mapErrors(queues.resume(id)) }
      }),
    remove: (id: TaskQueue.ID) =>
      Effect.gen(function* () {
        yield* find(id)
        yield* mapErrors(queues.remove(id))
        return HttpApiSchema.NoContent.make()
      }),
  }
})

const disabledMessage = "The task queue is disabled; set experimental.task_queue in config"

function resolveDirectory(directory: AbsolutePath) {
  return TaskQueue.canonicalDirectory(directory).pipe(
    Effect.mapError(() => new LocationNotFoundError({
      location: { directory },
      message: `Location not found: ${directory}`,
    })),
  )
}

function missingQueue(error: TaskQueue.NotFoundError) {
  return new TaskQueueNotFoundError({ queueID: error.queueID, message: `Task queue not found: ${error.queueID}` })
}
