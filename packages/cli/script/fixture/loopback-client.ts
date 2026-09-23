import assert from "node:assert/strict"
import { loopbackRequest } from "../loopback-http"

const base = process.argv[2]
const headers = { authorization: "Basic synthetic-loopback-only" }
const ok = await loopbackRequest(`${base}/ok`, { headers })
assert.equal(ok.status, 200)
assert.equal(ok.headers.get("x-target"), "owned")
assert.equal((await ok.json()).auth, headers.authorization)
const alias = await loopbackRequest(base.replace("127.0.0.1", "localhost") + "/ok", { headers })
assert.equal(alias.status, 200)
const rpc = await loopbackRequest(`${base}/rpc`, {
  method: "PUT",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ config: { command: ["fixture", "with spaces"] } }),
  timeoutMs: 60_000,
})
assert.equal(rpc.status, 201)
assert.deepEqual((await rpc.json()).body, { config: { command: ["fixture", "with spaces"] } })
const binary = await loopbackRequest(`${base}/binary`, { method: "POST", headers, body: new Uint8Array([0, 128, 255]) })
assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), new Uint8Array([0, 128, 255]))
assert.equal((await loopbackRequest(`${base}/empty`, { method: "DELETE", headers })).status, 204)
const cors = await loopbackRequest(`${base}/cors`, {
  method: "OPTIONS",
  headers: { ...headers, origin: "https://fixture.invalid" },
})
assert.equal(cors.status, 204)
assert.equal(cors.headers.get("access-control-allow-origin"), "https://fixture.invalid")
assert.equal(await (await loopbackRequest(`${base}/ok`, { method: "HEAD", headers })).text(), "")
const head = await loopbackRequest(`${base}/large-head`, { method: "HEAD", headers, maxResponseBytes: 64 })
assert.equal(head.status, 200)
assert.equal(head.headers.get("content-length"), "100000")
assert.equal(await head.text(), "")
const unauthorized = await loopbackRequest(`${base}/unauthorized`)
assert.equal(unauthorized.status, 401)
assert.equal(unauthorized.statusText, "Unauthorized")
assert.equal(unauthorized.headers.get("www-authenticate"), 'Basic realm="fixture"')
assert.equal(await unauthorized.text(), "denied")
const failed = await loopbackRequest(`${base}/failed`, { headers })
assert.equal(failed.status, 500)
assert.equal(failed.statusText, "Internal Server Error")
assert.deepEqual(await failed.json(), { error: "fixture" })
const redirect = await loopbackRequest(`${base}/redirect`, { headers })
assert.equal(redirect.status, 302)
assert.equal(redirect.headers.get("location"), "http://outside.invalid:1234/")
for (const route of ["large", "chunked"]) {
  await assert.rejects(loopbackRequest(`${base}/${route}`, { headers, maxResponseBytes: 64 }), /exceeds limit/)
}
await assert.rejects(loopbackRequest(`${base}/truncated`, { headers }), /aborted|truncated|socket|reset/i)
await assert.rejects(loopbackRequest(`${base}/hang`, { headers, timeoutMs: 50 }), /timed out/)
await assert.rejects(loopbackRequest(`${base}/slow-body`, { headers, timeoutMs: 50 }), /timed out/)
const aborted = new AbortController()
aborted.abort(new Error("pre-abort"))
await assert.rejects(loopbackRequest(`${base}/must-not-run`, { headers, signal: aborted.signal }), /pre-abort/)
const active = new AbortController()
const timer = setTimeout(() => active.abort(new Error("active-abort")), 50)
try {
  await assert.rejects(loopbackRequest(`${base}/hang`, { headers, signal: active.signal }), /active-abort/)
} finally {
  clearTimeout(timer)
}
console.log("loopback transport assertions passed")
