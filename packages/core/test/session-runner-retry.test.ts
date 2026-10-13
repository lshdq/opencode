import { describe, expect } from "bun:test"
import {
  AIError,
  AuthenticationError,
  ProviderInternalError,
  QuotaExceededError,
  RateLimitError,
  TransportError,
} from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import type { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Effect, Ref } from "effect"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("keeps retrying transport timeouts without an attempt limit", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 12)).toEqual(Array(12).fill(true))
    }),
  )

  it.effect("keeps retrying transient failures beyond the previous allowance", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 12)).toEqual(Array(12).fill(true))
    }),
  )

  it.effect("retries quota failures", () =>
    Effect.gen(function* () {
      const quota = new AIError({ reason: new QuotaExceededError({ message: "quota" }) })
      expect(SessionRunnerRetry.isRetryable(quota)).toBe(true)
      expect(yield* decisions(quota, 12)).toEqual(Array(12).fill(true))
    }),
  )

  it.effect("caps exponential and retry-after delays at five minutes", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_delay"))
      const cause = new AIError({ reason: new ProviderInternalError({ message: "internal", retryAfterMs: 360_000 }) })
      const delays: number[] = []
      for (let i = 0; i < 12; i++) {
        const result = yield* policy(input(cause))
        if (!result.retry) throw new Error("expected retry")
        delays.push(result.delay)
      }
      expect(delays.every((delay) => delay <= 300_000)).toBe(true)
      expect(delays.every((delay) => delay >= 300_000)).toBe(true)
    }),
  )

  it.effect("uses the default thirty-second cap for local backoff", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_default_max"))
      const delays: number[] = []
      for (let i = 0; i < 12; i++) {
        const result = yield* policy(input(internal))
        if (!result.retry) throw new Error("expected retry")
        delays.push(result.delay)
      }
      expect(delays.every((delay) => delay <= 30_000)).toBe(true)
    }),
  )

  it.effect("uses a configured cap and honors provider retry-after first", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_configured_max"), () =>
        Effect.succeed(1_000),
      )
      const local = yield* policy(input(internal))
      if (!local.retry) throw new Error("expected retry")
      expect(local.delay).toBeLessThanOrEqual(1_000)

      const provider = new AIError({
        reason: new ProviderInternalError({ message: "internal", retryAfterMs: 10_000 }),
      })
      const providerResult = yield* policy(input(provider))
      if (!providerResult.retry) throw new Error("expected retry")
      expect(providerResult.delay).toBe(10_000)
    }),
  )

  it.effect("allows zero to disable local backoff and reads updates on later decisions", () =>
    Effect.gen(function* () {
      const maxDelay = yield* Ref.make(1_000)
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_hot_update"), () =>
        Ref.get(maxDelay),
      )
      const initial = yield* policy(input(internal))
      if (!initial.retry) throw new Error("expected retry")
      expect(initial.delay).toBeLessThanOrEqual(1_000)

      yield* Ref.set(maxDelay, 0)
      const updated = yield* policy(input(internal))
      if (!updated.retry) throw new Error("expected retry")
      expect(updated.delay).toBe(0)
    }),
  )

  it.effect("allows a configured cap above the provider hard max", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_above_hard"), () =>
        Effect.succeed(600_000),
      )
      const delays: number[] = []
      for (let i = 0; i < 12; i++) {
        const result = yield* policy(input(internal))
        if (!result.retry) throw new Error("expected retry")
        delays.push(result.delay)
      }
      expect(delays).toHaveLength(12)
      // Jittered exponential gaps grow past the five-minute hard max until the configured cap clamps them.
      for (const [index, delay] of delays.entries()) {
        if (index < 9) expect(delay).toBeGreaterThanOrEqual(2_000 * 2 ** index * 0.8)
        else expect(delay).toBe(600_000)
      }
    }),
  )

  it.effect("shows hooks finite capped delays on the provider retry-after path", () =>
    Effect.gen(function* () {
      const proposed: number[] = []
      const cause = new AIError({
        reason: new ProviderInternalError({ message: "internal", retryAfterMs: 1_000 }),
      })
      const hook = (event: PluginHooks.Domains["session"]["retry"]) => {
        proposed.push(event.decision.retry ? event.decision.delay : 0)
        return Effect.void
      }
      const decide = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_hook_cap"))
      for (let i = 0; i < 24; i++) {
        const result = yield* decide({ ...input(cause), hook })
        if (!result.retry) throw new Error("expected retry")
      }
      // After ~19 attempts the raw exponential schedule exceeds the hard max; the hook must
      // still observe finite values capped at five minutes.
      expect(proposed).toHaveLength(24)
      for (const delay of proposed) {
        expect(Number.isFinite(delay)).toBe(true)
        expect(delay).toBeLessThanOrEqual(300_000)
      }
    }),
  )

  it.effect("restores retry after a hook rejects an eligible failure", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_hook"))
      const quota = new AIError({ reason: new QuotaExceededError({ message: "quota" }) })
      const result = yield* policy({
        ...input(quota),
        hook: (event) =>
          Effect.sync(() => {
            event.decision = { retry: false }
          }),
      })
      expect(result.retry).toBe(true)
    }),
  )

  it.effect("enforces the retry-after floor when a hook shortens the delay", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry_floor"))
      const cause = new AIError({
        reason: new RateLimitError({ message: "rate limited", rateLimit: { retryAfterMs: 5_000 } }),
      })
      const result = yield* policy({
        ...input(cause),
        hook: (event) =>
          Effect.sync(() => {
            event.decision = { retry: true, delay: 0 }
          }),
      })
      if (!result.retry) throw new Error("expected retry")
      expect(result.delay).toBeGreaterThanOrEqual(5_000)
      expect(result.delay).toBeLessThanOrEqual(300_000)
    }),
  )

  it.effect("allows one explicit recovery for a permanent failure and then stops", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_permanent"))
      const failure = new AIError({
        reason: new AuthenticationError({
          message: "Unauthorized",
          http: { url: "https://example.test", status: 401, headers: {} },
        }),
      })
      const recover = {
        ...input(failure),
        hook: (event: PluginHooks.Domains["session"]["retry"]) =>
          Effect.sync(() => {
            event.decision = { retry: true, delay: 0 }
          }),
        retry: false,
      }
      const recovered = yield* policy(recover)
      expect(recovered.retry).toBe(true)
      expect(recovered.delay).toBeGreaterThanOrEqual(1_000)
      expect(yield* policy(recover)).toEqual({ retry: false })
    }),
  )

  it.effect("does not promote an accepted non-read transport failure", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_accepted_write"))
      const accepted = new AIError({
        reason: new TransportError({
          message: "accepted write failed",
          transport: "websocket",
          operation: "write",
          delivery: "accepted",
        }),
      })
      const hook = (event: PluginHooks.Domains["session"]["retry"]) =>
        Effect.sync(() => {
          event.decision = { retry: true, delay: 0 }
        })

      expect(yield* policy({ ...input(accepted), hook })).toEqual({ retry: false })

      const permanent = new AIError({ reason: new AuthenticationError({ message: "Unauthorized" }) })
      expect(yield* policy({ ...input(permanent), hook })).toMatchObject({ retry: true })
    }),
  )
})
