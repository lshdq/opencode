import { glob, globSync, type GlobOptions } from "glob"
import { minimatch } from "minimatch"
import { readdir } from "node:fs"

export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
  }

  function toGlobOptions(options: Options): GlobOptions {
    return {
      cwd: options.cwd,
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      nodir: options.include !== "all",
    }
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    return glob(pattern, toGlobOptions(options)) as Promise<string[]>
  }

  // path-scurry turns readdir errors into empty directories. For instruction
  // discovery only, observe the callback used by glob's async walk and report
  // failures after it completes, without changing glob's matching behavior.
  export async function scanChecked(
    pattern: string,
    options: Options = {},
    read: NonNullable<NonNullable<GlobOptions["fs"]>["readdir"]> = readdir,
  ): Promise<string[]> {
    let failure: NodeJS.ErrnoException | undefined
    const matches = (await glob(pattern, {
      ...toGlobOptions(options),
      fs: {
        readdir: (path, options, callback) =>
          read(path, options, (error, entries) => {
            if (error && error.code !== "ENOENT" && error.code !== "ENOTDIR") failure ??= error
            callback(error, entries)
          }),
      },
    })) as string[]
    if (failure) throw failure
    return matches
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    return globSync(pattern, toGlobOptions(options)) as string[]
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
