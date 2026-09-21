import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config, discoverEntries } from "@opencode-ai/core/config"
import { ConfigReference } from "@opencode-ai/core/config/reference"
import { ConfigReferencePlugin } from "@opencode-ai/core/config/plugin/reference"
import { Reference } from "@opencode-ai/core/reference"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const HOME = process.platform === "win32" ? "C:\\home\\tester" : "/home/tester"
const LOCATION = process.platform === "win32" ? "D:\\workspace\\repo" : "/workspace/repo"

function doc(references: ConfigReference.Info, filepath?: string) {
  return new Config.Document({
    type: "document",
    ...(filepath === undefined ? {} : { path: filepath }),
    info: { references },
  })
}

function localPaths(sources: Map<string, Reference.Source>) {
  return Object.fromEntries(
    Array.from(sources, ([name, source]) => [name, source.type === "local" ? source.path : source.repository]),
  )
}

describe("ConfigReferencePlugin.sourcesFromEntries", () => {
  const options = { home: HOME, locationDirectory: LOCATION }

  test("maps string and object entries to local and git sources", () => {
    const config = path.join(LOCATION, "opencode.json")
    const sources = ConfigReferencePlugin.sourcesFromEntries(
      [
        doc(
          {
            abs: new ConfigReference.Local({ path: path.join(path.parse(LOCATION).root, "abs", "ref") }),
            rel: "./docs",
            repo: "owner/repo",
            full: new ConfigReference.Git({
              repository: "Effect-TS/effect",
              branch: "main",
              description: "Effect",
              hidden: true,
            }),
          },
          config,
        ),
      ],
      options,
    )

    expect(localPaths(sources)).toEqual({
      abs: path.join(path.parse(LOCATION).root, "abs", "ref"),
      rel: path.resolve(LOCATION, "docs"),
      repo: "owner/repo",
      full: "Effect-TS/effect",
    })
    const full = sources.get("full")
    expect(full).toMatchObject({ type: "git", branch: "main", description: "Effect", hidden: true })
  })

  test("expands ~/ against home", () => {
    const sources = ConfigReferencePlugin.sourcesFromEntries([doc({ home: "~/docs" }, path.join(LOCATION, "opencode.json"))], options)
    expect(localPaths(sources)).toEqual({ home: path.join(HOME, "docs") })
  })

  test("resolves relative paths against the declaring document directory", () => {
    const nested = path.join(LOCATION, "sub", "opencode.json")
    const sources = ConfigReferencePlugin.sourcesFromEntries([doc({ rel: "../docs" }, nested)], options)
    expect(localPaths(sources)).toEqual({ rel: path.resolve(path.dirname(nested), "../docs") })
  })

  test("falls back to the location directory for documents without a path", () => {
    const sources = ConfigReferencePlugin.sourcesFromEntries([doc({ rel: "./docs" })], options)
    expect(localPaths(sources)).toEqual({ rel: path.resolve(LOCATION, "docs") })
  })

  test("drops invalid aliases", () => {
    const sources = ConfigReferencePlugin.sourcesFromEntries(
      [doc({ "": "./a", "a/b": "./b", "has space": "./c", "tick`ed": "./d", "com,ma": "./e", ok: "./f" })],
      options,
    )
    expect(Array.from(sources.keys())).toEqual(["ok"])
  })

  test("later documents override earlier ones with the same name", () => {
    const global = path.join(HOME, ".config", "opencode", "opencode.json")
    const project = path.join(LOCATION, "opencode.json")
    const sources = ConfigReferencePlugin.sourcesFromEntries(
      [doc({ over: "./global", keep: "./keep" }, global), doc({ over: "./project" }, project)],
      options,
    )
    expect(localPaths(sources)).toEqual({
      over: path.resolve(LOCATION, "project"),
      keep: path.resolve(path.dirname(global), "keep"),
    })
    // insertion order follows first sighting; only the value is overridden
    expect(Array.from(sources.keys())).toEqual(["over", "keep"])
  })

  test("documents without references contribute nothing", () => {
    const sources = ConfigReferencePlugin.sourcesFromEntries(
      [new Config.Document({ type: "document", path: path.join(LOCATION, "opencode.json"), info: {} })],
      options,
    )
    expect(sources.size).toBe(0)
  })
})

