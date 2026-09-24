import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { OpenCode } from "@opencode/client"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"

type Chat = {
  stream?: boolean
  messages: { role: string; content: unknown }[]
}

// TC-001–005: the actual checkout's CLI/server and a local OpenAI-compatible provider.
// Every process, config and project fixture is private; no installed binary or shared service is used.
test("private V2 HTTP session executes configured instructions and moves between real projects", async () => {
  const root = await mkdtemp(path.join(process.env.OPENCODE_TEST_TMP ?? "D:/temp/systemp/opencode", "instructions-http-"))
  const config = path.join(root, "config")
  const project = path.join(root, "project")
  const nested = path.join(project, "nested")
  const other = path.join(root, "other")
  const home = path.join(root, "home")
  const captured: Chat[] = []
  const remoteRequests: string[] = []
  const remote = { content: "REMOTE_RULE_ONE", fail: false }
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/instructions") {
        remoteRequests.push(request.url)
        return remote.fail ? new Response("unavailable", { status: 503 }) : new Response(remote.content)
      }
      const body = (await request.json()) as Chat
      captured.push(body)
      const chunk = {
        id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }
      if (body.stream) return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
      return Response.json({ ...chunk, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })
    },
  })
  const password = crypto.randomUUID()
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  try {
    await Promise.all([config, nested, other, home].map((directory) => mkdir(directory, { recursive: true })))
    for (const directory of [project, other]) {
      expect(Bun.spawnSync(["git", "init", "--quiet", directory]).exitCode).toBe(0)
    }
    const put = async (name: string, content: string) => {
      await mkdir(path.dirname(name), { recursive: true })
      await Bun.write(name, content)
    }
    const near = path.join(nested, ".opencode", "AGENTS.md")
    const far = path.join(project, ".opencode", "AGENTS.md")
    const extra = path.join(root, "extra", "rule.md")
    const dynamic = path.join(project, "dynamic.md")
    await put(near, "NESTED_RULE_ONE")
    await put(far, "ROOT_RULE_ONE")
    await put(path.join(other, ".opencode", "AGENTS.md"), "OTHER_RULE_ONE")
    await put(path.join(project, "AGENTS.md"), "BUILTIN_RULE_ONE")
    await put(extra, "ABSOLUTE_RULE_ONE")
    await put(path.join(home, "home.md"), "HOME_RULE_ONE")
    const signedURL = `http://fixture-user:fixture-password@127.0.0.1:${provider.port}/instructions?token=fixture-private-token#fixture-private-fragment`
    const secrets = ["fixture-user", "fixture-password", "fixture-private-token", "fixture-private-fragment"]
    const configuration = {
      model: "fixture/fixture",
      instructions: [".opencode/AGENTS.md", path.join(root, "extra", "*.md"), "~/home.md", signedURL, "dynamic.md"],
      providers: { fixture: {
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture" },
        models: { fixture: { limit: { context: 32000, output: 2000 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
      } },
    }
    await put(path.join(config, "opencode.json"), JSON.stringify(configuration))

    child = Bun.spawn(
      [process.execPath, "--cwd", path.join(import.meta.dir, ".."), "src/index.ts", "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
      {
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: root, TMP: root,
          HOME: home, USERPROFILE: home, OPENCODE_TEST_HOME: home,
          XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "data"),
          XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
          OPENCODE_CONFIG_DIR: config,
          OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_PASSWORD: password,
        },
      },
    )
    const errors = new Response(child.stderr).text()
    const reader = child.stdout.getReader()
    const handshake = await Promise.race([
      (async () => {
        for (;;) {
          const next = await reader.read()
          if (next.done) throw new Error(`Private CLI stdout closed: ${await errors}`)
          const text = new TextDecoder().decode(next.value).trim()
          if (text) return text
        }
      })(),
      child.exited.then(async () => { throw new Error(`Private CLI exited: ${await errors}`) }),
      Bun.sleep(30_000).then(() => { throw new Error("Private CLI handshake timed out") }),
    ])
    const { url } = JSON.parse(handshake) as { url: string }
    const client = OpenCode.make({ baseUrl: url, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
    const session = await client.session.create({ title: "instructions E2E", location: { directory: nested }, model: { providerID: "fixture", id: "fixture" } })
    let previousLength = 0
    const run = async () => {
      const before = captured.length
      await client.session.prompt({ sessionID: session.id, text: "Reply OK without tools" })
      await client.session.wait({ sessionID: session.id })
      const result = await client.session.get({ sessionID: session.id })
      expect(result.outcome).toBe("succeeded")
      expect(captured.length).toBeGreaterThan(before)
      const messages = captured[before]!.messages
      const added = messages.slice(previousLength)
      previousLength = messages.length
      return { messages, added }
    }
    const visible = (messages: Chat["messages"]) => messages.map((message) => JSON.stringify(message.content)).join("\n")
    const checkPrivate = async () => {
      for (const secret of secrets) expect(JSON.stringify(captured)).not.toContain(secret)
      const directory = path.join(root, "data", "opencode")
      const filenames = (await readdir(directory)).filter((name) => name.endsWith(".db"))
      expect(filenames).toHaveLength(1)
      const db = new Database(path.join(directory, filenames[0]), { readonly: true })
      try {
        const blobs = db.query("SELECT hash, value FROM instruction_blob").all()
        const state = db.query("SELECT initial_values, current_values FROM instruction_state").all()
        expect(JSON.stringify(blobs)).toContain("REMOTE_RULE_ONE")
        expect(state).toHaveLength(1)
        for (const secret of secrets) {
          expect(JSON.stringify(blobs)).not.toContain(secret)
          expect(JSON.stringify(state)).not.toContain(secret)
        }
      } finally {
        db.close()
      }
    }
    const updates = (messages: Chat["messages"]) => messages.filter((message) => message.role === "user")
      .map((message) => JSON.stringify(message.content)).join("\n")
    const initial = (await run()).messages.filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => JSON.stringify(message.content)).join("\n")
    for (const value of ["NESTED_RULE_ONE", "ROOT_RULE_ONE", "BUILTIN_RULE_ONE", "ABSOLUTE_RULE_ONE", "HOME_RULE_ONE", "REMOTE_RULE_ONE"]) {
      expect(initial.match(new RegExp(value, "g"))).toHaveLength(1)
    }
    expect(initial.indexOf("NESTED_RULE_ONE")).toBeLessThan(initial.indexOf("ROOT_RULE_ONE"))
    expect(initial).not.toContain("OTHER_RULE_ONE")
    // Fetch sends the original query, but HTTP request URLs cannot carry URL userinfo or fragments.
    expect(remoteRequests).toContain(`http://127.0.0.1:${provider.port}/instructions?token=fixture-private-token`)
    await checkPrivate()

    await put(dynamic, "DYNAMIC_RULE_CREATED")
    expect(updates((await run()).added)).toContain("DYNAMIC_RULE_CREATED")
    await put(dynamic, "DYNAMIC_RULE_EDITED")
    expect(updates((await run()).added)).toContain("DYNAMIC_RULE_EDITED")
    await rm(dynamic)
    expect(updates((await run()).added)).toContain("no longer apply")

    await put(near, "NESTED_RULE_TWO")
    expect(updates((await run()).added)).toContain("NESTED_RULE_TWO")
    await rm(near)
    expect(updates((await run()).added)).toContain("no longer apply")
    await put(near, "NESTED_RULE_THREE")
    expect(updates((await run()).added)).toContain("NESTED_RULE_THREE")

    remote.content = "REMOTE_RULE_TWO"
    expect(updates((await run()).added)).toContain("REMOTE_RULE_TWO")
    remote.fail = true
    const failedURL = await run()
    expect(visible(failedURL.messages)).toContain("REMOTE_RULE_TWO")
    expect(updates(failedURL.added)).not.toContain("no longer apply")
    remote.fail = false
    await checkPrivate()

    remote.content = ["REMOTE_RULE_BEFORE", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")
    await run()
    remote.content = remote.content.replace("REMOTE_RULE_BEFORE", "REMOTE_RULE_AFTER")
    const changedRemote = updates((await run()).added)
    expect(changedRemote).toContain("changed. Here's the diff:")
    expect(changedRemote).toContain("REMOTE_RULE_AFTER")
    await checkPrivate()

    const configRule = path.join(project, "config-new.md")
    await put(configRule, "CONFIG_RULE_NEW")
    const withConfig = [...configuration.instructions, "config-new.md"]
    await put(path.join(config, "opencode.json"), JSON.stringify({ ...configuration, instructions: withConfig }))
    // Wait for the filesystem watcher to publish config.updated, not a fixed machine-dependent delay.
    const ready = Date.now() + 5_000
    while (!JSON.stringify(await client.config.get({ location: { directory: nested } })).includes('"config-new.md"')) {
      if (Date.now() >= ready) throw new Error("Private server did not reload the edited config")
      await Bun.sleep(100)
    }
    await Bun.sleep(200)
    const changedConfig = await run()
    expect(updates(changedConfig.added)).toContain("CONFIG_RULE_NEW")

    const withoutRemote = withConfig.filter((source) => source !== signedURL)
    await put(path.join(config, "opencode.json"), JSON.stringify({ ...configuration, instructions: withoutRemote }))
    const removalReady = Date.now() + 5_000
    while (JSON.stringify(await client.config.get({ location: { directory: nested } })).includes("fixture-private-token")) {
      if (Date.now() >= removalReady) throw new Error("Private server did not remove the signed URL from config")
      await Bun.sleep(100)
    }
    await Bun.sleep(200)
    const removedRemote = updates((await run()).added)
    expect(removedRemote).toContain(`http://127.0.0.1:${provider.port}/instructions no longer apply`)
    await checkPrivate()

    await client.session.move({ sessionID: session.id, directory: other })
    const moved = updates((await run()).added)
    expect(moved).toContain("OTHER_RULE_ONE")
    for (const old of [near, far, path.join(project, "AGENTS.md"), configRule]) {
      expect(moved).toContain(`The instructions from ${old.replaceAll("\\", "\\\\")} no longer apply`)
    }
    expect(moved).not.toContain("NESTED_RULE_THREE")
    expect(moved).not.toContain("ROOT_RULE_ONE")
    await checkPrivate()
  } finally {
    child?.stdin.end()
    child?.kill()
    if (child) await child.exited
    provider.stop(true)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 180_000)
