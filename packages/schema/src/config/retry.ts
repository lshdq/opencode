export * as ConfigRetry from "./retry.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Retry")({
  max_delay: NonNegativeInt.pipe(optional).annotate({
    description: "Maximum local model retry backoff in seconds. Defaults to 30.",
  }),
}) {}
