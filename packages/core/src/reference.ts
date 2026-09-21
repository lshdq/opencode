export * as Reference from "./reference"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Scope, Types } from "effect"
import { Reference } from "@opencode-ai/schema/reference"
import { Global } from "./global"
import { EventV2 } from "./event"
import { Repository } from "./repository"
import { RepositoryCache } from "./repository-cache"
import { AbsolutePath } from "./schema"
import { State } from "./state"

export const LocalSource = Reference.LocalSource
export type LocalSource = Reference.LocalSource

export const GitSource = Reference.GitSource
export type GitSource = Reference.GitSource

export const Source = Reference.Source
export type Source = Reference.Source

export const Event = Reference.Event

export const Info = Reference.Info
export type Info = Reference.Info

export interface Resolved {
  readonly info: Info
  readonly repository?: Repository.RemoteReference
}

export function resolve(sources: Iterable<readonly [string, Source]>, repos: string): Resolved[] {
  const result: Resolved[] = []
  for (const [name, source] of sources) {
    const base = {
      name,
      ...(source.description === undefined ? {} : { description: source.description }),
      ...(source.hidden === undefined ? {} : { hidden: source.hidden }),
      source,
    }
    if (source.type === "local") {
      result.push({ info: new Info({ ...base, path: source.path }) })
      continue
    }
    const repository = Repository.parse(source.repository)
    if (!repository || !Repository.isRemote(repository)) continue
    if (source.branch) {
      try {
        Repository.validateBranch(source.branch)
      } catch {
        continue
      }
    }
    result.push({
      info: new Info({ ...base, path: AbsolutePath.make(Repository.cachePath(repos, repository, source.branch)) }),
      repository,
    })
  }
  return result
}

type Data = {
  sources: Map<string, Types.DeepMutable<Source>>
}

type Draft = {
  add(name: string, source: Source): void
  remove(name: string): void
  list(): readonly [string, Source][]
}

export interface Interface extends State.Transformable<Draft> {
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Reference") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const events = yield* EventV2.Service
    const cache = yield* RepositoryCache.Service
    const scope = yield* Scope.Scope
    const materialized = new Map<string, Info>()
    const state = State.create<Data, Draft>({
      initial: () => ({ sources: new Map() }),
      draft: (draft) => ({
        add: (name, source) => draft.sources.set(name, source as Types.DeepMutable<Source>),
        remove: (name) => draft.sources.delete(name),
        list: () => Array.from(draft.sources.entries()) as [string, Source][],
      }),
      finalize: (draft) =>
        Effect.gen(function* () {
          materialized.clear()
          for (const { info, repository } of resolve(draft.list(), global.repos)) {
            materialized.set(info.name, info)
            const source = info.source
            if (!repository || source.type !== "git") continue
            yield* cache.ensure({ reference: repository, branch: source.branch, refresh: true }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("failed to materialize reference", {
                  name: info.name,
                  repository: source.repository,
                  cause,
                }),
              ),
              Effect.forkIn(scope),
            )
          }
          yield* events.publish(Event.Updated, {})
        }),
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      list: Effect.fn("Reference.list")(function* () {
        return Array.from(materialized.values())
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Global.node, EventV2.node, RepositoryCache.node],
})
