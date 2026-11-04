/// <reference path="./audio.d.ts" />
import type {
  Attention,
  AttentionNotifyOptions,
  AttentionNotifyResult,
  AttentionNotifySkipReason,
  AttentionWhen,
  AttentionSoundName,
  AttentionDiagnostic,
  Data,
} from "@opencode/plugin/tui/context"
import { Config } from "./config"
import { Schema } from "effect"
import stripAnsi from "strip-ansi"
import { loadSoundFile, play } from "./audio"
import { createAttentionDiagnostics } from "./attention-diagnostics"
import type { LogTags } from "./context/log"
import {
  defaultSoundPath,
  questionSoundPath,
  permissionSoundPath,
  errorSoundPath,
  subagentDoneSoundPath,
} from "#attention-sounds"

type FocusState = "unknown" | "focused" | "blurred"

type AttentionRenderer = {
  readonly isDestroyed: boolean
  on(event: "focus" | "blur", listener: () => void): unknown
  off(event: "focus" | "blur", listener: () => void): unknown
  triggerNotification(message: string, title?: string): boolean
}

type AttentionHost = Attention & {
  dispose(): void
}

type AttentionSource = {
  notify(request: AttentionNotifyOptions, pluginID: string): Promise<AttentionNotifyResult>
  suppress(diagnostic: AttentionDiagnostic, reason: string, pluginID: string): void
}
const sources = new WeakMap<Attention, AttentionSource>()

// Source attribution belongs to the host, not to metadata supplied by a plugin.
export function scopeTuiAttention(attention: Attention, pluginID: string): Attention {
  const source = sources.get(attention)
  if (!source) return { notify: (request) => attention.notify(request) }
  const scoped = { notify: (request: AttentionNotifyOptions) => source.notify(request, pluginID) }
  sources.set(scoped, { ...source, suppress: (diagnostic, reason) => source.suppress(diagnostic, reason, pluginID) })
  return scoped
}

export function suppressTuiAttention(attention: Attention, diagnostic: AttentionDiagnostic, reason: string) {
  sources.get(attention)?.suppress(diagnostic, reason, "opencode.notifications")
}

const DEFAULT_TITLE = "OpenCode"
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240
const BUILTIN_SOUNDS: Record<AttentionSoundName, string> = {
  default: defaultSoundPath,
  question: questionSoundPath,
  permission: permissionSoundPath,
  error: errorSoundPath,
  done: defaultSoundPath,
  subagent_done: subagentDoneSoundPath,
}

function skipped(reason: AttentionNotifySkipReason): AttentionNotifyResult {
  return {
    ok: false,
    notification: false,
    sound: false,
    skipped: reason,
  }
}

function normalizeText(input: string | undefined, fallback: string, limit: number) {
  const text = stripAnsi(input ?? "")
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
  const normalized = text.length ? text : fallback
  return Array.from(normalized).slice(0, limit).join("")
}

function clampVolume(volume: number) {
  if (!Number.isFinite(volume)) return 0
  return Math.min(1, Math.max(0, volume))
}

function soundVolume(input: AttentionNotifyOptions, config: Pick<Config.Resolved, "attention">) {
  if (!config.attention.sound) return
  if (input.sound === false) return
  if (input.sound === undefined) return clampVolume(config.attention.volume)
  if (input.sound === true) return clampVolume(config.attention.volume)
  return clampVolume(input.sound.volume ?? config.attention.volume)
}

function focusSkip(when: AttentionWhen, focus: FocusState) {
  if (when === "always") return
  if (focus === "unknown") return "focus_unknown"
  if (when === "blurred" && focus === "focused") return "focused"
  if (when === "focused" && focus === "blurred") return "blurred"
}

