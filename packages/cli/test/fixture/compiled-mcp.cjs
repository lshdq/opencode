// A real stdio MCP peer for the compiled Windows bundle smoke; never contacts a provider.
const fs = require("node:fs")
const readline = require("node:readline")
fs.writeFileSync(process.argv[2], String(process.pid))
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "compiled-fixture", version: "1" },
        }
      : request.method === "tools/list"
        ? { tools: [{ name: "echo", description: "Offline fixture", inputSchema: { type: "object", properties: {} } }] }
        : {}
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
})
