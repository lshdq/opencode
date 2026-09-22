import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Spinner } from "./spinner"
import { cliErrorMessage, errorMessage } from "../util/error"

export function StartupLoading(props: { ready: () => boolean; error?: () => unknown }) {
  const theme = useTheme().theme
  const [show, setShow] = createSignal(false)
  const text = createMemo(() => (props.ready() ? "Ready" : "Preparing dependencies and plugins… You can type now"))
  let wait: NodeJS.Timeout | undefined
  let hold: NodeJS.Timeout | undefined
  let stamp = 0

  createEffect(() => {
    if (props.ready()) {
      if (wait) {
        clearTimeout(wait)
        wait = undefined
      }
      if (!show()) return
      if (hold) return

      const left = 3000 - (Date.now() - stamp)
      if (left <= 0) {
        setShow(false)
        return
      }

      hold = setTimeout(() => {
        hold = undefined
        setShow(false)
      }, left).unref()
      return
    }

    if (hold) {
      clearTimeout(hold)
      hold = undefined
    }
    if (show()) return
    if (wait) return

    wait = setTimeout(() => {
      wait = undefined
      stamp = Date.now()
      setShow(true)
    }, 500).unref()
  })

  onCleanup(() => {
    if (wait) clearTimeout(wait)
    if (hold) clearTimeout(hold)
  })

  return (
    <Show when={show() || props.error?.() !== undefined}>
      <box flexShrink={0} justifyContent="center" alignItems="center">
        <box backgroundColor={theme.backgroundPanel} paddingLeft={1} paddingRight={1}>
          <Show
            when={props.error?.() === undefined}
            fallback={
              <text fg={theme.error}>
                Startup failed: {cliErrorMessage(props.error?.()) ?? errorMessage(props.error?.())}
              </text>
            }
          >
            <Spinner color={theme.textMuted}>{text()}</Spinner>
          </Show>
        </box>
      </box>
    </Show>
  )
}