export function createTuiAttention(input: {
  renderer: AttentionRenderer
  config: Pick<Config.Resolved, "attention">
  audio?: { loadSoundFile: typeof loadSoundFile; play: typeof play }
  data?: Data
  log?: (message: string, tags: LogTags) => void
}): AttentionHost {
  let focus: FocusState = "unknown"
  let disposed = false
  const audio = input.audio ?? { loadSoundFile, play }
  const diagnostics = createAttentionDiagnostics(input)
  let sequence = 0

  const onFocus = () => {
    focus = "focused"
  }
  const onBlur = () => {
    focus = "blurred"
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  function soundCandidates(name: AttentionSoundName) {
    return [input.config.attention.sounds[name], BUILTIN_SOUNDS[name]].filter(
      (item, index, list): item is string => typeof item === "string" && list.indexOf(item) === index,
    )
  }

  async function playSound(name: AttentionSoundName, volume: number, record: (tags: LogTags) => void) {
    try {
      for (const [attempt, file] of soundCandidates(name).entries()) {
        const current = await audio.loadSoundFile(file).catch(() => {
          record({ phase: "sound_load", outcome: "exception", attempt })
          return null
        })
        if (disposed || input.renderer.isDestroyed) return "renderer_destroyed"
        if (current == null) {
          record({ phase: "sound_load", outcome: "unavailable", attempt })
          continue
        }
        if (audio.play(current, { volume }) != null) return "playback_started"
        record({ phase: "sound_play", outcome: "api_rejected", attempt })
      }
      return "unavailable"
    } catch {
      return "exception"
    }
  }

  const source: AttentionSource = {
    suppress(diagnostic, reason, pluginID) {
      diagnostics.record({
        ...diagnostics.snapshot(diagnostic, pluginID),
        focus,
        phase: "suppressed",
        suppressionReason: reason,
      })
    },
    async notify(request, pluginID) {
      // Freeze before any channel invocation or await. Results describe this decision,
      // not the state/focus at the time an audio file eventually finishes loading.
      const snapshot = {
        ...diagnostics.snapshot(request?.diagnostic, pluginID),
        focus,
        requestID: ++sequence,
        deliveryGuarantee: "api_result_only",
      }
      const record = (tags: LogTags) => diagnostics.record({ ...snapshot, ...tags })
      let notificationOutcome = "not_attempted"
      let soundOutcome = "not_attempted"
      const finish = (result: AttentionNotifyResult) => {
        record({ phase: "result", ...result, skipped: result.skipped ?? null, notificationOutcome, soundOutcome })
        return result
      }
      const skip = (reason: AttentionNotifySkipReason) => {
        notificationOutcome = reason
        soundOutcome = reason
        return finish(skipped(reason))
      }
      record({ phase: "request" })
      try {
        if (!input.config.attention.notifications && !input.config.attention.sound) return skip("attention_disabled")
        if (disposed || input.renderer.isDestroyed) return skip("renderer_destroyed")

        const message = normalizeText(request.message, "", MESSAGE_LIMIT)
        if (!message) return skip("empty_message")

        const requestedNotification = typeof request.notification === "object" ? request.notification : undefined
        const notificationSkip = focusSkip(requestedNotification?.when ?? "blurred", focus)
        const notificationRequested = input.config.attention.notifications && request.notification !== false
        const shouldNotify = notificationRequested && !notificationSkip
        notificationOutcome = !input.config.attention.notifications
          ? "disabled"
          : request.notification === false
            ? "not_requested"
            : notificationSkip ?? "not_attempted"
        const notification = shouldNotify
          ? (() => {
              try {
                const accepted = input.renderer.triggerNotification(
                  message,
                  normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT),
                )
                notificationOutcome = accepted ? "api_accepted" : "api_rejected"
                return accepted
              } catch {
                notificationOutcome = "exception"
                return false
              }
            })()
          : false
        record({ phase: "channel_result", channel: "notification", outcome: notificationOutcome })
        const volume = soundVolume(request, input.config)
        const requestedSound = typeof request.sound === "object" ? request.sound : undefined
        const soundSkip = volume === undefined ? undefined : focusSkip(requestedSound?.when ?? "always", focus)
        const soundName =
          requestedSound?.name && Schema.is(Config.AttentionSoundName)(requestedSound.name)
            ? requestedSound.name
            : "default"
        soundOutcome = volume === undefined
          ? input.config.attention.sound ? "not_requested" : "disabled"
          : soundSkip ?? await playSound(soundName, volume, record)
        const sound = soundOutcome === "playback_started"
        record({ phase: "channel_result", channel: "sound", outcome: soundOutcome })

        if (!notification && !sound) {
          if (notificationRequested && notificationSkip) return finish(skipped(notificationSkip))
          if (soundSkip) return finish(skipped(soundSkip))
        }

        return finish({
          ok: notification || sound,
          notification,
          sound,
        })
      } catch {
        record({ phase: "exception", outcome: "exception" })
        return finish({
          ok: false,
          notification: false,
          sound: false,
        })
      }
    },
  }
  const attention: AttentionHost = {
    notify: (request) => source.notify(request, "tui"),
    dispose() {
      if (disposed) return
      disposed = true
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
      diagnostics.dispose()
    },
  }
  sources.set(attention, source)
  return attention
}
