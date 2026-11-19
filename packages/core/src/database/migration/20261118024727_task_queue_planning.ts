import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261118024727_task_queue_planning",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`task_queue\` ADD \`workflow_version\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_queue\` ADD \`phase\` text DEFAULT 'execution' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`task_queue\` ADD \`snapshot\` text;`)
      yield* tx.run(`ALTER TABLE \`task_queue_task\` ADD \`plan\` text;`)
    })
  },
}

export default migration
