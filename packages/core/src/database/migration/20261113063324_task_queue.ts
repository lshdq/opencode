import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261113063324_task_queue",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`task_queue\` (
          \`id\` text PRIMARY KEY,
          \`title\` text,
          \`directory\` text NOT NULL,
          \`status\` text DEFAULT 'queued' NOT NULL,
          \`reason\` text,
          \`owner_boot\` text,
          \`lease_expires_at\` integer,
          \`current_task_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`task_queue_task\` (
          \`id\` text PRIMARY KEY,
          \`queue_id\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`title\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`status\` text DEFAULT 'pending' NOT NULL,
          \`session_id\` text,
          \`rounds\` integer DEFAULT 0 NOT NULL,
          \`stalls\` integer DEFAULT 0 NOT NULL,
          \`reason\` text,
          \`summary\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_task_queue_task_queue_id_task_queue_id_fk\` FOREIGN KEY (\`queue_id\`) REFERENCES \`task_queue\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`task_queue_status_idx\` ON \`task_queue\` (\`status\`);`)
      yield* tx.run(`CREATE INDEX \`task_queue_directory_idx\` ON \`task_queue\` (\`directory\`);`)
      yield* tx.run(`CREATE INDEX \`task_queue_task_queue_idx\` ON \`task_queue_task\` (\`queue_id\`,\`position\`);`)
    })
  },
}

export default migration
