import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import { mkdir, rm, writeFile } from "fs/promises"
import path from "path"

// test/preload.ts pins OPENCODE_MODELS_PATH to a fixture so other tests can
// resolve providers without network. These tests drive populate fallbacks
// themselves, so clear the pin and silence the eager refresh fork. Save/restore
// around the suite — never leak the mutation to subsequent test files in the
// same bun process.
const ORIGINAL_MODELS_PATH = Flag.OPENCODE_MODELS_PATH
const ORIGINAL_MODELS_URL = Flag.OPENCODE_MODELS_URL
const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH
beforeAll(() => {
  Flag.OPENCODE_MODELS_PATH = undefined
  Flag.OPENCODE_MODELS_URL = undefined
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
})
afterAll(() => {
  Flag.OPENCODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.OPENCODE_MODELS_URL = ORIGINAL_MODELS_URL
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
})

const unreachableUrl = "http://127.0.0.1:1"
// Custom source URLs hash into their own cache file name inside models-dev.ts.
const cacheFiles = [
  path.join(Global.Path.cache, "models.json"),
  path.join(Global.Path.cache, `models-${Hash.fast(unreachableUrl)}.json`),
]

const diskFixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const overrideFixture: Record<string, ModelsDev.Provider> = {
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": {
        id: "beta-1",
        name: "Beta One",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  },
}

// Guard client: records every executed request and answers with a failure.
// populate must never reach it — any recorded call means startup went online.
const makeGuardClient = (calls: Ref.Ref<Array<string>>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (calls) => [...calls, request.url])
      return HttpClientResponse.fromWeb(request, new Response("network is blocked in tests", { status: 500 }))
    }),
  )

const buildLayer = (calls: Ref.Ref<Array<string>>) =>
  // Layer.fresh is required because the ModelsDev implementation is a module-level Layer constant,
  // and Effect.provide uses a process-global MemoMap by default — without fresh,
  // every test would reuse the cachedInvalidateWithTTL state from the first run.
  Layer.fresh(
    AppNodeBuilder.build(ModelsDev.node, [
      [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, makeGuardClient(calls))],
    ]),
  )

const provided = <A, E>(calls: Ref.Ref<Array<string>>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(calls)))

const removeCaches = () => Promise.all(cacheFiles.map((file) => rm(file, { force: true })))

beforeEach(async () => {
  await removeCaches()
})

afterAll(async () => {
  await removeCaches()
})

describe("ModelsDev populate", () => {
  it.live("get() returns an empty catalog without network when no cache exists", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        Flag.OPENCODE_MODELS_URL = unreachableUrl
      }),
      () =>
        Effect.gen(function* () {
          const calls = yield* Ref.make<Array<string>>([])
          // Layer builds with fetch disabled so the background refresh fork
          // stays silent; fetching is then enabled for get() itself to prove
          // populate never goes online even when fetching is allowed.
          const context = yield* Layer.build(buildLayer(calls))
          const started = Date.now()
          const result = yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              Flag.OPENCODE_DISABLE_MODELS_FETCH = false
            }),
            () => ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(context)),
            () =>
              Effect.sync(() => {
                Flag.OPENCODE_DISABLE_MODELS_FETCH = true
              }),
          )
          expect(result).toEqual({})
          expect(Date.now() - started).toBeLessThan(5000)
          expect(yield* Ref.get(calls)).toEqual([])
        }),
      () =>
        Effect.sync(() => {
          Flag.OPENCODE_MODELS_URL = undefined
        }),
    ),
  )

  it.live("get() serves the on-disk cache without network", () =>
    Effect.gen(function* () {
      yield* Effect.promise(async () => {
        await mkdir(Global.Path.cache, { recursive: true })
        await writeFile(cacheFiles[0], JSON.stringify(diskFixture))
      })
      const calls = yield* Ref.make<Array<string>>([])
      const result = yield* provided(calls, ModelsDev.Service.use((s) => s.get()))
      expect(result).toEqual(diskFixture)
      expect(yield* Ref.get(calls)).toEqual([])
    }),
  )

  it.live("get() prefers OPENCODE_MODELS_PATH over the cache directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const override = path.join(tmp.path, "models-override.json")
          yield* Effect.promise(() => writeFile(override, JSON.stringify(overrideFixture)))
          const calls = yield* Ref.make<Array<string>>([])
          const result = yield* Effect.acquireUseRelease(
            Effect.sync(() => {
              Flag.OPENCODE_MODELS_PATH = override
            }),
            () => ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(buildLayer(calls))),
            () =>
              Effect.sync(() => {
                Flag.OPENCODE_MODELS_PATH = undefined
              }),
          )
          expect(result).toEqual(overrideFixture)
          expect(yield* Ref.get(calls)).toEqual([])
        }),
      ),
    ),
  )
})
