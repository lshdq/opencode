import { useConfig } from "../config"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"
import { createSignal } from "solid-js"
import { Keymap } from "./keymap"

export type PermissionMode = "prompt" | "autoaccept"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const config = useConfig()
    const [override, setOverride] = createSignal<PermissionMode>()
    const permission = {
      get mode(): PermissionMode {
        return override() ?? (args.auto ? "autoaccept" : config.data.session.permissions)
      },
      toggle() {
        setOverride(permission.mode === "autoaccept" ? "prompt" : "autoaccept")
      },
    }
    // This provider sits above the tabs. Never persist an instance-local override.
    Keymap.createLayer(() => ({
      mode: "global",
      commands: [
        {
          id: "permission.mode",
          title:
            permission.mode === "autoaccept" ? "Disable auto-accept permissions" : "Enable auto-accept permissions",
          group: "Session",
          palette: true,
          run: () => permission.toggle(),
        },
      ],
    }))
    return permission
  },
})
