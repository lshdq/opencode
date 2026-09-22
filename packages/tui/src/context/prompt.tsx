import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"
import { createSignal } from "solid-js"
import { unwrap } from "solid-js/store"
import { useRoute } from "./route"

export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    const [current, setCurrent] = createSignal<PromptRef>()
    const route = useRoute()
    let revision = route.revision
    let saved: { revision: number; prompt: PromptRef["current"]; pending: boolean } | undefined

    return {
      get current() {
        return current()
      },
      set(ref: PromptRef | undefined) {
        const previous = current()
        if (!ref && previous) {
          saved = { revision, prompt: structuredClone(unwrap(previous.current)), pending: previous.pending === true }
        }
        if (ref) {
          revision = route.revision
          const restore = saved
          saved = undefined
          if (restore?.revision === revision && !ref.current.input) {
            ref.set(restore.prompt)
            if (restore.pending) {
              queueMicrotask(() => {
                if (current() === ref && route.revision === restore.revision) ref.submit()
              })
            }
          }
        }
        setCurrent(ref)
      },
    }
  },
})
