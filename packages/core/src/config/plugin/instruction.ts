export * as ConfigInstructionPlugin from "./instruction.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Document } from "@opencode/schema/config"
import { basename, dirname, isAbsolute, join, resolve } from "path"
import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Watcher } from "../../filesystem/watcher.js"
import { Config } from "../../config.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Instructions } from "../../instructions/index.js"
import { Location } from "../../location.js"

type Loaded =
  | { readonly type: "available"; readonly files: InstructionDiscovery.File[] }
  | { readonly type: "unavailable" }

export const Plugin = define({
  id: "opencode.config.instruction",
  effect: Effect.fn(function* (ctx) {
    const discovery = yield* InstructionDiscovery.Service
    // Nothing this plugin watches or loads can contribute when both scopes
    // are disabled; skip the resolves, the watcher fiber, and the transform.
    if (!discovery.project && !discovery.global) return
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const changes = yield* PubSub.sliding<string>(1)
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const globalFile = yield* fs.resolve(join(global.config, "AGENTS.md"))
      const loaded: { current: Loaded; configured: boolean } = {
        current: { type: "available", files: [] },
        configured: false,
      }
      const fixed = yield* FiberMap.make<string>()
      const configured = yield* FiberMap.make<string>()
      let matched = new Map<string, string[]>()

      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      const watch = (path: string, type: "file" | "directory", fibers: typeof fixed) =>
        watcher.subscribe({ path, type }).pipe(
          Effect.flatMap(Stream.runForEach(publish)),
          FiberMap.run(fibers, `${type}:${path}`, { onlyIfMissing: true, startImmediately: true }),
        )
      // The ancestor walk can reach the global file when the location sits
      // beneath the global config dir; global: false excludes it there too.
      const candidates = [
        ...(discovery.global ? [globalFile] : []),
        ...(project
          ? ancestorDirectories(start, stop)
              .map((directory) => join(directory, "AGENTS.md"))
              .filter((file) => discovery.global || file !== globalFile)
          : []),
      ]
      for (const path of new Set(candidates)) {
        yield* watch(path, "file", fixed)
      }

      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (path: string) {
        const content = yield* fs.readFileStringSafe(path)
        if (content !== undefined) return new InstructionDiscovery.File({ path, content })
        yield* Effect.logDebug("instruction file skipped", { path, reason: "unavailable" })
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* () {
        if (!discovery.global) return []
        const present = yield* fs.stat(globalFile).pipe(
          Effect.as(true),
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
        )
        if (!present) return []
        const file = yield* read(globalFile)
        return file ? [file] : Instructions.unavailable
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* () {
        if (!project) return []
        const walked = yield* Effect.forEach(yield* fs.up({ targets: ["AGENTS.md"], start, stop }), fs.resolve)
        const discovered = new Set(walked.filter((file) => discovery.global || file !== globalFile))
        const files = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
        if (files.some((file) => file === undefined)) return Instructions.unavailable
        return files.filter((file): file is InstructionDiscovery.File => file !== undefined)
      })

      const configSource = Effect.fn("ConfigInstructionPlugin.configSource")(function* () {
        const entries = (yield* config.entries()).filter(
          (entry): entry is Document =>
            entry.type === "document" &&
            (discovery.project ||
              !entry.path ||
              !FSUtil.contains(root, entry.path) ||
              FSUtil.contains(global.config, entry.path)),
        )
        const patterns = [...new Set(entries.flatMap((entry) => entry.info.instructions ?? []))].map((pattern) => {
          if (pattern.startsWith("https://") || pattern.startsWith("http://")) return { type: "remote" as const, pattern }
          const input = pattern.startsWith("~/") ? join(global.home, pattern.slice(2)) : pattern
          const absolute = isAbsolute(input)
          // V1 matches only the basename of absolute globs; relative patterns walk to the project root.
          const directories = absolute
            ? [dirname(input)]
            : !discovery.project
              ? [global.config]
              : project
                ? ancestorDirectories(start, root)
                : []
          return { type: "local" as const, pattern, glob: absolute ? basename(input) : input, directories }
        })
        loaded.configured = patterns.length > 0
        const files: InstructionDiscovery.File[] = []
        const plan = new Map<string, { path: string; type: "file" | "directory" }>()
        for (const source of patterns) {
          if (source.type !== "local") continue
          for (const directory of source.directories) {
            const target = resolve(directory, source.glob)
            const wildcard = /[*?\[\]{}]/.test(source.glob)
            // File watches handle literal creation; recursive watches handle new wildcard matches.
            let parent = wildcard ? directory : dirname(target)
            while (FSUtil.contains(directory, parent) && parent !== directory && !(yield* fs.isDir(parent))) {
              parent = dirname(parent)
            }
            if (yield* fs.isDir(parent)) {
              const path = parent === dirname(target) && !wildcard ? target : parent
              const type = parent === dirname(target) && !wildcard ? "file" : "directory"
              plan.set(`${type}:${path}`, { path, type })
            }
          }
        }
        for (const key of Array.from(configured, ([key]) => key)) {
          if (!plan.has(key)) yield* FiberMap.remove(configured, key)
        }
        for (const target of plan.values()) yield* watch(target.path, target.type, configured)

        const nextMatched = new Map<string, string[]>()
        for (const source of patterns) {
          if (source.type === "remote") {
            const url = URL.canParse(source.pattern) ? new URL(source.pattern) : undefined
            if (url) {
              url.username = ""
              url.password = ""
              url.search = ""
              url.hash = ""
            }
            const label = url?.toString() ?? "remote instruction"
            const content = yield* http.execute(HttpClientRequest.get(source.pattern)).pipe(
              Effect.flatMap((response) => response.text),
              Effect.timeout("5 seconds"),
              Effect.catchCause(() =>
                Effect.logWarning("failed to fetch configured instructions", { source: label }).pipe(
                  Effect.as(undefined),
                ),
              ),
            )
            if (content === undefined) return Instructions.unavailable
            files.push(
              new InstructionDiscovery.File({
                path: `instruction-url:sha256:${createHash("sha256").update(source.pattern).digest("hex")}`,
                label,
                content,
              }),
            )
            continue
          }

          for (const directory of source.directories) {
            const matches = yield* fs.scanChecked(source.glob, { cwd: directory, absolute: true, include: "file", dot: true })
            const bucket = `${source.pattern}\u0000${directory}`
            const paths = yield* Effect.forEach(matches.toSorted(), fs.resolve)
            // npm glob suppresses readdir errors. A missing former match is not a deletion
            // unless the file is absent AND its containing directory is traversable (or gone).
            for (const previous of matched.get(bucket) ?? []) {
              if (paths.includes(previous)) continue
              const exists = yield* fs.stat(previous).pipe(
                Effect.as(true),
                Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
              )
              if (exists) return Instructions.unavailable
              const directoryExists = yield* fs.stat(dirname(previous)).pipe(
                Effect.as(true),
                Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
              )
              if (directoryExists) yield* fs.readDirectoryEntries(dirname(previous))
            }
            nextMatched.set(bucket, paths)
            for (const path of paths) {
              const file = yield* read(path)
              if (!file) return Instructions.unavailable
              files.push(file)
            }
          }
        }
        matched = nextMatched
        return files
      })

      const isolate = <A, E, R>(source: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause(() =>
            Effect.logWarning("failed to load instruction source", { source }).pipe(
              Effect.as(Instructions.unavailable),
            ),
          ),
        )

      const refresh = Effect.fn("ConfigInstructionPlugin.refresh")(
        function* (file?: string) {
          const sources = yield* Effect.all({
            global: isolate("global", globalSource()),
            project: isolate("project", projectSource()),
            config: isolate("config", configSource()),
          })
          const next: Loaded =
            Array.isArray(sources.global) && Array.isArray(sources.project) && Array.isArray(sources.config)
              ? {
                  type: "available",
                  files: Array.from(
                    new Map(
                      [...sources.global, ...sources.project, ...sources.config].map((item) => [item.path, item]),
                    ).values(),
                  ),
                }
              : { type: "unavailable" }
          if (!isDeepStrictEqual(next, loaded.current)) {
            loaded.current = next
            yield* discovery.reload()
          }
          if (!file) return
          yield* Effect.logDebug("instructions rescanned", {
            file,
            instructions:
              loaded.current.type === "available" ? loaded.current.files.map((item) => item.path) : "unavailable",
          })
        },
        (effect, ..._args: [file?: string]) => lock.withPermit(effect),
      )

      // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
      // before debouncing so no update slips through while the debounce starts its pull.
      const updates = yield* PubSub.subscribe(changes)
      yield* Stream.fromSubscription(updates).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach((file) => refresh(file)),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() => refresh("config.updated")),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* refresh()
      yield* discovery.transform((editor) => {
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        for (const file of loaded.current.files) editor.add(file)
      })
      yield* discovery.onLoad(() => (loaded.configured ? refresh() : Effect.void))
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate instruction source", { cause }).pipe(
          Effect.andThen(discovery.transform((editor) => editor.unavailable())),
          Effect.asVoid,
        ),
      ),
    )
  }),
})

function ancestorDirectories(start: string, stop: string): string[] {
  if (start === stop) return [start]
  return [start, ...ancestorDirectories(dirname(start), stop)]
}
