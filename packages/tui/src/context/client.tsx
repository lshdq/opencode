import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { createClientConnection, createPersistentPtyClient } from "@opencode/client/solid"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { createMediaCache } from "../util/media"
import { useLog } from "./log"

type ManagedService = {
  reconnect: (signal: AbortSignal) => Promise<{ api: OpenCodeClient; url?: string; headers?: Record<string, string> }>
  restart: () => Promise<void>
}

type ClientEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }
type ClientSource = Readonly<{ api: OpenCodeClient; url?: string }>

export const {
  use: useClient,
  provider: ClientProvider,
  context: ClientContext,
} = createSimpleContext({
  name: "Client",
  init: (props: { api: OpenCodeClient; url?: string; headers?: Record<string, string>; service?: ManagedService }) => {
    const log = useLog({ component: "client" })
    const service = props.service
    const events = createGlobalEmitter<ClientEventMap>()
    let api = props.api
    let url = props.url
    let headers = props.headers
    const sources = new WeakMap<OpenCodeClient, ClientSource>([[api, { api, url }]])
    const eventSources = new WeakMap<OpenCodeEvent, ClientSource>()
    const reconnected = new Set<(source: ClientSource) => void>()
    let persistentPty = url ? createPersistentPtyClient(api, { url }) : undefined
    const media = createMediaCache(() => api)

    const connection = createClientConnection(api, {
      reconnect: service
        ? async (signal) => {
            const next = await service.reconnect(signal)
            api = next.api
            if (next.url) url = next.url
            headers = next.headers
            const source = { api, url }
            sources.set(api, source)
            // Resource freshness follows resolver order, independently of the
            // buffered events that may still refer to older streams/credentials.
            reconnected.forEach((listener) => listener(source))
            if (url) persistentPty = createPersistentPtyClient(api, { url })
            return api
          }
        : undefined,
      onEvent(event, source) {
        // The transport supplies the receiving SDK, not the current live getter.
        // Weak keys let old snapshots go when their SDK/events are no longer used.
        eventSources.set(event, sources.get(source)!)
        events.emit(event.type, event)
      },
      log,
    })

    onCleanup(() => {
      events.clear()
      reconnected.clear()
    })

    return {
      get api() {
        return api
      },
      get url() {
        return url
      },
      get headers() {
        return headers
      },
      get persistentPty() {
        if (!persistentPty) throw new Error("Persistent terminal server endpoint is unavailable")
        return persistentPty
      },
      event: {
        on: events.on,
        listen: events.listen,
        source: (event: OpenCodeEvent) => eventSources.get(event),
      },
      onReconnect(listener: (source: ClientSource) => void) {
        reconnected.add(listener)
        return () => { reconnected.delete(listener) }
      },
      connection,
      media,
      restart: service?.restart,
    }
  },
})
