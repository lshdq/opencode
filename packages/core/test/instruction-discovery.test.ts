import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Logger, PubSub, Stream } from "effect"
import fs from "fs/promises"
import { readdir } from "node:fs"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { ConfigInstructionPlugin } from "@opencode/core/config/plugin/instruction"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Document, Info } from "@opencode/schema/config"
import { Event } from "@opencode/schema/event"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionSchema } from "@opencode/core/session/schema"
import { InstructionStateTable, SessionTable } from "@opencode/core/session/sql"
import { Instructions } from "@opencode/core/instructions/index"
import { FSUtil } from "@opencode/util/fs-util"
import { Glob } from "@opencode/util/glob"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { httpClient } from "@opencode/util/effect/app-node-platform"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { readInitial, readUpdate, state } from "./lib/instructions"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  config?: string
  home?: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
  watcherLayer?: Layer.Layer<Watcher.Service | Watcher.Test>
  project?: boolean
  configEntries?: Document[]
}) => {
  const watcher = input.watcherLayer ?? Watcher.testLayer
  return Layer.mergeAll(
    AppNodeBuilder.build(
       LayerNode.group([
         InstructionDiscovery.node,
         Bus.node,
         FSUtil.node,
         Global.node,
         Location.node,
         Watcher.node,
         httpClient,
       ]),
      [
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: input.project })),
        Global.node.replace(
          input.config || input.home
            ? Global.layerWith({
                ...(input.config ? { config: input.config } : {}),
                ...(input.home ? { home: input.home } : {}),
              })
            : tempGlobalLayer,
        ),
        Location.node.replace(input.locationServiceLayer),
        Watcher.node.replace(watcher),
        ...(input.filesystemLayer ? [FSUtil.node.replace(input.filesystemLayer)] : []),
      ],
    ),
    watcher,
    Config.testLayer(input.configEntries),
  )
}

const start = Effect.fnUntraced(function* () {
  yield* ConfigInstructionPlugin.Plugin.effect(host())
  return yield* InstructionDiscovery.Service
})

const file = (path: string, content: string) =>
  new InstructionDiscovery.File({ path: AbsolutePath.make(path), content })

function emitAndWait(update: Watcher.Update) {
  return Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const bus = yield* Bus.Service
    const updated = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* watcher.emit(update)
    yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  })
}

describe("InstructionDiscovery", () => {
  it.effect("stores ordered values with last-write-wins precedence", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "first"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
        editor.add(file("/repo/AGENTS.md", "last"))
        editor.update("/repo/packages/AGENTS.md", (current) => {
          current.content = "updated"
          current.path = AbsolutePath.make("/ignored")
        })
        editor.remove("/missing")
      })

      expect(yield* discovery.list()).toEqual([
        file("/repo/AGENTS.md", "last"),
        file("/repo/packages/AGENTS.md", "updated"),
      ])
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))),
  )

  it.effect("preserves admitted values while the source is unavailable", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => editor.unavailable())
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))),
  )

  it.effect("renders granular instruction updates", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/global/AGENTS.md", "global"))
        editor.add(
          file("/repo/AGENTS.md", ["old", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")),
        )
      })
      const initial = yield* readInitial(yield* discovery.load())

      yield* discovery.transform((editor) => {
        editor.update("/repo/AGENTS.md", (current) => {
          current.content = ["new", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")
        })
      })
      const modified = (yield* readUpdate(yield* discovery.load(), initial)).text
      expect(modified).toContain("The instructions from /repo/AGENTS.md changed. Here's the diff:")
      expect(modified).toContain("-old\n+new")
      expect(modified).not.toContain("global")

      const rewritten = state({
        "core/instructions": [{ path: "/repo/AGENTS.md", content: "old one\nold two\nold three\nold four" }],
      })
      yield* discovery.transform((editor) => {
        editor.remove("/global/AGENTS.md")
        editor.update("/repo/AGENTS.md", (current) => {
          current.content = "new"
        })
      })
      expect((yield* readUpdate(yield* discovery.load(), rewritten)).text).toBe(
        "The instructions changed:\nInstructions from: /repo/AGENTS.md\nnew",
      )

      yield* discovery.transform((editor) => {
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })
      const structural = (yield* readUpdate(yield* discovery.load(), initial)).text
      expect(structural).toContain("The instructions from /global/AGENTS.md no longer apply.")
      expect(structural).toContain("New instructions apply from:\nInstructions from: /repo/packages/AGENTS.md\npackage")
      expect(structural).not.toContain("Instructions from: /global/AGENTS.md\nglobal")
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))),
  )
})

