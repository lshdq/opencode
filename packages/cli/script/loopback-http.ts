import { request } from "node:http"
import type { IncomingMessage } from "node:http"

const bodyLimit = 16 * 1024 * 1024

/** Direct, bounded HTTP for owned test services. localhost is pinned to IPv4;
 * use [::1] explicitly for IPv6. No DNS, proxy, redirect, or URL credentials.
 */
export async function loopbackRequest(
  input: string | URL,
  options: {
    method?: string
    headers?: HeadersInit
    body?: string | Uint8Array
    signal?: AbortSignal
    timeoutMs?: number
    maxResponseBytes?: number
  } = {},
) {
  const url = new URL(input)
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))
    throw new Error("Only explicit loopback HTTP endpoints are allowed")
  if (!url.port || Number(url.port) < 1 || url.username || url.password || url.hash)
    throw new Error("Loopback HTTP requires a non-default explicit port and no URL credentials or fragment")
  const method = options.method?.toUpperCase() ?? "GET"
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method))
    throw new Error("Unsupported loopback HTTP method")
  const headers = new Headers(options.headers)
  if (["host", "proxy-authorization", "proxy-connection"].some((name) => headers.has(name)))
    throw new Error("Host and proxy credential overrides are not allowed")
  const timeout = options.timeoutMs ?? 5_000
  const limit = options.maxResponseBytes ?? bodyLimit
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 120_000)
    throw new Error("Invalid loopback HTTP timeout")
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > bodyLimit)
    throw new Error("Invalid loopback HTTP response limit")
  if (options.body !== undefined && Buffer.byteLength(options.body) > bodyLimit)
    throw new Error("Loopback HTTP request body exceeds limit")
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Loopback HTTP aborted")

  return new Promise<Response>((resolve, reject) => {
    let settled = false
    let response: IncomingMessage | undefined
    const call = request(
      {
        protocol: "http:",
        hostname: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: Object.fromEntries(headers),
        agent: false,
        maxHeaderSize: 64 * 1024,
      },
      (incoming) => {
        response = incoming
        const status = incoming.statusCode ?? 500
        const noBody = method === "HEAD" || [204, 205, 304].includes(status)
        const chunks: Uint8Array[] = []
        let size = 0
        incoming.once("error", (error) => finish(error))
        incoming.once("aborted", () => finish(new Error("Loopback HTTP response aborted")))
        incoming.once("close", () => {
          if (!incoming.complete) finish(new Error("Loopback HTTP response truncated"))
        })
        const declared = incoming.headers["content-length"]
        if (!noBody && declared !== undefined && Number(declared) > limit) {
          finish(new Error("Loopback HTTP response body exceeds limit"))
          return
        }
        incoming.on("data", (chunk: Uint8Array) => {
          if (settled) return
          size += chunk.byteLength
          if (size > limit) {
            finish(new Error("Loopback HTTP response body exceeds limit"))
            return
          }
          chunks.push(chunk)
        })
        incoming.once("end", () => {
          if (settled) return
          try {
            const fields = new Headers()
            for (let index = 0; index < incoming.rawHeaders.length; index += 2)
              fields.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
            finish(
              undefined,
              new Response(noBody ? null : Buffer.concat(chunks), {
                status,
                statusText: incoming.statusMessage,
                headers: fields,
              }),
            )
          } catch (error) {
            finish(error)
          }
        })
      },
    )
    const timer = setTimeout(() => finish(new Error("Loopback HTTP request timed out")), timeout)
    const abort = () => finish(options.signal?.reason ?? new Error("Loopback HTTP aborted"))
    call.once("error", (error) => finish(error))
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    if (!settled) call.end(options.body)

    function finish(error?: unknown, value?: Response) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      response?.destroy()
      call.destroy()
      if (error !== undefined) return reject(error)
      if (value) return resolve(value)
      reject(new Error("Loopback HTTP ended without a response"))
    }
  })
}
