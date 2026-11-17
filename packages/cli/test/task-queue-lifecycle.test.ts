import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { OpenCode, type OpenCodeClient, type TaskQueueInfo } from "@opencode/client"
import type { Info } from "@opencode/client/effect/service"
import { Schema } from "effect"
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { startupTimeout, stopOwned, waitForInfo } from "./fixture/service-lifecycle"

const Chat = Schema.Struct({
  stream: Schema.optional(Schema.Boolean),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
})
const markers = ["TQ_FIRST", "TQ_HOLD", "TQ_LAST", "TQ_CHILD", "TQ_GRANDCHILD", "TQ_ORDINARY"] as const
type Marker = (typeof markers)[number]
const entry = path.join(import.meta.dir, "../src/index.ts")

// TC-012/013/018/027: real source CLI, generated client, database and execution pipeline.
// These are adapter/ownership tests, not live TUI tests or an assessment of model judgement.
test.each(["stop-release", "kill-owner", "crash-server"] as const)(
  "private task work stays stopped after %s until an explicit same-session resume",
  async (mode) => {
    const base = await realpath(
      process.env.OPENCODE_TEST_TMP ?? (process.platform === "win32" ? "D:/temp/aiRunner/opencode" : os.tmpdir()),
    )
    const root = await mkdtemp(path.join(base, "q-"))
    const project = path.join(root, "p")
    const temp = path.join(root, "t")
    const model = controlledModel()
    const env = isolatedEnv(root, {
      TEMP: temp,
      TMP: temp,
      TMPDIR: temp,
      OPENCODE_DISABLE_FFF: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        update: "disable",
        experimental: { task_queue: true },
        model: "fixture/fixture",
        providers: {
          fixture: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `${model.url}/v1`, apiKey: "local-test-only" },
            models: {
              fixture: {
                limit: { context: 32000, output: 2000 },
                capabilities: { tools: true, input: ["text"], output: ["text"] },
              },
            },
          },
        },
      }),
    })
    const processes: Bun.Subprocess[] = []
    const servers: { pid: number; url: string }[] = []
    const output: Promise<string>[] = []
    const spawn = (args: string[]) => {
      const proc = Bun.spawn([process.execPath, ...args], {
        cwd: path.join(import.meta.dir, ".."),
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      processes.push(proc)
      output.push(new Response(proc.stdout).text(), new Response(proc.stderr).text())
      return proc
    }
    try {
      await Promise.all([project, temp].map((dir) => mkdir(dir, { recursive: true })))
      const endpointFile = path.join(root, "endpoint.json")
      const owner = spawn([path.join(import.meta.dir, "fixture/task-queue-owner.ts"), endpointFile])
      const endpoint = await waitForInfo(endpointFile, [owner])
      servers.push(endpoint)
      const client = clientFor(endpoint)
      expect((await client.server.info()).pid).toBe(endpoint.pid)
      const queue = await client.experimental.taskQueue.create({
        directory: project,
        title: "Private lifecycle",
        tasks: [
          { title: "TQ_FIRST", prompt: "Reply OK for TQ_FIRST; do not call tools." },
          { title: "TQ_HOLD", prompt: "Reply OK for TQ_HOLD; do not call tools." },
          { title: "TQ_LAST", prompt: "Reply OK for TQ_LAST; do not call tools." },
        ],
      })
      await client.experimental.taskQueue.start({ queueID: queue.id })
      // A real outbound LLM request is held open. Merely seeing start's running response is insufficient.
      await model.wait("TQ_HOLD", 1)
      const running = await queueState(
        client, queue.id,
        (value) => value.tasks[0]?.status === "completed" && value.tasks[1]?.status === "running",
      )
      const sessionID = running.tasks[1]!.sessionID!
      expect(sessionID).toBeString()
      expect(running.tasks[2]!.status).toBe("pending")
      expect(running.tasks[2]!.sessionID).toBeUndefined()
      expect(claims(env.OPENCODE_DB, [sessionID])[0]!.time_suspended).not.toBeNull()

      // The abrupt-server case leaves real root/descendant and ordinary execution claims for a managed sweep.
      const descendants: string[] = []
      const ordinary = mode === "crash-server"
        ? await client.session.create({ title: "Recovery canary", location: { directory: project } })
        : undefined
      if (ordinary) {
        const child = await client.session.create({ title: "Child", parentID: sessionID, location: { directory: project } })
        const grandchild = await client.session.create({
          title: "Grandchild", parentID: child.id, location: { directory: project },
        })
        descendants.push(child.id, grandchild.id)
        await Promise.all([
          client.session.prompt({ sessionID: child.id, text: "Reply OK for TQ_CHILD without tools." }),
          client.session.prompt({ sessionID: grandchild.id, text: "Reply OK for TQ_GRANDCHILD without tools." }),
          client.session.prompt({ sessionID: ordinary.id, text: "Reply OK for TQ_ORDINARY without tools." }),
        ])
        await Promise.all([model.wait("TQ_CHILD", 1), model.wait("TQ_GRANDCHILD", 1), model.wait("TQ_ORDINARY", 1)])
        expect(claims(env.OPENCODE_DB, [sessionID, ...descendants, ordinary.id])
          .every((row) => row.time_suspended !== null)).toBe(true)
      }
      if (mode === "stop-release") {
        const stopped = await client.experimental.taskQueue.stop({ queueID: queue.id, reason: "owner exited normally" })
        expect(stopped.status).toBe("stopped")
        expect(stopped.tasks[1]!.status).toBe("interrupted")
        owner.stdin.end()
        expect(await deadline(owner.exited, 10_000, "owner scope release")).toBe(0)
      }
      if (mode === "kill-owner") {
        // Target only the owner PID, not a test runner's subprocess/tree cleanup helper.
        process.kill(owner.pid, "SIGKILL")
        await deadline(owner.exited, 10_000, "owner SIGKILL")
      }
      if (mode === "crash-server") {
        process.kill(endpoint.pid, "SIGKILL")
        owner.stdin.end()
        await deadline(owner.exited, 10_000, "owner of crashed server")
      }
      await exited(endpoint.pid)
      await expectNotListening(endpoint.url)
      // kill-owner never explicitly targets the child: its ownership ends with the owner's death.
      const before = model.counts()
      if (mode === "crash-server") {
        expect(claims(env.OPENCODE_DB, [sessionID, ...descendants, ordinary!.id])
          .every((row) => row.time_suspended !== null)).toBe(true)
      }

      // --service is essential: ordinary serve/stdio does NOT install SessionRestart continuity.
      // The profile, registration, port and DB are all private; no discovery of a user's service occurs.
      const managed = spawn([entry, "serve", "--service", "--hostname", "127.0.0.1", "--port", "0"])
      const registration = path.join(root, "state", "opencode", "service-local.json")
      const replacement = await waitForInfo(registration, [managed])
      servers.push(replacement)
      expect(replacement.pid).toBe(managed.pid)
      const reopened = clientFor(replacement)
      await until(async () => {
        const response = await fetch(new URL("/api/info", replacement.url), {
          headers: headers(replacement), signal: AbortSignal.timeout(2000),
        })
        return response.status === 200
      }, startupTimeout, "managed server ready")
      const recovered = await queueState(
        reopened, queue.id,
        (value) => value.status === "stopped" || value.status === "interrupted",
      )
      expect(recovered.tasks.map((task) => task.status)).toEqual(["completed", "interrupted", "pending"])
      expect(recovered.tasks[1]!.sessionID).toBe(sessionID)
      if (mode === "crash-server") expect(recovered.status).toBe("interrupted")
      if (mode === "stop-release") expect(recovered.status).toBe("stopped")
      // An owner SIGKILL always closes the pipe, but the platform's child teardown may preempt
      // server finalizers. Either durable stopped or dead-owner interrupted requires explicit resume.
      if (mode === "kill-owner") expect(["stopped", "interrupted"]).toContain(recovered.status)
      // Opening the old session is a read, never ownership adoption.
      expect((await reopened.session.get({ sessionID })).id).toBe(sessionID)
      if (ordinary) {
        // A real restarted ordinary drain proves the managed recovery path ran, not just a queue status update.
        await model.wait("TQ_ORDINARY", before.TQ_ORDINARY + 1)
        model.release("TQ_ORDINARY")
        await reopened.session.wait({ sessionID: ordinary.id })
        expect((await reopened.session.get({ sessionID: ordinary.id })).outcome).toBe("succeeded")
        expect(claims(env.OPENCODE_DB, [ordinary.id])[0]!.resume_attempts).toBe(0)
      } else {
        const canary = await reopened.session.create({ title: "Read-open canary", location: { directory: project } })
        model.release("TQ_ORDINARY")
        await reopened.session.prompt({ sessionID: canary.id, text: "Reply OK for TQ_ORDINARY without tools." })
        await model.wait("TQ_ORDINARY", 1)
        await reopened.session.wait({ sessionID: canary.id })
      }
      expect(model.counts().TQ_HOLD).toBe(before.TQ_HOLD)
      expect(model.counts().TQ_CHILD).toBe(before.TQ_CHILD)
      expect(model.counts().TQ_GRANDCHILD).toBe(before.TQ_GRANDCHILD)
      expect(model.counts().TQ_LAST).toBe(0)
      expect((await reopened.session.active())[sessionID]).toBeUndefined()
      expect(claims(env.OPENCODE_DB, [sessionID, ...descendants]).every((row) => row.resume_attempts === 0)).toBe(true)

      await reopened.experimental.taskQueue.resume({ queueID: queue.id })
      await model.wait("TQ_HOLD", before.TQ_HOLD + 1)
      expect((await reopened.experimental.taskQueue.get({ queueID: queue.id })).tasks[1]!.sessionID).toBe(sessionID)
      model.release("TQ_HOLD")
      const done = await queueState(reopened, queue.id, (value) => value.status === "done")
      expect(done.tasks.map((task) => task.status)).toEqual(["completed", "completed", "completed"])
      expect(done.tasks[0]!.sessionID).toBe(running.tasks[0]!.sessionID)
      expect(done.tasks[1]!.sessionID).toBe(sessionID)
      expect(model.counts().TQ_FIRST).toBe(1)
      expect(model.counts().TQ_LAST).toBe(1)
      expect(model.counts().TQ_CHILD).toBe(before.TQ_CHILD)
      expect(model.counts().TQ_GRANDCHILD).toBe(before.TQ_GRANDCHILD)
      expect(model.reviews()).toBe(3)
      console.log(`TASK_QUEUE_LIFECYCLE ${JSON.stringify({
        mode, owner: owner.pid, privateServer: endpoint.pid, managedServer: replacement.pid,
        recovered: recovered.status, counts: model.counts(), reviews: model.reviews(), status: done.status,
      })}`)
    } finally {
      model.close()
      await Promise.all(processes.map(stopOwned))
      for (const server of servers) {
        if (alive(server.pid)) process.kill(server.pid, "SIGKILL")
        await exited(server.pid)
        await expectNotListening(server.url)
      }
      await Promise.all(output)
      // All fixture content is owned here, with no tools permitted to create links into other trees.
      expect(path.dirname(await realpath(root))).toBe(base)
      await noLinks(root)
      await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 })
      expect(await Bun.file(path.join(root, "opencode.db")).exists()).toBe(false)
      console.log(`TASK_QUEUE_CLEANUP ${mode}: processes exited, listeners closed, private root removed`)
    }
  },
  // Two cold source-server boots (Windows baseline 24–30s each), owner fixture, real LLM HTTP
  // handshakes, managed restart and explicit-resume executions. No lease TTL is waited out.
  180_000,
)

