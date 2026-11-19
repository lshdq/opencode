import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { AbsolutePath } from "@opencode/schema/schema"
import type { TaskQueue } from "@opencode/schema/task-queue"
import { Timestamps } from "../database/schema.sql.js"
import type { SessionSchema } from "../session/schema.js"

export const TaskQueueTable = sqliteTable(
  "task_queue",
  {
    id: text().$type<TaskQueue.ID>().primaryKey(),
    title: text(),
    directory: text().$type<AbsolutePath>().notNull(),
    status: text().$type<TaskQueue.Status>().notNull().default("queued"),
    workflow_version: integer().notNull().default(1),
    phase: text().$type<TaskQueue.Phase>().notNull().default("execution"),
    snapshot: text().$type<AbsolutePath>(),
    reason: text(),
    /** The service instance driving this queue. A different boot alone is never evidence of death. */
    owner_boot: text(),
    owner_pid: integer(),
    /** Fresh on every explicit start/resume; fences all scheduler writes from an older run. */
    run_id: text(),
    /** Remains running (and holds the directory slot) until the whole task tree is idle. */
    closing: integer({ mode: "boolean" }).notNull().default(false),
    /** Heartbeat lease: the watchdog stops the queue once this passes while unextended. */
    lease_expires_at: integer(),
    current_task_id: text().$type<TaskQueue.TaskID>(),
    ...Timestamps,
  },
  (table) => [
    index("task_queue_status_idx").on(table.status),
    index("task_queue_directory_idx").on(table.directory),
  ],
)

export const TaskQueueTaskTable = sqliteTable(
  "task_queue_task",
  {
    id: text().$type<TaskQueue.TaskID>().primaryKey(),
    queue_id: text()
      .$type<TaskQueue.ID>()
      .notNull()
      .references(() => TaskQueueTable.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    title: text().notNull(),
    prompt: text().notNull(),
    status: text().$type<TaskQueue.TaskStatus>().notNull().default("pending"),
    session_id: text().$type<SessionSchema.ID>(),
    accepting: integer({ mode: "boolean" }).notNull().default(false),
    rounds: integer().notNull().default(0),
    /** Rounds in a row without progress; internal stall detection, not part of the public Task. */
    stalls: integer().notNull().default(0),
    reason: text(),
    summary: text(),
    plan: text({ mode: "json" }).$type<TaskQueue.Plan>(),
    ...Timestamps,
  },
  (table) => [
    index("task_queue_task_queue_idx").on(table.queue_id, table.position),
    index("task_queue_task_session_idx").on(table.session_id),
  ],
)
