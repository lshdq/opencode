export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

/** Bound provider-requested delays so a retry cannot stall a session for longer than five minutes. */
const RETRY_DELAY_HARD_MAX = Duration.toMillis("5 minutes")
const DEFAULT_RETRY_DELAY_MAX = Duration.toMillis("30 seconds")
const RETRY_DELAY_MIN = Duration.toMillis("1 second")

type MaxDelay = () => Effect.Effect<number>

const retryAfter = (input: Input) => {
  switch (input.cause.reason._tag) {
    case "RateLimit": {
      const value = input.cause.reason.retryAfterMs ?? input.cause.reason.rateLimit?.retryAfterMs
      return value !== undefined && Number.isFinite(value)
        ? Math.min(Math.max(0, value), RETRY_DELAY_HARD_MAX)
        : undefined
    }
    case "QuotaExceeded":
    case "ProviderInternal": {
      const value = input.cause.reason.retryAfterMs
      return value !== undefined && Number.isFinite(value)
        ? Math.min(Math.max(0, value), RETRY_DELAY_HARD_MAX)
        : undefined
    }
    default:
      return undefined
  }
}

// Exponential from 2s with no fixed gap cap: the configured max bounds local gaps below, and a
// provider retry-after raises the gap. The schedule recurs forever; the provider and session
// lifecycle decide when the retry loop ends.
const schedule = Schedule.exponential("2 seconds").pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
  Schedule.modifyDelay(({ input, duration: delay }) => {
    const minimum = retryAfter(input)
    if (minimum === undefined) return Effect.succeed(delay)
    return Effect.succeed(Duration.max(delay, Duration.millis(minimum)))
  }),
)

export const maxDelay = (config: Config.Interface): Effect.Effect<number> =>
  Effect.gen(function* () {
    const seconds = Config.latest(yield* config.entries(), "retry")?.max_delay
    if (seconds === undefined) return DEFAULT_RETRY_DELAY_MAX
    if (!Number.isSafeInteger(seconds) || seconds < 0) return DEFAULT_RETRY_DELAY_MAX
    return seconds * 1000
  })

const defaultMaxDelay: MaxDelay = () => Effect.succeed(DEFAULT_RETRY_DELAY_MAX)

export const policy = (sessionID: SessionSchema.ID, getMaxDelay: MaxDelay = defaultMaxDelay) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(schedule)
    let attempt = 1
    let permanentRetryPromotionUsed = false
    return (input: Input) =>
      Effect.gen(function* () {
        const configuredMaxDelay = yield* getMaxDelay()
        const maxDelay =
          Number.isFinite(configuredMaxDelay) && configuredMaxDelay >= 0
            ? configuredMaxDelay
            : DEFAULT_RETRY_DELAY_MAX
        const now = yield* Clock.currentTimeMillis
        const next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        if (!next) return { retry: false as const }
        const [, duration] = next
        attempt++
        const providerDelay = retryAfter(input)
        // Clamp the proposed delay before the hook so plugins always observe a finite value that
        // matches what the policy can actually schedule on both the local and provider paths.
        const delay =
          providerDelay === undefined
            ? Math.min(maxDelay, Math.ceil(Duration.toMillis(duration)))
            : Math.min(RETRY_DELAY_HARD_MAX, Math.ceil(Duration.toMillis(duration)))
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt,
          decision: input.retry ? { retry: true, delay } : { retry: false },
        }
        yield* input.hook(event)
        // A provider hook cannot veto a retryable failure, but it may explicitly
        // promote a normally terminal failure for one recovery attempt (for
        // example, after refreshing an expired OAuth token). The promotion is
        // policy state rather than hook state, so a hook that always requests
        // retry cannot turn a permanent failure into an infinite loop.
        const acceptedNonReadTransport =
          input.cause.reason._tag === "Transport" &&
          input.cause.reason.delivery === "accepted" &&
          input.cause.reason.operation !== "read"
        const promoted =
          !input.retry && !acceptedNonReadTransport && event.decision.retry && !permanentRetryPromotionUsed
        if (!input.retry && !promoted) return { retry: false as const }
        if (promoted) permanentRetryPromotionUsed = true
        const requestedDelay = event.decision.retry ? event.decision.delay : delay
        const normalized =
          Number.isFinite(requestedDelay) && requestedDelay >= 0 ? Math.ceil(requestedDelay) : delay
        const minimum = providerDelay ?? (maxDelay > 0 ? RETRY_DELAY_MIN : 0)
        const maximum = providerDelay === undefined ? maxDelay : RETRY_DELAY_HARD_MAX
        return {
          retry: true as const,
          attempt,
          delay: Math.min(maximum, Math.max(minimum, normalized)),
        }
      })
  })

interface Lifecycle {
  readonly isClosed: () => boolean
  readonly awaitClosed?: Effect.Effect<void>
}

export const make = (
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  lifecycle?: Lifecycle,
  getMaxDelay: MaxDelay = defaultMaxDelay,
) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID, getMaxDelay)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        if (lifecycle?.isClosed()) return yield* Effect.interrupt
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        const awaitClosed = lifecycle?.awaitClosed
        if (!awaitClosed) {
          yield* Effect.sleep(Duration.millis(remaining))
          if (lifecycle?.isClosed()) return yield* Effect.interrupt
          return
        }
        // Propagate shutdown as interruption, preserving execution's recovery
        // claim rather than terminalizing the drain as successful.
        yield* Effect.raceFirst(
          awaitClosed.pipe(Effect.andThen(Effect.interrupt)),
          Effect.sleep(Duration.millis(remaining)),
        )
        if (lifecycle.isClosed()) return yield* Effect.interrupt
      })
    return { decide, wait }
  })
