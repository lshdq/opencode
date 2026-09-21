import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Git } from "@opencode-ai/core/git"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Git.node))

async function initRepo(directory: string) {
  await $`git init`.cwd(directory).quiet()
  await $`git config core.fsmonitor false`.cwd(directory).quiet()
  await $`git config commit.gpgsign false`.cwd(directory).quiet()
  await $`git config user.email test@opencode.test`.cwd(directory).quiet()
  await $`git config user.name Test`.cwd(directory).quiet()
  await $`git commit --allow-empty -m root`.cwd(directory).quiet()
}

describe("Git.repo.discover", () => {
  it.live("discovers a repository from its root", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => initRepo(root.path))
      const git = yield* Git.Service

      const repo = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!repo) throw new Error("Repository not found")
      expect(repo.worktree).toBe(AbsolutePath.make(root.path))
      expect(repo.gitDirectory).toBe(AbsolutePath.make(path.join(root.path, ".git")))
      expect(repo.commonDirectory).toBe(repo.gitDirectory)
    }),
  )

  it.live("discovers a repository from a nested subdirectory", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const nested = path.join(root.path, "sub", "dir")
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await fs.mkdir(nested, { recursive: true })
      })
      const git = yield* Git.Service

      const repo = yield* git.repo.discover(AbsolutePath.make(nested))
      if (!repo) throw new Error("Repository not found")
      expect(repo.worktree).toBe(AbsolutePath.make(root.path))
      expect(repo.gitDirectory).toBe(AbsolutePath.make(path.join(root.path, ".git")))
      expect(repo.commonDirectory).toBe(repo.gitDirectory)
    }),
  )

  it.live("discovers a linked worktree", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const linked = path.join(root.path, "linked")
      yield* Effect.promise(async () => {
        await initRepo(root.path)
        await $`git worktree add --detach ${linked} HEAD`.cwd(root.path).quiet()
      })
      const git = yield* Git.Service

      const main = yield* git.repo.discover(AbsolutePath.make(root.path))
      if (!main) throw new Error("Repository not found")
      const repo = yield* git.repo.discover(AbsolutePath.make(linked))
      if (!repo) throw new Error("Linked worktree not found")
      expect(repo.worktree).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(linked))))
      expect(repo.commonDirectory).toBe(main.commonDirectory)
      expect(repo.gitDirectory).not.toBe(main.gitDirectory)
      expect(repo.gitDirectory.startsWith(main.gitDirectory + path.sep)).toBe(true)
    }),
  )

  it.live("falls back to the containing directory as worktree for a bare repository", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const directory = path.join(root.path, "bare")
      yield* Effect.promise(async () => {
        await fs.mkdir(directory, { recursive: true })
        await $`git init --bare .git`.cwd(directory).quiet()
      })
      const git = yield* Git.Service

      const repo = yield* git.repo.discover(AbsolutePath.make(directory))
      if (!repo) throw new Error("Repository not found")
      expect(repo.worktree).toBe(AbsolutePath.make(directory))
      expect(repo.gitDirectory).toBe(AbsolutePath.make(path.join(directory, ".git")))
      expect(repo.commonDirectory).toBe(repo.gitDirectory)
    }),
  )

  it.live("returns undefined outside a git repository", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const git = yield* Git.Service

      expect(yield* git.repo.discover(AbsolutePath.make(root.path))).toBeUndefined()
    }),
  )
})