function controlledModel() {
  const requests: { marker: Marker; review: boolean }[] = []
  const releases = new Map<Marker, ReturnType<typeof Promise.withResolvers<void>>>()
  const notices = new Set<() => void>()
  for (const marker of ["TQ_HOLD", "TQ_CHILD", "TQ_GRANDCHILD", "TQ_ORDINARY"] as const) {
    releases.set(marker, Promise.withResolvers<void>())
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      const body = await Schema.decodeUnknownPromise(Chat)(await request.json())
      const text = JSON.stringify(body.messages)
      const marker = markers.find((marker) => text.includes(marker))
      if (!marker) throw new Error("Unexpected non-fixture model request")
      const review = JSON.stringify(body.messages.at(-1)?.content).includes("You are now the reviewer for this task")
      requests.push({ marker, review })
      for (const notify of notices) notify()
      if (!review && releases.has(marker)) {
        // Request arrival is the handshake; release/abort, never a timer, finishes this request.
        await Promise.race([
          releases.get(marker)!.promise,
          new Promise<void>((resolve) => {
            if (request.signal.aborted) return resolve()
            request.signal.addEventListener("abort", () => resolve(), { once: true })
          }),
        ])
      }
      const content = review ? '{"verdict":"done","reason":"controlled fixture evidence"}' : "OK"
      const chunk = {
        id: "chatcmpl-task-queue",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }
      if (body.stream) return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
      return Response.json({
        ...chunk,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      })
    },
  })
  const count = (marker: Marker) => requests.filter((request) => request.marker === marker && !request.review).length
  return {
    url: server.url.origin,
    counts: () => ({
      TQ_FIRST: count("TQ_FIRST"),
      TQ_HOLD: count("TQ_HOLD"),
      TQ_LAST: count("TQ_LAST"),
      TQ_CHILD: count("TQ_CHILD"),
      TQ_GRANDCHILD: count("TQ_GRANDCHILD"),
      TQ_ORDINARY: count("TQ_ORDINARY"),
    }),
    reviews: () => requests.filter((request) => request.review).length,
    release: (marker: Marker) => releases.get(marker)?.resolve(),
    async wait(marker: Marker, total: number) {
      const notice = Promise.withResolvers<void>()
      const check = () => {
        if (count(marker) >= total) notice.resolve()
      }
      notices.add(check)
      check()
      try {
        await deadline(notice.promise, 20_000, `model handshake ${marker} #${total}`)
      } finally {
        notices.delete(check)
      }
    },
    close() {
      for (const release of releases.values()) release.resolve()
      server.stop(true)
    },
  }
}

