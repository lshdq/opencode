import type { LocationGetOutput, LocationRef } from "@opencode/client"
import { createContext, createMemo, createSignal, onCleanup, useContext, type ParentProps } from "solid-js"
import { useClient } from "./client"
import { useData } from "./data"

const context = createContext<{
  readonly current: LocationGetOutput | undefined
  // The target location as set, available before the server-synced info in `current` arrives.
  readonly ref: LocationRef | undefined
  readonly error: { readonly location: LocationRef; readonly cause: unknown } | undefined
  readonly resourceError: { readonly location: LocationRef; readonly cause: unknown } | undefined
  retry: () => void
  set: (location?: LocationRef) => void
}>()

export function LocationProvider(props: ParentProps) {
  const client = useClient()
  const data = useData()
  const [ref, setRef] = createSignal<LocationRef>()
  const [error, setError] = createSignal<{ readonly location: LocationRef; readonly cause: unknown }>()
  const [resourceError, setResourceError] = createSignal<{ readonly location: LocationRef; readonly cause: unknown }>()
  let generation = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    generation++
  })
  const current = createMemo(() => data.location.info(ref()))

  function sync(location?: LocationRef) {
    if (!location) return
    const attempt = ++generation
    const defaultLocation = data.location.default()
    const target =
      location.directory === defaultLocation.directory && location.workspaceID === defaultLocation.workspaceID
        ? undefined
        : location
    setError(undefined)
    setResourceError(undefined)
    void data.location
      .syncInfo(target)
      .then(() => {
        if (disposed || generation !== attempt) return
        // Catalog failures must not replace the composer with Location missing.
        // Failed reads remain uncached, so retry only reissues unsuccessful reads.
        void data.location.sync(target).catch((cause) => {
          if (disposed || generation !== attempt) return
          setResourceError({ location, cause })
        })
      })
      .catch((cause) => {
        const current = ref()
        if (
          disposed ||
          generation !== attempt ||
          current?.directory !== location.directory ||
          current.workspaceID !== location.workspaceID
        )
          return
        setError({ location, cause })
      })
  }

  function set(location?: LocationRef) {
    generation++
    setError(undefined)
    setResourceError(undefined)
    setRef(location)
    if (client.connection.status() === "connected") sync(location)
  }

  onCleanup(client.event.on("server.connected", () => sync(ref())))

  return (
    <context.Provider
      value={{
        get current() {
          return current()
        },
        get ref() {
          return ref()
        },
        get error() {
          return error()
        },
        get resourceError() {
          return resourceError()
        },
        retry: () => sync(ref()),
        set,
      }}
    >
      {props.children}
    </context.Provider>
  )
}

export function useLocation() {
  const value = useContext(context)
  if (!value) throw new Error("Location context must be used within a LocationProvider")
  return value
}