describe("ConfigInstructionPlugin.Plugin", () => {
  it.live("loads relative glob near to far, absolute glob, and home paths without duplicating AGENTS.md", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "config")
        const home = path.join(tmp.path, "home")
        const project = path.join(tmp.path, "repo")
        const directory = path.join(project, "nested")
        const near = path.join(directory, ".opencode", "AGENTS.md")
        const far = path.join(project, ".opencode", "AGENTS.md")
        const absolute = path.join(tmp.path, "extra", "rule.md")
        const homeFile = path.join(home, "home.md")
        const agent = path.join(project, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await Promise.all([near, far, absolute, homeFile, agent].map((file) => fs.mkdir(path.dirname(file), { recursive: true })))
            await Promise.all(
              [near, far, absolute, homeFile, agent].map((file, index) => fs.writeFile(file, `rule ${index}`)),
            )
          })
          const discovery = yield* start()
          const initial = yield* readInitial(yield* discovery.load())
          const files = yield* discovery.list()
          if (!Array.isArray(files)) throw new Error("Instruction source unexpectedly unavailable")
          expect(files.map((item) => item.path)).toEqual([agent, near, far, absolute, homeFile])
          expect(initial.text).toContain(`Instructions from: ${near}\nrule 0`)
          expect(initial.text).toContain(`Instructions from: ${far}\nrule 1`)

          yield* Effect.promise(() => fs.writeFile(near, "updated"))
          const update = yield* readUpdate(yield* discovery.load(), initial)
          expect(update.text).toContain(`Instructions from: ${near}\nupdated`)
          yield* Effect.promise(() => fs.rm(near))
          expect((yield* readUpdate(yield* discovery.load(), initial)).text).toContain(
            `The instructions from ${near} no longer apply.`,
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: global,
              home,
              configEntries: [
                new Document({
                  type: "document",
                  info: new Info({
                    instructions: [".opencode/AGENTS.md", path.join(tmp.path, "extra", "*.md"), "~/home.md", agent],
                  }),
                }),
              ],
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location({ directory: AbsolutePath.make(directory) }, { projectDirectory: AbsolutePath.make(project) }),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("refreshes HTTP instructions at the model boundary and retains the last value on failure", () =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const response = { value: "original", fail: false }
        const server = Bun.serve({
          port: 0,
          fetch: () => new Response(response.fail ? "unavailable" : response.value, { status: response.fail ? 503 : 200 }),
        })
        return { response, server }
      }),
      ({ server }) => Effect.promise(() => server.stop()),
    ).pipe(
      Effect.flatMap(({ response, server }) =>
        Effect.gen(function* () {
          const discovery = yield* start()
          const initial = yield* readInitial(yield* discovery.load())
          expect(initial.text).toContain(`Instructions from: http://127.0.0.1:${server.port}/rules\noriginal`)
          response.value = "new"
          expect((yield* readUpdate(yield* discovery.load(), initial)).text).toContain("new")
          const updated = yield* readInitial(yield* discovery.load())
          expect(updated.text).toContain(`Instructions from: http://127.0.0.1:${server.port}/rules\nnew`)
          response.fail = true
          expect((yield* readUpdate(yield* discovery.load(), updated)).changed).toBe(false)
          response.fail = false
          expect((yield* readUpdate(yield* discovery.load(), updated)).changed).toBe(false)
        }).pipe(
          Effect.provide(
            instructionLayer({
              configEntries: [
                new Document({
                  type: "document",
                  info: new Info({ instructions: [`http://127.0.0.1:${server.port}/rules`] }),
                }),
              ],
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make("/no-project") })),
              ),
            }),
          ),
        ),
      ),
    ),
  )

  it.live("uses the full signed URL for requests but never exposes credentials in source state or rendered changes", () =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const response = { value: "original", fail: false }
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            requests.push(request.url)
            return new Response(response.value, { status: response.fail ? 503 : 200 })
          },
        })
        return { requests, response, server }
      }),
      ({ server }) => Effect.promise(() => server.stop()),
    ).pipe(
      Effect.flatMap(({ requests, response, server }) => {
        const token = "private-token-9876"
        const fragment = "private-fragment-4321"
        const url = `http://127.0.0.1:${server.port}/rules?token=${token}#${fragment}`
        const other = `http://127.0.0.1:${server.port}/rules?token=another-private-token#other-private-fragment`
        const visible = `http://127.0.0.1:${server.port}/rules`
        const logs: string[] = []
        return Effect.gen(function* () {
          const discovery = yield* start()
          const initial = yield* readInitial(yield* discovery.load())
          // HTTP never transmits fragments; the distinct full configured URLs still identify separate sources.
          expect(requests).toContain(url.split("#")[0])
          expect(requests).toContain(other.split("#")[0])
          expect(initial.values["core/instructions"]).toHaveLength(2)
          expect(initial.text).toBe(`Instructions from: ${visible}\noriginal\n\nInstructions from: ${visible}\noriginal`)
          expect(JSON.stringify(initial)).not.toContain("token")
          expect(JSON.stringify(initial)).not.toContain("fragment")
          expect(JSON.stringify(yield* discovery.list())).not.toContain("token")
          const sources = yield* discovery.list()
          if (!Array.isArray(sources)) throw new Error("Signed URL sources unexpectedly unavailable")
          expect(new Set(sources.map((item) => item.path)).size).toBe(2)
          expect(sources.every((item) => item.path.startsWith("instruction-url:sha256:"))).toBe(true)

          response.value = "updated"
          const changed = yield* readUpdate(yield* discovery.load(), initial)
          expect(changed.text).toContain(`Instructions from: ${visible}\nupdated`)
          expect(JSON.stringify(changed)).not.toContain("token")
          expect(JSON.stringify(changed)).not.toContain("fragment")

          response.value = ["before", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")
          const longBase = yield* readInitial(yield* discovery.load())
          response.value = response.value.replace("before", "after")
          const diff = yield* readUpdate(yield* discovery.load(), longBase)
          expect(diff.text).toContain(`${visible} changed. Here's the diff:`)
          for (const secret of ["token", "fragment", "private"]) expect(JSON.stringify(diff)).not.toContain(secret)

          const config = yield* Config.Test
          yield* config.setEntries([new Document({ type: "document", info: new Info({ instructions: [url] }) })])
          const removed = yield* readUpdate(yield* discovery.load(), initial)
          expect(removed.text).toContain(`The instructions from ${visible} no longer apply.`)
          expect(JSON.stringify(removed)).not.toContain("token")
          expect(JSON.stringify(removed)).not.toContain("fragment")

          response.fail = true
          expect((yield* readUpdate(yield* discovery.load(), state(removed.values))).changed).toBe(false)
          expect(logs.join("\n")).toContain("failed to fetch configured instructions")
          expect(logs.join("\n")).not.toContain("token")
          expect(logs.join("\n")).not.toContain("fragment")
          expect(logs.join("\n")).not.toContain("private")
          response.fail = false
          yield* config.setEntries([
            new Document({
              type: "document",
              info: new Info({ instructions: [`http://alice:supersecret@127.0.0.1:${server.port}/rules?token=${token}#${fragment}`] }),
            }),
          ])
          const userinfo = yield* readUpdate(yield* discovery.load(), state(removed.values))
          expect(userinfo.changed).toBe(true)
          expect(userinfo.text).toContain(`Instructions from: ${visible}`)
          expect(JSON.stringify(userinfo)).not.toContain("alice")
          expect(JSON.stringify(userinfo)).not.toContain("supersecret")
          expect(JSON.stringify(userinfo)).not.toContain("token")
          expect(JSON.stringify(userinfo)).not.toContain("fragment")
          response.fail = true
          expect((yield* readUpdate(yield* discovery.load(), state(userinfo.values))).changed).toBe(false)
          expect(logs.join("\n")).not.toContain("alice")
          expect(logs.join("\n")).not.toContain("supersecret")
          expect(logs.join("\n")).not.toContain("fragment")
          response.fail = false
          yield* config.setEntries([])
          expect((yield* readUpdate(yield* discovery.load(), initial)).text).toBe(
            "Previously loaded instructions no longer apply.",
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              configEntries: [new Document({ type: "document", info: new Info({ instructions: [url, other] }) })],
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make("/no-project") })),
              ),
            }),
          ),
          Effect.provide(Logger.layer([Logger.make((options) => logs.push(Logger.formatSimple.log(options)))])),
        )
      }),
    ),
  )

  it.live("loads a URL containing userinfo without sending Basic auth or exposing the initial source", () =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const authorizations: string[] = []
        const server = Bun.serve({
          port: 0,
          fetch: (request) => {
            requests.push(request.url)
            authorizations.push(request.headers.get("authorization") ?? "")
            return new Response("PRIVATE_REMOTE_RULE")
          },
        })
        return { requests, authorizations, server }
      }),
      ({ server }) => Effect.promise(() => server.stop()),
    ).pipe(
      Effect.flatMap(({ requests, authorizations, server }) => {
        const url = `http://fixture-user:fixture-password@127.0.0.1:${server.port}/rules?token=fixture-token#fixture-fragment`
        return Effect.gen(function* () {
          const discovery = yield* start()
          const initial = yield* readInitial(yield* discovery.load())
          expect(initial.text).toContain(`Instructions from: http://127.0.0.1:${server.port}/rules\nPRIVATE_REMOTE_RULE`)
          expect(requests).toContain(`http://127.0.0.1:${server.port}/rules?token=fixture-token`)
          expect(authorizations).toEqual(requests.map(() => ""))
          for (const secret of ["fixture-user", "fixture-password", "fixture-token", "fixture-fragment"]) {
            expect(JSON.stringify(initial)).not.toContain(secret)
          }
        }).pipe(
          Effect.provide(
            instructionLayer({
              configEntries: [new Document({ type: "document", info: new Info({ instructions: [url] }) })],
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make("/no-project") })),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.effect("redacts userinfo and query strings in legacy source diffs", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      const previousContent = ["before", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")
      const previous = state({
        "core/instructions": [
          { path: "https://alice:secret@example.com/rules?token=old#private-fragment", content: previousContent },
        ],
      })
      yield* discovery.transform((editor) =>
        editor.add(
          new InstructionDiscovery.File({
            path: "https://alice:secret@example.com/rules?token=old#private-fragment",
            content: previousContent.replace("before", "after"),
          }),
        ),
      )
      const patch = (yield* readUpdate(yield* discovery.load(), previous)).text
      expect(patch).toContain("https://example.com/rules changed. Here's the diff:")
      expect(patch).not.toContain("alice")
      expect(patch).not.toContain("secret")
      expect(patch).not.toContain("token")
      expect(patch).not.toContain("private-fragment")
      yield* discovery.transform((editor) => {
        editor.remove("https://alice:secret@example.com/rules?token=old#private-fragment")
        editor.add(
          new InstructionDiscovery.File({
            path: "https://alice:secret@example.com/rules?token=new#new-private-fragment",
            content: "after",
          }),
        )
      })
      const update = yield* readUpdate(yield* discovery.load(), previous)
      expect(update.text).toContain("https://example.com/rules")
      expect(update.text).not.toContain("alice")
      expect(update.text).not.toContain("secret")
        expect(update.text).not.toContain("token")
      expect(update.text).not.toContain("private-fragment")
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))),
  )

  it.live("rebuilds instructions when a config document changes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first.md")
          const second = path.join(tmp.path, "second.md")
          yield* Effect.promise(() => Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")]))
          const changes = yield* PubSub.unbounded<{
            id: ReturnType<typeof Event.ID.create>
            created: number
            type: "config.updated"
            data: Record<string, never>
          }>()
          yield* ConfigInstructionPlugin.Plugin.effect(host({ event: { subscribe: () => Stream.fromPubSub(changes) } }))
          const discovery = yield* InstructionDiscovery.Service
          const config = yield* Config.Test
          const initial = yield* readInitial(yield* discovery.load())
          expect(initial.text).toBe(`Instructions from: ${first}\nfirst`)
          const bus = yield* Bus.Service
          const updated = yield* Deferred.make<void>()
          const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
            Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
            Effect.forkScoped,
          )
          yield* Effect.yieldNow
          yield* config.setEntries([new Document({ type: "document", info: new Info({ instructions: [second] }) })])
          yield* PubSub.publish(changes, {
            id: Event.ID.create(),
            created: Date.now(),
            type: "config.updated",
            data: {},
          })
          yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
          yield* Fiber.interrupt(fiber)
          expect((yield* readUpdate(yield* discovery.load(), initial)).text).toContain(
            `The instructions from ${first} no longer apply.`,
          )
          expect((yield* readUpdate(yield* discovery.load(), initial)).text).toContain(
            `Instructions from: ${second}\nsecond`,
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              configEntries: [
                new Document({ type: "document", info: new Info({ instructions: [path.join(tmp.path, "first.md")] }) }),
              ],
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            }),
          ),
        ),
      ),
    ),
  )

  // TC-004: The first request can precede creation of a configured literal file.
  // Later requests must discover it, observe edits/removal, and accept a re-created file.
  it.live("tracks a configured literal through creation, edits, deletion, and re-creation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const rule = path.join(tmp.path, "instructions.md")
          const discovery = yield* start()
          const empty = yield* readInitial(yield* discovery.load())
          expect(empty.text).toBe("")

          yield* Effect.promise(() => fs.writeFile(rule, "created"))
          const created = yield* readInitial(yield* discovery.load())
          expect(created.text).toBe(`Instructions from: ${rule}\ncreated`)

          yield* Effect.promise(() => fs.writeFile(rule, "edited"))
          expect((yield* readUpdate(yield* discovery.load(), created)).text).toContain(
            `Instructions from: ${rule}\nedited`,
          )
          yield* Effect.promise(() => fs.rm(rule))
          expect((yield* readUpdate(yield* discovery.load(), created)).text).toBe(
            "Previously loaded instructions no longer apply.",
          )

          yield* Effect.promise(() => fs.writeFile(rule, "re-created"))
          expect((yield* readInitial(yield* discovery.load())).text).toBe(
            `Instructions from: ${rule}\nre-created`,
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "config"),
              configEntries: [new Document({ type: "document", info: new Info({ instructions: ["instructions.md"] }) })],
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            }),
          ),
        ),
      ),
    ),
  )

  it.live("keeps prior glob matches when scanning silently misses a present file or its directory cannot be read", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const directory = path.join(tmp.path, "rules")
        const rule = path.join(directory, "rule.md")
        const failure = { empty: false, unreadable: false }
        const filesystemLayer = Layer.effect(
          FSUtil.Service,
          FSUtil.Service.pipe(
            Effect.map((fs) =>
              FSUtil.Service.of({
                ...fs,
                scanChecked: (pattern, options) => (failure.empty ? Effect.succeed([]) : fs.scanChecked(pattern, options)),
                readDirectoryEntries: (dir) =>
                  failure.unreadable && dir === directory
                    ? Effect.fail(new FSUtil.FileSystemError({ method: "readDirectoryEntries" }))
                    : fs.readDirectoryEntries(dir),
              }),
            ),
          ),
        ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(directory))
          yield* Effect.promise(() => fs.writeFile(rule, "important rule"))
          const discovery = yield* start()
          const initial = yield* readInitial(yield* discovery.load())
          expect(initial.text).toBe(`Instructions from: ${rule}\nimportant rule`)

          failure.empty = true
          expect((yield* readUpdate(yield* discovery.load(), initial)).changed).toBe(false)
          yield* Effect.promise(() => fs.rm(rule))
          failure.unreadable = true
          expect((yield* readUpdate(yield* discovery.load(), initial)).changed).toBe(false)
          failure.unreadable = false
          expect((yield* readUpdate(yield* discovery.load(), initial)).text).toBe(
            "Previously loaded instructions no longer apply.",
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              filesystemLayer,
              config: path.join(tmp.path, "global"),
              configEntries: [new Document({ type: "document", info: new Info({ instructions: ["rules/*.md"] }) })],
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("keeps a persisted rule on a fresh plugin when glob swallows a directory read failure", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const directory = path.join(tmp.path, "rules")
        const rule = path.join(directory, "rule.md")
        const denied = { value: true, calls: 0 }
        const configEntries = [new Document({ type: "document", info: new Info({ instructions: ["rules/*.md"] }) })]
        const locationServiceLayer = Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
        )
        const filesystemLayer = Layer.effect(
          FSUtil.Service,
          FSUtil.Service.pipe(
            Effect.map((fs) =>
              FSUtil.Service.of({
                ...fs,
                scanChecked: (pattern, options) =>
                  Effect.tryPromise({
                    try: () =>
                      Glob.scanChecked(pattern, options, (dir, opts, callback) => {
                        if (dir === directory && denied.value) {
                          denied.calls++
                          callback(Object.assign(new Error("simulated readdir denial"), { code: "EACCES" }))
                          return
                        }
                        readdir(dir, opts, callback)
                      }),
                    catch: (cause) => new FSUtil.FileSystemError({ method: "glob", cause }),
                  }),
              }),
            ),
          ),
        ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(directory))
          yield* Effect.promise(() => fs.writeFile(rule, "durable rule"))
          const previous = yield* Effect.scoped(
            Effect.gen(function* () {
              const discovery = yield* start()
              return yield* readInitial(yield* discovery.load())
            }).pipe(Effect.provide(instructionLayer({ configEntries, locationServiceLayer }))),
          )
          expect(previous.text).toBe(`Instructions from: ${rule}\ndurable rule`)

          yield* Effect.scoped(
            Effect.gen(function* () {
              const discovery = yield* start()
              expect(denied.calls).toBeGreaterThan(0)
              expect(Array.isArray(yield* discovery.list())).toBe(false)
              expect((yield* readUpdate(yield* discovery.load(), state(previous.values))).changed).toBe(false)
              denied.value = false
              expect((yield* readUpdate(yield* discovery.load(), state(previous.values))).changed).toBe(false)
              yield* Effect.promise(() => fs.rm(rule))
              expect((yield* readUpdate(yield* discovery.load(), state(previous.values))).text).toBe(
                "Previously loaded instructions no longer apply.",
              )
            }).pipe(Effect.provide(instructionLayer({ configEntries, locationServiceLayer, filesystemLayer }))),
          )
        })
      }),
    ),
  )

  // TC-004 / DEC-008: A real projected Session row survives plugin teardown.
  // The next plugin's first glob scan fails before it has any in-memory match history.
  it.live("keeps a durable Session rule across a cold plugin scan failure and only removes it after confirmed deletion", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const directory = path.join(tmp.path, "rules")
        const rule = path.join(directory, "rule.md")
        const denied = { value: true, calls: 0 }
        const sessionID = SessionSchema.ID.make("ses_glob_cold_durable")
        const configEntries = [new Document({ type: "document", info: new Info({ instructions: ["rules/*.md"] }) })]
        const locationServiceLayer = Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
        )
        const filesystemLayer = Layer.effect(
          FSUtil.Service,
          FSUtil.Service.pipe(
            Effect.map((fs) =>
              FSUtil.Service.of({
                ...fs,
                scanChecked: (pattern, options) =>
                  Effect.tryPromise({
                    try: () =>
                      Glob.scanChecked(pattern, options, (dir, opts, callback) => {
                        if (dir === directory && denied.value) {
                          denied.calls++
                          callback(Object.assign(new Error("simulated readdir denial"), { code: "EACCES" }))
                          return
                        }
                        readdir(dir, opts, callback)
                      }),
                    catch: (cause) => new FSUtil.FileSystemError({ method: "glob", cause }),
                  }),
              }),
            ),
          ),
        ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(directory))
          yield* Effect.promise(() => fs.writeFile(rule, "durable rule"))
          const { db } = yield* Database.Service
          const bus = yield* Bus.Service
          yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(tmp.path), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
          yield* db.insert(SessionTable).values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: "glob-cold-durable",
            directory: tmp.path,
            title: "Glob cold-start test",
            version: "test",
          }).run().pipe(Effect.orDie)

          yield* Effect.scoped(
            Effect.gen(function* () {
              const discovery = yield* start()
              yield* InstructionState.prepare(db, bus, yield* discovery.load(), sessionID)
            }).pipe(Effect.provide(instructionLayer({ configEntries, locationServiceLayer }))),
          )
          const stored = yield* db.select().from(InstructionStateTable).get().pipe(Effect.orDie)
          expect(stored?.current_values["core/instructions"]).toBeDefined()

          yield* Effect.scoped(
            Effect.gen(function* () {
              const discovery = yield* start()
              expect(denied.calls).toBeGreaterThan(0)
              const failed = yield* discovery.load()
              expect(yield* InstructionState.preview(db, sessionID, failed, yield* Instructions.read(failed))).toEqual({
                initial: `Instructions from: ${rule}\ndurable rule`,
                update: "",
              })
              yield* InstructionState.prepare(db, bus, failed, sessionID)
              expect((yield* db.select().from(InstructionStateTable).get().pipe(Effect.orDie))?.current_values).toEqual(stored?.current_values)

              denied.value = false
              yield* Effect.promise(() => fs.writeFile(rule, "recovered rule"))
              const recovered = yield* discovery.load()
              const preview = yield* InstructionState.preview(db, sessionID, recovered, yield* Instructions.read(recovered))
              expect(preview.update).toContain("recovered rule")
              yield* InstructionState.prepare(db, bus, recovered, sessionID)
              yield* Effect.promise(() => fs.rm(rule))
              const removed = yield* discovery.load()
              expect((yield* InstructionState.preview(db, sessionID, removed, yield* Instructions.read(removed))).update).toBe(
                "Previously loaded instructions no longer apply.",
              )
              yield* InstructionState.prepare(db, bus, removed, sessionID)
              expect((yield* db.select().from(InstructionStateTable).get().pipe(Effect.orDie))?.current_values).toEqual({})
            }).pipe(Effect.provide(instructionLayer({ configEntries, locationServiceLayer, filesystemLayer }))),
          )
        })
      }),
      Effect.provide(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node]), [
        Bus.node.replace(Bus.configured({ persist: true })),
      ])),
    ),
  )

  it.live("bounds live config watcher subscriptions across repeated path replacements", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const active = { count: 0, peak: 0 }
        const scans = { count: 0 }
        const filesystemLayer = Layer.effect(
          FSUtil.Service,
          FSUtil.Service.pipe(
            Effect.map((fs) =>
              FSUtil.Service.of({
                ...fs,
                scanChecked: (pattern, options) => fs.scanChecked(pattern, options).pipe(Effect.tap(() => Effect.sync(() => scans.count++))),
              }),
            ),
          ),
        ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
        const watcherLayer = Layer.effectContext(
          Effect.gen(function* () {
            const context = yield* Layer.build(Watcher.testLayer)
            const watcher = Context.get(context, Watcher.Test)
            return Context.add(
              context,
              Watcher.Service,
              Watcher.Service.of({
                subscribe: (input, ready) =>
                  watcher.subscribe(input, ready).pipe(
                    Effect.map((stream) =>
                      Stream.unwrap(
                        Effect.sync(() => {
                          active.count++
                          active.peak = Math.max(active.peak, active.count)
                          return stream
                        }),
                      ).pipe(Stream.ensuring(Effect.sync(() => active.count--))),
                    ),
                  ),
              }),
            )
          }),
        )
        const rules = Array.from({ length: 12 }, (_, index) => path.join(tmp.path, `rule-${index}.md`))
        return Effect.gen(function* () {
          yield* Effect.promise(() => Promise.all(rules.map((file) => fs.writeFile(file, "initial"))))
          const discovery = yield* start()
          const watcher = yield* Watcher.Test
          const config = yield* Config.Test
          const fixedAndOne = active.count
          expect(fixedAndOne).toBeGreaterThan(1)
          for (const rule of rules) {
            yield* config.setEntries([new Document({ type: "document", info: new Info({ instructions: [rule] }) })])
            yield* discovery.load()
            expect(active.count).toBe(fixedAndOne)
            expect((yield* discovery.list())).toContainEqual(file(rule, "initial"))
          }
          expect(active.peak).toBeLessThanOrEqual(fixedAndOne)
          const baseline = yield* readInitial(yield* discovery.load())
          const beforeOldEvent = scans.count
          yield* Effect.promise(() => fs.writeFile(rules[0], "stale"))
          yield* watcher.emit({ type: "update", path: rules[0] })
          // Longer than the 100ms debounce: an obsolete watcher would scan even if the rule is unchanged.
          yield* Effect.sleep("250 millis")
          expect(scans.count).toBe(beforeOldEvent)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "rule-11.md"), "current"))
          yield* emitAndWait({ type: "update", path: path.join(tmp.path, "rule-11.md") })
          expect(scans.count).toBeGreaterThan(beforeOldEvent)
          expect((yield* readUpdate(yield* discovery.load(), baseline)).text).toContain("current")
          expect(active.count).toBe(fixedAndOne)
        }).pipe(
          Effect.provide(
            instructionLayer({
              watcherLayer,
              filesystemLayer,
              config: path.join(tmp.path, "global"),
              configEntries: [
                new Document({ type: "document", info: new Info({ instructions: [path.join(tmp.path, "rule-0.md")] }) }),
              ],
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("reconciles dynamic watchers while a newly configured URL remains unavailable", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const response = { fail: true, requests: 0 }
            const server = Bun.serve({
              port: 0,
              fetch: () => {
                response.requests++
                return new Response(response.fail ? "failure" : "remote", { status: response.fail ? 503 : 200 })
              },
            })
            return { server, response }
          }),
          ({ server }) => Effect.promise(() => server.stop()),
        ).pipe(
          Effect.flatMap(({ server, response }) => {
            const first = path.join(tmp.path, "A.md")
            const second = path.join(tmp.path, "B.md")
            const third = path.join(tmp.path, "C.md")
            const active = { count: 0, peak: 0 }
            const watcherLayer = Layer.effectContext(
              Effect.gen(function* () {
                const context = yield* Layer.build(Watcher.testLayer)
                const watcher = Context.get(context, Watcher.Test)
                return Context.add(
                  context,
                  Watcher.Service,
                  Watcher.Service.of({
                    subscribe: (input, ready) =>
                      watcher.subscribe(input, ready).pipe(
                        Effect.map((stream) =>
                          Stream.unwrap(
                            Effect.sync(() => {
                              active.count++
                              active.peak = Math.max(active.peak, active.count)
                              return stream
                            }),
                          ).pipe(Stream.ensuring(Effect.sync(() => active.count--))),
                        ),
                      ),
                  }),
                )
              }),
            )
            return Effect.gen(function* () {
              yield* Effect.promise(() => Promise.all([first, second, third].map((file) => fs.writeFile(file, "initial"))))
              const discovery = yield* start()
              const config = yield* Config.Test
              const watcher = yield* Watcher.Test
              const initial = yield* readInitial(yield* discovery.load())
              expect(initial.text).toBe(`Instructions from: ${first}\ninitial`)
              const count = active.count
              const url = `http://127.0.0.1:${server.port}/unavailable`
              for (const next of [second, third, second]) {
                yield* config.setEntries([new Document({ type: "document", info: new Info({ instructions: [next, url] }) })])
                expect((yield* readUpdate(yield* discovery.load(), initial)).changed).toBe(false)
                expect(active.count).toBe(count)
              }
              expect(active.peak).toBeLessThanOrEqual(count)
              const beforeOld = response.requests
              yield* watcher.emit({ type: "update", path: first })
              yield* watcher.emit({ type: "update", path: third })
              yield* Effect.sleep("250 millis")
              expect(response.requests).toBe(beforeOld)

              yield* watcher.emit({ type: "update", path: second })
              yield* Effect.sleep("250 millis")
              expect(response.requests).toBeGreaterThan(beforeOld)
              response.fail = false
              yield* Effect.promise(() => fs.writeFile(second, "new rule"))
              yield* emitAndWait({ type: "update", path: second })
              const updated = yield* readUpdate(yield* discovery.load(), initial)
              expect(updated.text).toContain(`Instructions from: ${second}\nnew rule`)
              expect(updated.text).toContain(`The instructions from ${first} no longer apply.`)
              expect(active.count).toBe(count)
            }).pipe(
              Effect.provide(
                instructionLayer({
                  watcherLayer,
                  config: path.join(tmp.path, "global"),
                  configEntries: [new Document({ type: "document", info: new Info({ instructions: [first] }) })],
                  locationServiceLayer: Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                  ),
                }),
              ),
            )
          }),
        ),
      ),
    ),
  )

  it.live("loads global and upward project files and rescans them on change", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(tmp.path, "home")
        const shared = path.join(home, "code")
        const project = path.join(shared, "repo")
        const directory = path.join(project, "packages", "core")
        const outside = path.join(tmp.path, "AGENTS.md")
        const globalFile = path.join(global, "AGENTS.md")
        const sharedFile = path.join(shared, "AGENTS.md")
        const projectFile = path.join(project, "AGENTS.md")
        const packageFile = path.join(directory, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(sharedFile, "shared")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const discovery = yield* start()
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual([
            { path: globalFile, type: "file" },
            { path: packageFile, type: "file" },
            { path: path.join(project, "packages", "AGENTS.md"), type: "file" },
            { path: projectFile, type: "file" },
            { path: sharedFile, type: "file" },
            { path: path.join(home, "AGENTS.md"), type: "file" },
          ])
          expect(yield* watcher.subscriptions()).not.toContainEqual({
            path: path.join(tmp.path, "AGENTS.md"),
            type: "file",
          })
          const initialized = yield* readInitial(yield* discovery.load())
          expect(initialized.text).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${packageFile}\npackage`,
              `Instructions from: ${projectFile}\nproject`,
              `Instructions from: ${sharedFile}\nshared`,
            ].join("\n\n"),
          )
          expect(initialized.text).not.toContain("outside")

          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          yield* emitAndWait({ type: "update", path: packageFile })
          const changed = (yield* readUpdate(yield* discovery.load(), initialized)).text
          expect(changed).toContain(`The instructions changed:\nInstructions from: ${packageFile}\nchanged`)
          expect(changed).not.toContain(`Instructions from: ${globalFile}\nglobal`)

          yield* Effect.promise(() => fs.rm(packageFile))
          yield* emitAndWait({ type: "delete", path: packageFile })
          const removed = (yield* readUpdate(yield* discovery.load(), initialized)).text
          expect(removed).toContain(`The instructions from ${packageFile} no longer apply.`)
          expect(removed).not.toContain(`Instructions from: ${globalFile}\nglobal`)

          yield* Effect.promise(() => fs.rm(globalFile))
          yield* emitAndWait({ type: "delete", path: globalFile })
          yield* Effect.promise(() => fs.rm(projectFile))
          yield* emitAndWait({ type: "delete", path: projectFile })
          yield* Effect.promise(() => fs.rm(sharedFile))
          yield* emitAndWait({ type: "delete", path: sharedFile })
          expect((yield* readUpdate(yield* discovery.load(), initialized)).text).toBe(
            "Previously loaded instructions no longer apply.",
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: global,
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const discovery = yield* start()
          expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${file}\n`)
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            }),
          ),
        ),
      ),
    ),
  )

  it.live("discovers a newly created instruction file above the project root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const home = path.join(tmp.path, "home")
        const shared = path.join(home, "code")
        const project = path.join(shared, "repo")
        const intermediate = path.join(shared, "AGENTS.md")
        const directory = path.join(project, "core")
        const projectFile = path.join(project, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(projectFile, "project"))
          const discovery = yield* start()
          expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${projectFile}\nproject`)

          yield* Effect.promise(() => fs.writeFile(intermediate, "intermediate"))
          yield* emitAndWait({ type: "create", path: intermediate })

          expect((yield* readInitial(yield* discovery.load())).text).toBe(
            [`Instructions from: ${projectFile}\nproject`, `Instructions from: ${intermediate}\nintermediate`].join(
              "\n\n",
            ),
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("stops instruction candidates at the project root outside home", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(tmp.path, "home")
        const project = path.join(tmp.path, "scratch", "repo")
        const directory = path.join(project, "packages", "core")
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* start()
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual([
            { path: path.join(global, "AGENTS.md"), type: "file" },
            { path: path.join(directory, "AGENTS.md"), type: "file" },
            { path: path.join(project, "packages", "AGENTS.md"), type: "file" },
            { path: path.join(project, "AGENTS.md"), type: "file" },
          ])
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: global,
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.effect("isolates source failure without failing activation", () => {
    const failingFS = Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return Effect.gen(function* () {
      const discovery = yield* start()
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(
      Effect.provide(
        instructionLayer({
          filesystemLayer: failingFS,
          locationServiceLayer: Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
          ),
        }),
      ),
    )
  })

  it.effect("marks a discovered file that disappears before read as unavailable", () => {
    const discovered = AbsolutePath.make("/repo/AGENTS.md")
    const racingFS = Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({
            ...fs,
            up: () => Effect.succeed([discovered]),
            readFileStringSafe: () => Effect.undefined,
          }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return Effect.gen(function* () {
      const discovery = yield* start()
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: discovered, content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(
      Effect.provide(
        instructionLayer({
          filesystemLayer: racingFS,
          locationServiceLayer: Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
          ),
        }),
      ),
    )
  })

  it.effect("does not remove configured instructions when a matched file becomes unreadable", () => {
    const configured = path.resolve("/repo/rules.md")
    const unreadableFS = Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({
            ...fs,
            scanChecked: () => Effect.succeed([configured]),
            readFileStringSafe: () => Effect.undefined,
          }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return Effect.gen(function* () {
      const discovery = yield* start()
      expect(
        (yield* readUpdate(yield* discovery.load(), state({ "core/instructions": [{ path: configured, content: "old" }] })))
          .changed,
      ).toBe(false)
    }).pipe(
      Effect.provide(
        instructionLayer({
          filesystemLayer: unreadableFS,
          configEntries: [new Document({ type: "document", info: new Info({ instructions: [configured] }) })],
          locationServiceLayer: Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
          ),
        }),
      ),
    )
  })

  it.effect("canonicalizes boundaries and honors project opt-out", () =>
    Effect.gen(function* () {
      const observed: { values: { targets: string[]; start: string; stop?: string }[] } = { values: [] }
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) => Effect.sync(() => (observed.values.push(options), [])),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )
      const disabled = yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            project: false,
            configEntries: [
              new Document({
                type: "document",
                path: AbsolutePath.make(path.resolve("/repo/opencode.jsonc")),
                info: new Info({ instructions: [path.resolve("/repo/rules.md")] }),
              }),
            ],
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )
      expect(yield* disabled.list()).toEqual([])
      yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      const repo = path.resolve("/repo")
      expect(observed.values).toEqual([{ targets: ["AGENTS.md"], start: repo, stop: repo }])
    }),
  )
})
