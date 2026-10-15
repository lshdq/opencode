import { expect, mock, test } from "bun:test"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { createComponent, createContext, createSignal, useContext } from "solid-js"
import { render } from "solid-js/web"

type Agent = { name: string; mode: "primary"; hidden: boolean; native?: boolean }

let agentCatalog = () => [] as Agent[]

mock.module("@opencode/ui/context", () => ({
  createSimpleContext<T, Props extends Record<string, unknown>>(input: {
    name: string
    init: (props: Props) => T
  }) {
    const context = createContext<T>()

    return {
      provider: (props: Props & { children?: unknown }) =>
        createComponent(context.Provider, {
          value: input.init(props),
          get children() {
            return props.children
          },
        }),
      use: () => {
        const value = useContext(context)

        if (value === undefined) throw new Error(`${input.name} context must be used within a context provider`)

        return value
      },
    }
  },
}))

mock.module("@/runtime/server/current", () => ({
  useData: () => ({
    location: {
      agent: {
        list: () => agentCatalog(),
      },
      session: {
        get: () => undefined,
      },
    },
  }),
}))

mock.module("@/runtime/server/client", () => ({
  useServerSDK: () => ({
    scope: "local",
    event: {
      on: () => () => {},
    },
  }),
}))

mock.module("@/workspaces/location", () => ({
  useWorkspaceLocation: () => () => ({ directory: "/workspace" }),
}))

mock.module("@/providers/catalog/providers", () => ({
  useProviders: () => ({
    all: () =>
      new Map([
        [
          "provider",
          {
            id: "provider",
            name: "Provider",
            models: {
              model: { id: "model", providerID: "provider" },
            },
          },
        ],
      ]),
    connected: () => [
      {
        id: "provider",
        name: "Provider",
        models: {
          model: { id: "model", providerID: "provider" },
        },
      },
    ],
  }),
}))

mock.module("@/providers/models/models", () => ({
  useModels: () => {
    const provider = { id: "provider", name: "Provider" }
    const model = { id: "model", name: "Model", provider, variants: [] }

    return {
      ready: Object.assign(() => true, { promise: undefined }),
      recent: { list: () => [] },
      variant: { get: () => undefined, set: () => {} },
      find: (key: { providerID: string; modelID: string }) =>
        key.providerID === provider.id && key.modelID === model.id ? model : undefined,
      list: () => [model],
      setVisibility() {},
      visible: () => true,
    }
  },
}))

mock.module("@/settings/model", () => ({
  useSettings: () => ({
    visibility: {
      customAgents: () => true,
    },
  }),
}))

mock.module("@/providers/models/configured", () => ({
  useConfiguredModel: () => Object.assign(() => undefined, { ready: () => true }),
}))

const { LocalProvider, useLocal } = await import("@/providers/models/selection")
const { PlatformProvider } = await import("@/runtime/platform/platform")

test("LocalProvider follows refreshed draft catalogs, preserves manual selection, and resets on a new draft", async () => {
  const [agents, setAgents] = createSignal<Agent[]>([
    { name: "build", mode: "primary", hidden: false },
    { name: "reviewer", mode: "primary", hidden: false },
  ])
  agentCatalog = agents
  const history = createMemoryHistory()
  history.set({ value: "/new-session?draftId=draft-one", replace: true, scroll: false })
  let local!: ReturnType<typeof useLocal>
  const platform = {
    platform: "web" as const,
    openExternal() {},
    restart: async () => {},
    notify: async () => {},
  }
  const dispose = render(
    () =>
      createComponent(PlatformProvider, {
        value: platform,
        get children() {
          return createComponent(MemoryRouter, {
            history,
            get children() {
              return createComponent(Route, {
                path: "/new-session",
                component: () =>
                  createComponent(LocalProvider, {
                    get children() {
                      local = useLocal()

                      return document.createElement("div")
                    },
                  }),
              })
            },
          })
        },
      }),
    document.createElement("div"),
  )

  try {
    await Promise.resolve()
    expect(local.agent.current()?.name).toBe("build")

    setAgents([
      { name: "reviewer", mode: "primary", hidden: false },
      { name: "build", mode: "primary", hidden: false },
    ])
    await Promise.resolve()
    expect(local.agent.current()?.name).toBe("reviewer")

    local.agent.set("build")
    local.model.set({ providerID: "provider", modelID: "model" })
    expect(local.agent.current()?.name).toBe("build")
    expect(local.model.current()?.id).toBe("model")

    setAgents([])
    await Promise.resolve()
    expect(local.agent.current()).toBeUndefined()

    setAgents([
      { name: "reviewer", mode: "primary", hidden: false },
      { name: "build", mode: "primary", hidden: false },
      { name: "plan", mode: "primary", hidden: false },
    ])
    await Promise.resolve()
    expect(local.agent.current()?.name).toBe("build")

    history.set({ value: "/new-session?draftId=draft-two", replace: false, scroll: false })
    await Promise.resolve()
    expect(local.agent.current()?.name).toBe("reviewer")

    local.agent.set("build")
    setAgents([
      { name: "reviewer", mode: "primary", hidden: false },
      { name: "plan", mode: "primary", hidden: false },
    ])
    await Promise.resolve()
    expect(local.agent.current()?.name).toBe("reviewer")

    setAgents([
      { name: "plan", mode: "primary", hidden: false },
      { name: "build", mode: "primary", hidden: false },
      { name: "reviewer", mode: "primary", hidden: false },
    ])
    await Promise.resolve()
    expect(local.agent.current()?.name).toBe("plan")
  } finally {
    dispose()
    agentCatalog = () => []
  }
})
