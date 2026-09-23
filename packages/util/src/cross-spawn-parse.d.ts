declare module "cross-spawn/lib/parse.js" {
  import type { SpawnOptions } from "node:child_process"
  // cross-spawn is pinned to 7.0.6. Reuse its Windows PATH/PATHEXT/shebang/cmd escaping.
  export default function parse(
    command: string,
    args: string[],
    options: SpawnOptions,
  ): {
    command: string
    args: string[]
    options: SpawnOptions
  }
}
