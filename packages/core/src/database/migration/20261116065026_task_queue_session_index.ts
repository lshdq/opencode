import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261116065026_task_queue_session_index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE INDEX \`task_queue_task_session_idx\` ON \`task_queue_task\` (\`session_id\`);`)
    })
  },
}

export default migration
