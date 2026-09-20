import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect, Layer } from "effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Controlled models.dev catalog: starts empty (first launch without cache),
// tests swap in a populated catalog before publishing Refreshed.
let catalog: Record<string, ModelsDev.Provider> = {}

const modelsDevLayer = Layer.succeed(
  ModelsDev.Service,
  ModelsDev.Service.of({
    get: () => Effect.sync(() => catalog),
    refresh: () => Effect.void,
  }),
)

const it = testEffect(
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
    [[ModelsDev.node, modelsDevLayer]],
  ),
)

const originalEnv = new Map<string, string | undefined>()

afterEach(async () => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  await disposeAllInstances()
})

const set = (k: string, v: string) =>
  Effect.gen(function* () {
    if (!originalEnv.has(k)) originalEnv.set(k, process.env[k])
    process.env[k] = v
    yield* Env.use.set(k, v)
  })

const stubProvider = (input: { id: string; name: string; env: string; model: string }): ModelsDev.Provider => ({
  id: input.id,
  name: input.name,
  env: [input.env],
  npm: "@ai-sdk/openai-compatible",
  api: `https://api.${input.id}.test/v1`,
  models: {
    [input.model]: {
      id: input.model,
      name: `${input.name} One`,
      release_date: "2026-01-01",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: true,
      limit: { context: 8_000, output: 2_000 },
    },
  },
})

const alpha = stubProvider({ id: "alpha", name: "Alpha", env: "STUB_ALPHA_KEY", model: "alpha-1" })
const beta = stubProvider({ id: "beta", name: "Beta", env: "STUB_BETA_KEY", model: "beta-1" })

const refresh = Effect.gen(function* () {
  const events = yield* EventV2.Service
  yield* events.publish(ModelsDev.Event.Refreshed, {})
})

it.instance("provider state rebuilds from an empty catalog after ModelsDev.Refreshed", () =>
  Effect.gen(function* () {
    catalog = {}
    yield* set("STUB_ALPHA_KEY", "test-key")

    const stale = yield* Provider.use.list()
    expect(stale[ProviderV2.ID.make("alpha")]).toBeUndefined()

    catalog = { alpha }
    yield* refresh

    const providers = yield* pollWithTimeout(
      Provider.use.list().pipe(Effect.map((list) => list[ProviderV2.ID.make("alpha")])),
      "provider state was not rebuilt after models.dev refresh",
    )
    expect(providers.models["alpha-1"]).toBeDefined()
    expect(providers.name).toBe("Alpha")
  }),
)

it.instance("provider state swap replaces the previous catalog after ModelsDev.Refreshed", () =>
  Effect.gen(function* () {
    catalog = { alpha }
    yield* set("STUB_ALPHA_KEY", "test-key")
    yield* set("STUB_BETA_KEY", "test-key")

    const initial = yield* Provider.use.list()
    expect(initial[ProviderV2.ID.make("alpha")]).toBeDefined()
    expect(initial[ProviderV2.ID.make("beta")]).toBeUndefined()

    catalog = { beta }
    yield* refresh

    const rebuilt = yield* pollWithTimeout(
      Provider.use
        .list()
        .pipe(Effect.map((list) => (list[ProviderV2.ID.make("beta")] ? list : undefined))),
      "provider state was not rebuilt after models.dev refresh",
    )
    expect(rebuilt[ProviderV2.ID.make("alpha")]).toBeUndefined()
  }),
)

it.instance("provider state stays cached when no ModelsDev.Refreshed is published", () =>
  Effect.gen(function* () {
    catalog = { alpha }
    yield* set("STUB_ALPHA_KEY", "test-key")
    yield* set("STUB_BETA_KEY", "test-key")

    const before = yield* Provider.use.list()
    expect(before[ProviderV2.ID.make("alpha")]).toBeDefined()

    catalog = { beta }
    const after = yield* Provider.use.list()
    expect(after[ProviderV2.ID.make("alpha")]).toBeDefined()
    expect(after[ProviderV2.ID.make("beta")]).toBeUndefined()
  }),
)
