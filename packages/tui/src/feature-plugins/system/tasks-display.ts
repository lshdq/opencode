import type { TaskQueueInfo } from "@opencode/client"
import { batch, createEffect, createMemo, createSignal, on } from "solid-js"
import type { createTaskQueueFeed } from "./tasks-data"

export const TASK_QUEUE_PANEL = "task-queue"

/** App-owned viewing state. It never acquires execution ownership. */
export function createTaskQueueDisplay(options: {
  feed: ReturnType<typeof createTaskQueueFeed>
  route: () => string
  panel: () => { name: string; sessionID: string } | undefined
  navigate: (sessionID: string) => void
  open: (sessionID: string) => void
  close: () => void
}) {
  const [queueID, setQueueID] = createSignal<string>()
  const [following, setFollowing] = createSignal(false)
  const [visible, setVisible] = createSignal(false)
  const info = createMemo(() => options.feed.items().find((item) => item.id === queueID()))
  let navigation: string | undefined
  let routeVersion = 0
  let intent = 0
  let shown = false
  let reveal: (() => boolean | void) | undefined

  function reset() {
    intent++
    batch(() => {
      setFollowing(false)
      setVisible(false)
      setQueueID(undefined)
      shown = false
      reveal = undefined
      navigation = undefined
      options.close()
    })
  }

  createEffect(on(options.route, (route) => {
    routeVersion++
    if (route === navigation) { navigation = undefined; return }
    if (!queueID()) return
    setFollowing(false)
    if (info()?.tasks.some((task) => task.sessionID === route)) {
      if (visible() && shown && options.panel()?.name === TASK_QUEUE_PANEL) options.open(route)
      return
    }
    setVisible(false)
    shown = false
    reveal = undefined
    options.close()
  }, { defer: true }))

  createEffect(on(options.panel, (panel) => {
    // Closing or replacing a panel is an explicit user choice, not a request to reopen it.
    if ((!shown && !visible()) || panel?.name === TASK_QUEUE_PANEL) return
    shown = false
    setVisible(false)
    setFollowing(false)
    reveal = undefined
  }))

  createEffect(() => {
    const id = queueID()
    if (id && options.feed.missing(id)) reset()
  })

  function show(sessionID: string) {
    // A newer dialog edit/preview supersedes automatic reveal, not execution.
    const allowed = reveal?.() !== false
    reveal = undefined
    if (!allowed) {
      setFollowing(false)
      setVisible(false)
      return
    }
    if (options.route() !== sessionID) navigation = sessionID
    options.navigate(sessionID)
    if (!visible()) return
    options.open(sessionID)
    shown = true
  }

  createEffect(on([info, following, visible], ([current, following, visible]) => {
    if (!current || !following) return
    const task = current.tasks.find((task) => task.id === current.currentTaskID)
    // A very short task can finish before start resolves. Keep the last available result inspectable.
    const sessionID = task?.sessionID ?? (current.status !== "running" ? current.tasks.findLast((task) => task.sessionID)?.sessionID : undefined)
    if (!sessionID) return
    if (options.route() === sessionID && (!visible || options.panel()?.sessionID === sessionID)) return
    show(sessionID)
  }))

  return {
    info, following, visible, reset,
    prepare() {
      const valid = options.feed.capture()
      const version = routeVersion
      const ticket = ++intent
      const panel = options.panel()
      // Closing /tasks does not revoke this intent; navigating elsewhere does.
      return (value: TaskQueueInfo, onReveal: () => boolean | void) => {
        if (!valid() || version !== routeVersion || ticket !== intent || options.panel() !== panel) return
        options.feed.update(value)
        batch(() => {
          setQueueID(value.id)
          setVisible(true)
          reveal = onReveal
          setFollowing(true)
        })
      }
    },
    view(value: TaskQueueInfo, sessionID: string) {
      if (!value.tasks.some((task) => task.sessionID === sessionID)) return
      intent++
      // Explicit viewing supersedes the previous automatic reveal's dialog authorization.
      reveal = undefined
      batch(() => {
        options.feed.update(value)
        setFollowing(false)
        setQueueID(value.id)
        setVisible(true)
        show(sessionID)
      })
    },
    follow() { setFollowing(true) },
  }
}
