import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, onMount, untrack } from "solid-js"
import { Logo } from "../component/logo"
import { Toast } from "../ui/toast"
import { useRoute, useRouteData } from "../context/route"
import { useProject } from "../context/project"
import { useSync } from "../context/sync"
import { usePromptRef } from "../context/prompt"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { HomeSessionDestinationProvider } from "./home/session-destination"

const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const route = useRouteData("home")
  const navigation = useRoute()
  const project = useProject()
  const sync = useSync()
  createEffect(() => {
    navigation.revision
    if (navigation.data.type !== "home" || !project.workspace.removed(project.workspace.current())) return
    // Repeated Home navigation cancels the old candidate, not the deletion fact.
    // recover deduplicates with both deletion dialogs and retains owner failures.
    untrack(() => void sync.recover(navigation.signal).catch(() => {}))
  })
  const promptRef = usePromptRef()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  let seeded = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    if (!seeded && r && route.prompt) {
      r.set(route.prompt)
      seeded = true
    }
    promptRef.set(r)
  }

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <Logo />
          </pluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt ref={bind} right={<pluginRuntime.Slot name="home_prompt_right" />} placeholders={placeholder} />
          </pluginRuntime.Slot>
        </box>
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}
