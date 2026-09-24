export * as InstructionDiscovery from "./instruction-discovery.js"

import { Context, Effect, Layer, Schema, Scope, Types } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { createPatch } from "diff"
import { Bus } from "./bus.js"
import { Instructions } from "./instructions/index.js"
import { State } from "./state.js"

export class File extends Schema.Class<File>("InstructionDiscovery.File")({
  // Local paths retain their original shape; remote identities are opaque digests.
  path: Schema.String,
  label: Schema.optional(Schema.String),
  content: Schema.String,
}) {}

const Files = Schema.Array(File)
const key = Instructions.Key.make("core/instructions")

export const Event = {
  Updated: Bus.ephemeral({ type: "instruction-discovery.updated", schema: {} }),
}

export type Data = {
  files: Map<string, Types.DeepMutable<File>>
  available: boolean
}

export type Editor = {
  list: () => readonly Types.DeepMutable<File>[]
  // Map insertion order is render order: config adds global then nearest-to-farthest project files;
  // sibling contributors interleave by transform registration order.
  add: (file: File) => void
  update: (path: string, update: (file: Types.DeepMutable<File>) => void) => void
  remove: (path: string) => void
  unavailable: () => void
}

export interface Interface extends State.Transformable<Editor> {
  // Discovery policy lives here because internal plugins have no per-composition options channel.
  // Move it into plugin config once plugins can consume their own options.
  readonly project: boolean
  readonly global: boolean
  readonly list: () => Effect.Effect<File[] | Instructions.Unavailable>
  readonly load: () => Effect.Effect<Instructions.List>
  /** Refresh remote sources at a model boundary, not on a timer. */
  readonly onLoad: (refresh: () => Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  global: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionDiscovery") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const refreshers = new Set<() => Effect.Effect<void>>()
      const state = State.create<Data, Editor>({
        name: "instruction-discovery",
        initial: () => ({ files: new Map(), available: true }),
        editor: (editor) => ({
          list: () => Array.from(editor.files.values()),
          add: (file) => editor.files.set(file.path, new File(file) as Types.DeepMutable<File>),
          update: (path, update) => {
            const current = editor.files.get(path)
            if (!current) return
            update(current)
            current.path = path
          },
          remove: (path) => editor.files.delete(path),
          unavailable: () => {
            editor.available = false
          },
        }),
        notify: () => bus.publish(Event.Updated, {}).pipe(Effect.asVoid),
      })

      const source = (value: ReadonlyArray<File> | Instructions.Unavailable | Instructions.Removed) =>
        Instructions.make<ReadonlyArray<File>>({
          key,
          codec: Schema.toCodecJson(Files),
          read: Effect.succeed(value),
          render: {
            initial: render,
            changed: renderUpdate,
            removed: () => "Previously loaded instructions no longer apply.",
          },
        })

      const list = Effect.fn("InstructionDiscovery.list")(function* () {
        const current = state.get()
        if (!current.available) return Instructions.unavailable
        return Array.from(current.files.values())
      })

      return Service.of({
        project: options?.project !== false,
        global: options?.global !== false,
        transform: state.transform,
        reload: state.reload,
        list,
        onLoad: (refresh) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope
            refreshers.add(refresh)
            yield* Scope.addFinalizer(scope, Effect.sync(() => refreshers.delete(refresh)))
          }),
        load: Effect.fn("InstructionDiscovery.load")(function* () {
          yield* Effect.forEach(refreshers, (refresh) => refresh(), { discard: true })
          const files = yield* list()
          if (!Array.isArray(files)) return source(files)
          return source(files.length === 0 ? Instructions.removed : files)
        }),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [Bus.node],
  })
}

export const node = configured()

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${label(file)}\n${file.content}`).join("\n\n")
}

function label(file: File) {
  if (file.label) return file.label
  // Older persisted URL sources can still appear in a diff after upgrading.
  if (!file.path.startsWith("http://") && !file.path.startsWith("https://")) return file.path
  if (!URL.canParse(file.path)) return "remote instruction"
  const url = new URL(file.path)
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.toString()
}

function renderUpdate(previous: ReadonlyArray<File>, current: ReadonlyArray<File>) {
  const changes = Instructions.diffByKey(
    previous,
    current,
    (file) => file.path,
    (before, after) => before.content !== after.content,
  )
  return [
    ...changes.removed.map((file) => `The instructions from ${label(file)} no longer apply.`),
    ...changes.added.map((file) => `New instructions apply from:\n${render([file])}`),
    ...changes.changed.map(({ previous: before, current: after }) => {
      const patch = createPatch(label(after), before.content, after.content, "", "", { context: 3 })
      const diff = [
        `The instructions from ${label(after)} changed. Here's the diff:`,
        "```diff",
        patch.slice(patch.indexOf("@@")).trimEnd(),
        "```",
      ].join("\n")
      const replacement = `The instructions changed:\n${render([after])}`
      return diff.length < replacement.length ? diff : replacement
    }),
  ].join("\n\n")
}
