import { afterEach, beforeAll, afterAll, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Effect } from "effect"
import { rm } from "fs/promises"
import path from "path"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { disposeAllInstances } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"

// Startup robustness against an unreachable models.dev source (TC-008): these
// tests use the real ModelsDev layer (no stub) with OPENCODE_MODELS_URL pointed
// at a port nothing listens on. populate must fall back to an empty catalog
// without any network wait, and the background refresh fork must fail fast
// without wedging provider initialization.
// test/preload.ts pins OPENCODE_MODELS_PATH and disables fetching for other
// files; save/restore around the suite — never leak the mutation to subsequent
// test files in the same bun process.
const ORIGINAL_MODELS_PATH = Flag.OPENCODE_MODELS_PATH
const ORIGINAL_MODELS_URL = Flag.OPENCODE_MODELS_URL
const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH
beforeAll(() => {
  Flag.OPENCODE_MODELS_PATH = undefined
  Flag.OPENCODE_MODELS_URL = "http://127.0.0.1:1"
  Flag.OPENCODE_DISABLE_MODELS_FETCH = false
})
afterAll(() => {
  Flag.OPENCODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.OPENCODE_MODELS_URL = ORIGINAL_MODELS_URL
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
})

// preload isolates XDG_CACHE_HOME, so Global.Path.cache is test-local. The
// custom source URL hashes into its own models-*.json cache file name, so
// clearing models*.json here can never touch a real user cache.
const clearModelsCache = async () => {
  await rm(path.join(Global.Path.cache, "models.json"), { force: true })
  for (const file of await Array.fromAsync(new Bun.Glob("models-*.json").scan({ cwd: Global.Path.cache }))) {
    await rm(path.join(Global.Path.cache, file), { force: true })
  }
}

afterEach(async () => {
  await disposeAllInstances()
})

// Real ModelsDev layer only — deps (FSUtil, EventV2, http client) stay real so
// the unreachable source is actually dialed by the background refresh fork.
const itCatalog = testEffect(AppNodeBuilder.build(ModelsDev.node))

// Full legacy Provider stack with the real (unreachable) ModelsDev node in
// place — no stub replacement anywhere.
const itProvider = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Provider.node,
      FSUtil.node,
      Env.node,
      Config.node,
      Auth.node,
      Plugin.node,
      ModelsDev.node,
      RuntimeFlags.node,
      EventV2.node,
    ]),
  ),
)

describe("ModelsDev against an unreachable source", () => {
  itCatalog.live(
    "get() serves an empty catalog immediately when no cache exists",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(clearModelsCache)
        const started = Date.now()
        const catalog = yield* ModelsDev.Service.use((s) => s.get())
        expect(catalog).toEqual({})
        // populate must not wait on the network — allow generous slack for
        // slow CI hosts, but far below any fetch timeout.
        expect(Date.now() - started).toBeLessThan(5000)
      }),
    30000,
  )

  itProvider.instance(
    "provider initializes from an empty catalog when the models.dev source is unreachable",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(clearModelsCache)
        const catalog = yield* ModelsDev.Service.use((s) => s.get())
        expect(catalog).toEqual({})

        // Initializing the full legacy Provider stack (config, auth, plugin,
        // models.dev, events) must not hang or die even though the background
        // refresh keeps failing against the unreachable source.
        const providers = yield* awaitWithTimeout(
          Provider.use.list(),
          "provider initialization hung with an unreachable models.dev source",
          "20 seconds",
        )
        // Empty catalog, no configured providers, no auth credentials in tests.
        expect(Object.keys(providers)).toEqual([])
      }),
    60000,
  )
})
