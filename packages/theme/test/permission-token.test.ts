import { expect, test } from "bun:test"
import { Schema } from "effect"
import { ThemeDocument, resolveThemeDocument, migrateV1 } from "../src/tui/index.js"
import type { ThemeV1Json } from "../src/tui/v1.js"

const source = await Bun.file(new URL("../../tui/src/theme/assets/v2/opencode.json", import.meta.url)).json()
const decode = Schema.decodeUnknownSync(ThemeDocument)

test.each(["light", "dark"] as const)("auto-accept is an independent %s semantic token", (mode) => {
  const document = decode(source)
  const theme = resolveThemeDocument(document, mode)
  expect(theme.text.permission.autoaccept.toInts()).not.toEqual(theme.text.muted.toInts())
  const custom = decode({
    ...source,
    base: {
      ...source.base,
      text: { ...source.base.text, permission: { autoaccept: "#123456" } },
    },
  })
  expect(resolveThemeDocument(custom, mode).text.permission.autoaccept.toInts()).toEqual([18, 52, 86, 255])
  expect(resolveThemeDocument(custom, mode).text.muted.toInts()).toEqual(theme.text.muted.toInts())
  expect(resolveThemeDocument(custom, mode).surface("dialog").text.permission.autoaccept.toInts()).toEqual([18, 52, 86, 255])
})

test.each(["light", "dark"] as const)("old/custom %s themes fall back without borrowing status colors", async (mode) => {
  const custom = structuredClone(source)
  delete custom.base.text.permission
  custom.base.text.feedback.warning.base = "#010203"
  const theme = resolveThemeDocument(decode(custom), mode)
  expect(theme.text.permission.autoaccept.toInts()).toEqual(resolveThemeDocument(decode(source), mode).text.permission.autoaccept.toInts())
  const legacy: ThemeV1Json = await Bun.file(new URL("../../tui/src/theme/assets/opencode.json", import.meta.url)).json()
  expect(resolveThemeDocument(migrateV1(legacy), mode).text.permission.autoaccept).toBeDefined()
})
