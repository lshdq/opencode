import { createContext, onCleanup, useContext, type ParentProps } from "solid-js"
import { useClient } from "./client"
import { useTuiLifecycle } from "./runtime"
import { createTaskQueueOwner } from "../util/task-queue-owner"

const context = createContext<ReturnType<typeof createTaskQueueOwner>>()

/** Mounted once above routes, dialogs and plugin generations. Closing a view has no lease side effects. */
export function TaskQueueProvider(props: ParentProps) {
  const client = useClient()
  const owner = createTaskQueueOwner(() => client.api.experimental.taskQueue, undefined, () => client.url)
  const unregister = useTuiLifecycle().add(owner.shutdown)
  const unsubscribe = client.onReconnect((source) => {
    owner.refresh({ api: source.api.experimental.taskQueue, url: source.url })
  })
  const off = client.event.on("taskqueue.updated", (event) => {
    const source = client.event.source(event)
    if (source) owner.observer({ api: source.api.experimental.taskQueue, url: source.url })(event.data)
  })
  onCleanup(() => {
    off()
    unsubscribe()
    // Solid disposal happens before the async app finalizers; start shutdown here,
    // but retain its finalizer until its best-effort requests have settled.
    void owner.shutdown().finally(unregister)
  })
  return <context.Provider value={owner}>{props.children}</context.Provider>
}

export function useTaskQueueOwner() {
  const value = useContext(context)
  if (!value) throw new Error("TaskQueueProvider is missing")
  return value
}
