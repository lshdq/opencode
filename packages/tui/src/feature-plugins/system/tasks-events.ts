import type { Plugin } from "@opencode/plugin/tui"
import type { OpenCodeEvent } from "@opencode/client"
import type { useClient } from "../../context/client"
import type { createTaskQueueFeed } from "./tasks-data"

type Panel = Pick<ReturnType<typeof createTaskQueueFeed>, "update" | "load">

/** Two activation-owned subscriptions, never two more archived closures per dialog. */
export function createTaskQueueEvents(data: Pick<Plugin.Context["data"], "on">) {
  let current: { panel: Panel; client: Pick<ReturnType<typeof useClient>, "api" | "event"> } | undefined
  function panel(event: OpenCodeEvent) {
    // Match the feed's exact SDK resource epoch, including credential refresh.
    // A missing source is not evidence that an event belongs to the live SDK.
    if (!current || current.client.event.source(event)?.api.experimental.taskQueue !== current.client.api.experimental.taskQueue) return
    return current.panel
  }
  const off = [
    data.on("taskqueue.updated", (event) => panel(event)?.update(event.data)),
    data.on("server.connected", (event) => { void panel(event)?.load() }),
  ]

  return {
    attach(panel: Panel, client: Pick<ReturnType<typeof useClient>, "api" | "event">) {
      if (!off.length) return () => {}
      const entry = { panel, client }
      current = entry
      return () => { if (current === entry) current = undefined }
    },
    dispose() {
      current = undefined
      off.splice(0).reverse().forEach((dispose) => dispose())
    },
  }
}
