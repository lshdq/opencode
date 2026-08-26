import { win32 } from "node:path"

export type TightenResult = "tightened" | "safe" | "unsafe" | "unknown"
export type AccessStatus = "retry" | "busy" | "denied"

export async function completeACL(
  result: TightenResult,
  operations: { verify: () => Promise<boolean>; restore: () => Promise<unknown> },
): Promise<void> {
  if (result === "tightened") {
    if (!(await operations.verify())) await operations.restore()
    return
  }
  if (result === "unsafe") await operations.restore()
}

export async function retryBoolean(
  operation: () => Promise<boolean>,
  wait: () => Promise<unknown>,
  attempts: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new RangeError("attempts must be a positive integer")
  const success = await operation()
  if (success || attempts === 1) return success
  await wait()
  return retryBoolean(operation, wait, attempts - 1)
}

export async function restoreACL(operations: {
  reset: () => Promise<boolean>
  inherit: () => Promise<boolean>
  verify: () => Promise<boolean>
  wait: () => Promise<unknown>
}): Promise<boolean> {
  const reset = await retryBoolean(operations.reset, operations.wait, 3)
  if (reset && (await operations.verify())) return true
  const inherited = await retryBoolean(operations.inherit, operations.wait, 3)
  return inherited && (await operations.verify())
}

export function windowsCommands(root: string) {
  const trustedRoot = resolveSystemRoot(root)
  return {
    cmd: win32.join(trustedRoot, "System32", "cmd.exe"),
    icacls: win32.join(trustedRoot, "System32", "icacls.exe"),
    powershell: win32.join(trustedRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    powershellModules: win32.join(trustedRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
    whoami: win32.join(trustedRoot, "System32", "whoami.exe"),
  }
}

export function powershellEnvironment(root: string, variables: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const trustedRoot = resolveSystemRoot(root)
  const commands = windowsCommands(trustedRoot)
  return {
    SystemRoot: trustedRoot,
    windir: trustedRoot,
    ComSpec: commands.cmd,
    PSModulePath: commands.powershellModules,
    ...variables,
  }
}

export function resolveSystemRoot(root: string | undefined): string {
  return root && /^[A-Za-z]:[\\/]/.test(root) ? win32.normalize(root) : "C:\\Windows"
}

export function accessFailureStatus(code: unknown, exhausted: boolean): AccessStatus {
  if (code !== "EACCES" && code !== "EPERM" && code !== "EBUSY") return "denied"
  if (!exhausted) return "retry"
  return code === "EBUSY" ? "busy" : "denied"
}