describe("Reference.resolve", () => {
  const repos = path.join(path.parse(LOCATION).root, "data", "repos")

  function resolve(sources: Record<string, Reference.Source>) {
    return Reference.resolve(Object.entries(sources), repos)
  }

  test("passes local sources through with their path", () => {
    const target = AbsolutePath.make(path.join(LOCATION, "docs"))
    const [resolved] = resolve({ docs: Reference.LocalSource.make({ type: "local", path: target }) })
    expect(resolved.info.path).toBe(target)
    expect(resolved.info.name).toBe("docs")
    expect(resolved.repository).toBeUndefined()
  })

  test("resolves remote git sources to the repository cache path", () => {
    const [resolved] = resolve({
      effect: Reference.GitSource.make({ type: "git", repository: "Effect-TS/effect", branch: "main" }),
    })
    expect(resolved.info.path).toBe(AbsolutePath.make(path.join(repos, "github.com", "Effect-TS", "effect") + "@main"))
    expect(resolved.repository).toMatchObject({ host: "github.com", path: "Effect-TS/effect" })
  })

  test("omits the branch suffix for branchless git sources", () => {
    const [resolved] = resolve({ effect: Reference.GitSource.make({ type: "git", repository: "Effect-TS/effect" }) })
    expect(resolved.info.path).toBe(AbsolutePath.make(path.join(repos, "github.com", "Effect-TS", "effect")))
  })

  test("encodes branch names containing slashes", () => {
    const [resolved] = resolve({
      effect: Reference.GitSource.make({ type: "git", repository: "Effect-TS/effect", branch: "feature/x" }),
    })
    expect(resolved.info.path).toBe(
      AbsolutePath.make(path.join(repos, "github.com", "Effect-TS", "effect") + "@feature%2Fx"),
    )
  })

  test("drops unparseable repositories", () => {
    expect(resolve({ bad: Reference.GitSource.make({ type: "git", repository: "not-a-repo" }) })).toEqual([])
  })

  test("drops non-remote file repositories", () => {
    const target = process.platform === "win32" ? "file:///D:/repos/local" : "file:///repos/local"
    expect(resolve({ local: Reference.GitSource.make({ type: "git", repository: target }) })).toEqual([])
  })

  test("drops invalid branch names", () => {
    expect(
      resolve({ bad: Reference.GitSource.make({ type: "git", repository: "Effect-TS/effect", branch: "-nope" }) }),
    ).toEqual([])
    expect(
      resolve({ bad: Reference.GitSource.make({ type: "git", repository: "Effect-TS/effect", branch: "a..b" }) }),
    ).toEqual([])
  })

  test("carries description and hidden onto the info", () => {
    const [resolved] = resolve({
      docs: Reference.LocalSource.make({
        type: "local",
        path: AbsolutePath.make(path.join(LOCATION, "docs")),
        description: "Docs",
        hidden: true,
      }),
    })
    expect(resolved.info).toMatchObject({ description: "Docs", hidden: true })
  })
})

describe("Config.discoverEntries", () => {
  const it = testEffect(LayerNode.compile(FSUtil.node))

  function withTmp<A, E, R>(f: (root: string) => Effect.Effect<A, E, R>) {
    return Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.flatMap((tmp) => f(tmp.path)))
  }

  async function write(file: string, config: Record<string, unknown>) {
    await Bun.write(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }))
  }

  it.live("discovers global, project, and .opencode entries in priority order", () =>
    withTmp((root) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const global = path.join(root, "global")
        const project = path.join(root, "project")
        const sub = path.join(project, "sub")
        const dotopencode = path.join(project, ".opencode")
        yield* Effect.promise(async () => {
          await write(path.join(global, "opencode.json"), { references: { g: "./g-local" } })
          await write(path.join(project, "opencode.json"), { references: { p: "./p-local", over: "./project" } })
          await write(path.join(sub, "opencode.json"), { references: { s: "./s-local", over: "./sub" } })
          await write(path.join(dotopencode, "opencode.json"), { references: { oc: "./oc-local" } })
        })

        const entries = yield* discoverEntries(fs, {
          globalConfig: global,
          directory: sub,
          projectDirectory: project,
        })

        expect(entries.map((entry) => [entry.type, entry.path] as const)).toEqual([
          ["document", path.join(global, "opencode.json")],
          ["directory", global],
          ["document", path.join(project, "opencode.json")],
          ["document", path.join(sub, "opencode.json")],
          ["document", path.join(dotopencode, "opencode.json")],
          ["directory", dotopencode],
        ])

        const sources = ConfigReferencePlugin.sourcesFromEntries(entries, { home: HOME, locationDirectory: sub })
        expect(localPaths(sources)).toEqual({
          g: path.resolve(global, "g-local"),
          p: path.resolve(project, "p-local"),
          over: path.resolve(sub, "sub"),
          s: path.resolve(sub, "s-local"),
          oc: path.resolve(dotopencode, "oc-local"),
        })

        const dirs = Reference.resolve(sources, path.join(root, "repos")).map((resolved) => resolved.info.path)
        expect(Object.values(localPaths(sources))).toEqual(dirs)
      }),
    ),
  )

  it.live("migrates V1 reference config documents", () =>
    withTmp((root) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const global = path.join(root, "global")
        const project = path.join(root, "project")
        yield* Effect.promise(async () => {
          await Bun.write(
            path.join(project, "opencode.jsonc"),
            `{ "reference": { "legacy": "./legacy" }, // trailing comment
}`,
          )
        })

        const entries = yield* discoverEntries(fs, { globalConfig: global, directory: project, projectDirectory: project })
        const sources = ConfigReferencePlugin.sourcesFromEntries(entries, { home: HOME, locationDirectory: project })
        expect(localPaths(sources)).toEqual({ legacy: path.resolve(project, "legacy") })
      }),
    ),
  )

  it.live("skips discovery when the location is the global config directory", () =>
    withTmp((root) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        yield* Effect.promise(() => write(path.join(root, "opencode.json"), { references: { g: "./g" } }))

        const entries = yield* discoverEntries(fs, {
          globalConfig: root,
          directory: root,
          projectDirectory: root,
        })
        expect(entries.map((entry) => entry.type)).toEqual(["document", "directory"])
      }),
    ),
  )

  it.live("returns only the global directory when no config files exist", () =>
    withTmp((root) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const entries = yield* discoverEntries(fs, {
          globalConfig: path.join(root, "global"),
          directory: path.join(root, "project"),
          projectDirectory: path.join(root, "project"),
        })
        expect(entries.map((entry) => entry.type)).toEqual(["directory"])
        expect(
          ConfigReferencePlugin.sourcesFromEntries(entries, { home: HOME, locationDirectory: path.join(root, "project") })
            .size,
        ).toBe(0)
      }),
    ),
  )
})
