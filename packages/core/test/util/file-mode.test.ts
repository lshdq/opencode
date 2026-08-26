import { describe, expect, mock, test } from "bun:test"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "path"
import { applyFileMode } from "../../src/util/file-mode"
import {
  accessFailureStatus,
  completeACL,
  powershellEnvironment,
  resolveSystemRoot,
  restoreACL,
  retryBoolean,
  windowsCommands,
} from "../../src/util/file-mode-state"

function icaclsOutput(file: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(windowsCommands(systemRoot()).icacls, [file], { encoding: "latin1" }, (error, stdout) =>
      resolve(String(stdout)),
    )
  })
}

function currentUserSID(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      windowsCommands(systemRoot()).whoami,
      ["/user", "/fo", "csv", "/nh"],
      { encoding: "latin1" },
      (error, stdout) => {
        if (error) return reject(error)
        const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(stdout)?.[1]
        if (!sid) return reject(new Error("whoami did not return a user SID"))
        resolve(sid)
      },
    )
  })
}

function aclContainsSID(file: string, sid: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      windowsCommands(systemRoot()).icacls,
      [file, "/findsid", `*${sid}`],
      { encoding: "latin1" },
      (error, stdout) => {
        resolve(!error && stdout.toLowerCase().includes(file.toLowerCase()))
      },
    )
  })
}

function grantSID(file: string, sid: string, perms: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(windowsCommands(systemRoot()).icacls, [file, "/grant:r", `*${sid}:(${perms})`], (error) => {
      if (error) return reject(error)
      resolve()
    })
  })
}

// Tightened files lose DELETE (R/W does not include it), so restore inheritance before removal.
function resetACL(file: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(windowsCommands(systemRoot()).icacls, [file, "/reset"], () => resolve())
  })
}

function aclRules(file: string): Promise<Array<{ sid: string; type: string; inherited: boolean; rights: number }>> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "foreach ($rule in (Get-Acl -LiteralPath $env:OPENCODE_TEST_ACL_PATH).Access) {",
    "$sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "[Console]::Out.WriteLine(('{0}|{1}|{2}|{3}' -f $sid, $rule.AccessControlType, $rule.IsInherited, [int]$rule.FileSystemRights))",
    "}",
  ].join("; ")
  return new Promise((resolve, reject) => {
    execFile(
      windowsCommands(systemRoot()).powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "latin1",
        env: powershellEnvironment(systemRoot(), {
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          OPENCODE_TEST_ACL_PATH: file,
        }),
      },
      (error, stdout) => {
        if (error) return reject(error)
        resolve(
          stdout
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
              const fields = line.split("|")
              return { sid: fields[0], type: fields[1], inherited: fields[2] === "True", rights: Number(fields[3]) }
            }),
        )
      },
    )
  })
}

function systemRoot(): string {
  return process.env.SystemRoot ?? "C:\\Windows"
}

