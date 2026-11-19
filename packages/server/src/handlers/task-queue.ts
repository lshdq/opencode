import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { TaskQueue } from "@opencode/core/task-queue"
import { InvalidRequestError, LocationNotFoundError, TaskQueueNotFoundError } from "@opencode/protocol/errors"
import type { ListQuery, PlanPayload, StopPayload } from "@opencode/protocol/groups/task-queue"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import { Api } from "../api"
import { locationErrors } from "../location"

export const TaskQueueHandler = HttpApiBuilder.group(Api, "server.taskQueue", (handlers) =>
  Effect.gen(function* () {
    const taskQueue = yield* makeTaskQueue
    return handlers
      .handle("taskQueue.create", (ctx) => taskQueue.create(ctx.payload))
      .handle("taskQueue.list", (ctx) => taskQueue.list(ctx.query))
      .handle("taskQueue.get", (ctx) => taskQueue.get(ctx.params.queueID))
      .handle("taskQueue.start", (ctx) => taskQueue.start(ctx.params.queueID))
      .handle("taskQueue.plan", (ctx) => taskQueue.plan(ctx.params.queueID, ctx.payload))
      .handle("taskQueue.heartbeat", (ctx) => taskQueue.heartbeat(ctx.params.queueID))
      .handle("taskQueue.stop", (ctx) => taskQueue.stop(ctx.params.queueID, ctx.payload))
      .handle("taskQueue.resume", (ctx) => taskQueue.resume(ctx.params.queueID))
      .handle("taskQueue.delete", (ctx) => taskQueue.remove(ctx.params.queueID))
  }),
)

export const makeTaskQueue = Effect.gen(function* () {
  const queues = yield* TaskQueue.Service
  const locations = yield* LocationServiceMap.Service

  // Keep location validation (including non-directory paths) after removing the feature gate.
  const ensureLocation = (directory: AbsolutePath) =>
    Effect.void.pipe(
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

  // ID-based operations still validate the queue's own location, not the caller's current directory.
  const find = (id: TaskQueue.ID) =>
    queues.get(id).pipe(
      Effect.mapError(missingQueue),
      Effect.tap((info) => resolveDirectory(info.directory).pipe(Effect.flatMap(ensureLocation))),
    )

  return {
    create: (payload: TaskQueue.CreateInput) =>
      Effect.gen(function* () {
        const directory = yield* resolveDirectory(payload.directory)
        yield* ensureLocation(directory)
        return { data: yield* queues.create({ ...payload, directory }).pipe(Effect.mapError(invalid)) }
      }),
    list: (query: ListQuery) =>
      Effect.gen(function* () {
        const directory = yield* resolveDirectory(query.directory)
        yield* ensureLocation(directory)
        return { data: yield* queues.list({ directory }) }
      }),
    get: (id: TaskQueue.ID) => find(id).pipe(Effect.map((data) => ({ data }))),
    start: (id: TaskQueue.ID) =>
      Effect.gen(function* () {
        yield* find(id)
        return { data: yield* mapErrors(queues.start(id)) }
      }),
    plan: (id: TaskQueue.ID, payload: PlanPayload) => Effect.gen(function* () {
      yield* find(id)
      return { data: yield* mapErrors(queues.plan(id, payload.taskID)) }
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
