import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

// 对应用例：TC-002（开启后当天助手消息显示 HH:mm）、TC-005（跨天消息显示 HH:mm · 日期）
// AssistantMessage footer 与用户消息时间戳共用 Locale.todayTimeOrDateTime
// （packages/tui/src/routes/session/index.tsx L1443 用户消息、L1564 助手消息）。
describe("locale", () => {
  describe("todayTimeOrDateTime", () => {
    test("returns time-only for a timestamp from today", () => {
      const now = new Date()
      const input = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 30).getTime()
      expect(Locale.todayTimeOrDateTime(input)).toBe(Locale.time(input))
      expect(Locale.todayTimeOrDateTime(input)).not.toContain("·")
    })

    test("returns time and date for a timestamp from a previous day", () => {
      const input = Date.now() - 24 * 60 * 60 * 1000
      const result = Locale.todayTimeOrDateTime(input)
      expect(result).toBe(Locale.datetime(input))
      expect(result).toContain("·")
      expect(result).toContain(new Date(input).toLocaleDateString())
    })

    test("returns time and date for a timestamp from a previous year", () => {
      const input = new Date(2020, 0, 15, 14, 32).getTime()
      const result = Locale.todayTimeOrDateTime(input)
      expect(result).toBe(Locale.datetime(input))
      expect(result).toContain("·")
    })

    test("datetime format is `<time> · <date>`", () => {
      const input = new Date(2020, 0, 15, 14, 32).getTime()
      expect(Locale.datetime(input)).toBe(`${Locale.time(input)} · ${new Date(input).toLocaleDateString()}`)
    })
  })
})
