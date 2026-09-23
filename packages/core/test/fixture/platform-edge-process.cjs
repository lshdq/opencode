const fs = require("node:fs")
const { spawn } = require("node:child_process")
const mode = process.argv[2]

// A last resort even if the test runner is interrupted. No fixture can become a daemon.
setTimeout(() => process.exit(0), 20000)
setInterval(() => {
  if (fs.existsSync("stop")) process.exit(0)
}, 25)
process.stdout.on("error", () => {})
process.stderr.on("error", () => {})

if (mode === "child") {
  fs.writeFileSync("child.pid", String(process.pid))
  fs.writeFileSync("child.ready", "ready")
} else {
  fs.writeFileSync("parent.pid", String(process.pid))
  const child = spawn(process.execPath, [__filename, "child"], {
    detached: mode === "shell" || mode.endsWith("-detached"),
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  })
  child.on("error", () => process.exit(1))
  child.unref()
  const ready = setInterval(() => {
    if (!fs.existsSync("child.ready")) return
    clearInterval(ready)
    fs.writeSync(1, JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\n")
    fs.writeSync(2, "foreground-error\n")
    if (mode === "shell" || mode.startsWith("mcp-early")) process.exit(0)
    if (mode === "mcp" || mode === "mcp-detached") process.stdin.resume().once("end", () => process.exit(0))
  }, 10)
}
