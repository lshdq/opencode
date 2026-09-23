import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"

export function databasePath(data: string) {
  const filename =
    process.env.OPENCODE_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}

export function databaseOptions(data: string) {
  return {
    path: databasePath(data),
    // Only the default location is application-owned. An explicit override
    // must already be private; its parent is never permission-modified.
    privateDirectory: process.env.OPENCODE_DB === undefined,
  }
}