function headers(info: Info) {
  return { authorization: `Basic ${Buffer.from(`opencode:${info.password}`).toString("base64")}` }
}
function clientFor(info: Info) {
  return OpenCode.make({ baseUrl: info.url, headers: headers(info) })
}
async function queueState(client: OpenCodeClient, id: string, condition: (queue: TaskQueueInfo) => boolean) {
  const result = { queue: await client.experimental.taskQueue.get({ queueID: id }) }
  await until(async () => {
    result.queue = await client.experimental.taskQueue.get({ queueID: id })
    return condition(result.queue)
  }, 20_000, "queue state")
  return result.queue
}
function claims(file: string, ids: string[]) {
  using db = new Database(file, { readonly: true })
  return ids.map((id) => db.query<{ time_suspended: number | null; resume_attempts: number }, [string]>(
    "SELECT time_suspended, resume_attempts FROM session_v2 WHERE id = ?",
  ).get(id)!)
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}
async function exited(pid: number) {
  await until(async () => !alive(pid), 10_000, `process ${pid} exit`)
}
async function expectNotListening(url: string) {
  expect(await fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => "listening", () => "closed")).toBe("closed")
}
async function until(condition: () => Promise<boolean>, budget: number, label: string) {
  const end = Date.now() + budget
  while (!(await condition())) {
    if (Date.now() >= end) throw new Error(`Timed out: ${label}`)
    await Bun.sleep(50)
  }
}
async function deadline<A>(promise: Promise<A>, budget: number, label: string) {
  const failure = Promise.withResolvers<A>()
  const timer = setTimeout(() => failure.reject(new Error(`Timed out: ${label}`)), budget)
  try {
    return await Promise.race([promise, failure.promise])
  } finally {
    clearTimeout(timer)
  }
}
async function noLinks(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name)
    const stat = await lstat(file)
    if (stat.isSymbolicLink()) throw new Error("Refusing cleanup across a fixture symlink")
    if (stat.isDirectory()) await noLinks(file)
  }
}
