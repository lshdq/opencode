import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261116060551_task_queue_fencing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`task_queue\` ADD \`owner_pid\` integer;`)
      yield* tx.run(`ALTER TABLE \`task_queue\` ADD \`run_id\` text;`)
      yield* tx.run(`ALTER TABLE \`task_queue\` ADD \`closing\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_queue_task\` ADD \`accepting\` integer DEFAULT false NOT NULL;`)
    })
  },
}

export default migration