describe("applyFileMode", () => {
  // Spoof the environment used by the old implementation so a bare USERNAME
  // resolves to the computer account even when the real names differ.
  test.skipIf(process.platform !== "win32" || !process.env.COMPUTERNAME)(
    "tightens ACL to the current user SID without locking them out",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "opencode-file-mode-"))
      const file = path.join(directory, "auth.json")
      const username = process.env.USERNAME
      try {
        await writeFile(file, "{}")
        const sid = await currentUserSID()
        process.env.USERNAME = process.env.COMPUTERNAME

        await applyFileMode(file, 0o600)

        await writeFile(file, '{"ok":true}')
        expect(await readFile(file, "utf8")).toBe('{"ok":true}')
        expect(await aclContainsSID(file, sid)).toBe(true)
        const out = await icaclsOutput(file)
        expect(out).not.toContain("(I)")
        expect(out).not.toMatch(/\\:\(/)
      } finally {
        if (username === undefined) delete process.env.USERNAME
        else process.env.USERNAME = username
        await resetACL(file).catch(() => {})
        await rm(directory, { recursive: true, force: true })
      }
    },
    15_000,
  )

  test.skipIf(process.platform !== "win32")(
    "removes other explicit access rules",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "opencode-file-mode-"))
      const file = path.join(directory, "auth.json")
      try {
        await writeFile(file, "{}")
        const sid = await currentUserSID()
        await grantSID(file, "S-1-1-0", "R,W")

        await applyFileMode(file, 0o600)

        expect(await aclContainsSID(file, sid)).toBe(true)
        expect(await aclContainsSID(file, "S-1-1-0")).toBe(false)
        expect(await icaclsOutput(file)).not.toContain("(I)")
        expect(await aclRules(file)).toEqual([{ sid, type: "Allow", inherited: false, rights: 1180063 }])
      } finally {
        await resetACL(file).catch(() => {})
        await rm(directory, { recursive: true, force: true })
      }
    },
    15_000,
  )

  test.skipIf(process.platform !== "win32")("skips tightening for group-readable modes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-file-mode-"))
    try {
      const file = path.join(directory, "shared.txt")
      await writeFile(file, "{}")

      await applyFileMode(file, 0o644)

      expect(await icaclsOutput(file)).toContain("(I)")
      await writeFile(file, '{"ok":true}')
      expect(await readFile(file, "utf8")).toBe('{"ok":true}')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== "win32")("does not throw when Windows chmod fails", async () => {
    await expect(applyFileMode(path.join(tmpdir(), "opencode-file-mode-missing", "auth.json"), 0o600)).resolves.toBe(
      undefined,
    )
  })

  test.skipIf(process.platform !== "win32")(
    "keeps write-only modes tightened",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "opencode-file-mode-"))
      const file = path.join(directory, "write-only.txt")
      try {
        await writeFile(file, "before")

        await applyFileMode(file, 0o200)

        expect(await icaclsOutput(file)).not.toContain("(I)")
        await writeFile(file, "after")
        await expect(readFile(file, "utf8")).rejects.toThrow()
      } finally {
        await resetACL(file).catch(() => {})
        await rm(directory, { recursive: true, force: true })
      }
    },
    15_000,
  )

  test.skipIf(process.platform === "win32")("applies unix mode bits when not on Windows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opencode-file-mode-"))
    try {
      const file = path.join(directory, "auth.json")
      await writeFile(file, "{}")

      await applyFileMode(file, 0o600)

      expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("file mode ACL state", () => {
  test("does not restore safe or unknown results", async () => {
    const verify = mock(async () => true)
    const restore = mock(async () => {})

    await completeACL("safe", { verify, restore })
    await completeACL("unknown", { verify, restore })

    expect(verify).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })

  test("restores only unsafe results", async () => {
    const verify = mock(async () => true)
    const restore = mock(async () => {})

    await completeACL("unsafe", { verify, restore })

    expect(verify).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledTimes(1)
  })

  test("verifies tightened results without restoring", async () => {
    const verify = mock(async () => true)
    const restore = mock(async () => {})

    await completeACL("tightened", { verify, restore })

    expect(verify).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()
  })

  test("restores tightened ACLs that fail access verification", async () => {
    const verify = mock(async () => false)
    const restore = mock(async () => {})

    await completeACL("tightened", { verify, restore })

    expect(verify).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  test("retries failed recovery operations three times", async () => {
    const operation = mock(async () => false)
    const wait = mock(async () => {})

    expect(await retryBoolean(operation, wait, 3)).toBe(false)
    expect(operation).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(2)
  })

  test("rejects invalid retry counts and stops after early success", async () => {
    const operation = mock(async () => true)
    const wait = mock(async () => {})

    for (const attempts of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(retryBoolean(operation, wait, attempts)).rejects.toThrow("attempts must be a positive integer")
    }
    expect(await retryBoolean(operation, wait, 1)).toBe(true)
    expect(await retryBoolean(operation, wait, 3)).toBe(true)
    expect(operation).toHaveBeenCalledTimes(2)
    expect(wait).not.toHaveBeenCalled()
  })

  test("falls back from reset to inheritance in order", async () => {
    const calls: string[] = []
    const result = await restoreACL({
      reset: async () => (calls.push("reset"), false),
      inherit: async () => (calls.push("inherit"), true),
      verify: async () => (calls.push("verify"), true),
      wait: async () => {
        calls.push("wait")
      },
    })

    expect(result).toBe(true)
    expect(calls).toEqual(["reset", "wait", "reset", "wait", "reset", "inherit", "verify"])
  })

  test("stops after a verified reset", async () => {
    const calls: string[] = []
    const result = await restoreACL({
      reset: async () => (calls.push("reset"), true),
      inherit: async () => (calls.push("inherit"), true),
      verify: async () => (calls.push("verify"), true),
      wait: async () => {
        calls.push("wait")
      },
    })

    expect(result).toBe(true)
    expect(calls).toEqual(["reset", "verify"])
  })

  test("falls back when reset verification fails", async () => {
    const calls: string[] = []
    const results = [false, true]
    const result = await restoreACL({
      reset: async () => (calls.push("reset"), true),
      inherit: async () => (calls.push("inherit"), true),
      verify: async () => (calls.push("verify"), results.shift() ?? false),
      wait: async () => {
        calls.push("wait")
      },
    })

    expect(result).toBe(true)
    expect(calls).toEqual(["reset", "verify", "inherit", "verify"])
  })

  test("builds absolute commands and a minimal PowerShell environment", () => {
    const root = "X:\\TrustedWindows"
    const commands = windowsCommands(root)
    const env = powershellEnvironment(root, { TEMP: "X:\\Temp", OPENCODE_FILE_MODE_PATH: "X:\\file" })

    expect(Object.values(commands).every(path.win32.isAbsolute)).toBe(true)
    expect(commands.whoami).toBe("X:\\TrustedWindows\\System32\\whoami.exe")
    expect(env.OPENCODE_FILE_MODE_PATH).toBe("X:\\file")
    expect(env.PATH).toBeUndefined()
    expect(env.OPENCODE_AUTH_CONTENT).toBeUndefined()
    expect(resolveSystemRoot(undefined)).toBe("C:\\Windows")
    expect(resolveSystemRoot("relative\\windows")).toBe("C:\\Windows")
    expect(resolveSystemRoot("\\attacker")).toBe("C:\\Windows")
    expect(resolveSystemRoot("\\\\server\\share")).toBe("C:\\Windows")
    expect(resolveSystemRoot("C:relative")).toBe("C:\\Windows")
    expect(resolveSystemRoot(root)).toBe(root)
  })

  test("classifies access failures without widening busy ACLs", () => {
    expect(accessFailureStatus("EBUSY", false)).toBe("retry")
    expect(accessFailureStatus("EACCES", false)).toBe("retry")
    expect(accessFailureStatus("EPERM", false)).toBe("retry")
    expect(accessFailureStatus("EBUSY", true)).toBe("busy")
    expect(accessFailureStatus("EACCES", true)).toBe("denied")
    expect(accessFailureStatus("EPERM", true)).toBe("denied")
    expect(accessFailureStatus("ENOENT", false)).toBe("denied")
  })
})
