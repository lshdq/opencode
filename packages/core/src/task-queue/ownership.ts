export * as TaskQueueOwnership from "./ownership.js"

import { eq } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { Database } from "../database/database.js"
import type { SessionSchema } from "../session/schema.js"
import type { SessionStore } from "../session/store.js"
import type { TaskQueue } from "@opencode/schema/task-queue"
import { TaskQueueTable, TaskQueueTaskTable } from "./sql.js"

/** Read the durable parent chain, not a process-local list of roots. Deleted queues stay fenced by their marker. */
export const find = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  store: Pick<SessionStore.Interface, "get">,
  sessionID: SessionSchema.ID,
) {
  const seen = new Set<SessionSchema.ID>()
  let current: SessionSchema.ID | undefined = sessionID
  let marked: SessionSchema.ID | undefined
  while (current && !seen.has(current)) {
    seen.add(current)
    const task = yield* db
      .select()
      .from(TaskQueueTaskTable)
      .where(eq(TaskQueueTaskTable.session_id, current))
      .get()
      .pipe(Effect.orDie)
    if (task) {
      const queue = yield* db
        .select()
        .from(TaskQueueTable)
        .where(eq(TaskQueueTable.id, task.queue_id))
        .get()
        .pipe(Effect.orDie)
      return { root: current, task, queue }
    }
    const session: SessionSchema.Info | undefined = yield* store.get(current)
    // Forks copy metadata but intentionally start a new top-level Session, not a task descendant.
    if (session?.fork && session.parentID === undefined) return undefined
    // Children inherit metadata. A marker is only a fallback after the entire parent chain was searched.
    if (session?.metadata?.source === "taskqueue") marked = current
    current = session?.parentID
  }
  return marked ? { root: marked, task: undefined, queue: undefined } : undefined
})

/** Also checked inside the coordinator's drain: a wake racing stop cannot bypass the durable fence. */
export const admitted = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  store: Pick<SessionStore.Interface, "get">,
  sessionID: SessionSchema.ID,
) {
  const owned = yield* find(db, store, sessionID)
  if (!owned) return true
  return (
    owned.queue?.status === "running" &&
    !owned.queue.closing &&
    owned.queue.owner_pid === process.pid &&
    owned.queue.run_id !== null &&
    owned.queue.lease_expires_at !== null &&
    owned.queue.lease_expires_at > (yield* Clock.currentTimeMillis) &&
    (owned.task?.status === "running" || (owned.queue.phase === "planning" && owned.task?.status === "planning")) &&
    owned.task.accepting
  )
})

/** A shutdown marker is not a clustered execution claim. Only the matching local run may reopen its fence. */
export const fence = (db: Database.Interface["db"], queueID: TaskQueue.ID) =>
  db
    .update(TaskQueueTaskTable)
    .set({ accepting: false })
    .where(eq(TaskQueueTaskTable.queue_id, queueID))
    .run()
    .pipe(Effect.orDie)
