import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnvironment } from "../../script/windows-runtime"

// Only this fixture's freshly allocated root is owned, never a custom DB override's parent.
export async function isolatedRoot(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    if (process.platform === "win32") {
      const { FileMode } = await import("@opencode/util/file-mode")
      await FileMode.directory(root, { owned: true })
      await FileMode.directory(root)
    }
    return root
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  }
}

export function isolatedEnv(root: string, overrides: Record<string, string | undefined> = {}) {
  return {
    ...isolatedEnvironment(root),
    HOME: root,
    OPENCODE_CLI_CONFIG_CONTENT: undefined,
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_CONFIG_DIR: path.join(root, "config"),
    OPENCODE_DB: path.join(root, "opencode.db"),
    OPENCODE_DISABLE_FILEWATCHER: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_TEST_HOME: root,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    ...overrides,
  }
}
