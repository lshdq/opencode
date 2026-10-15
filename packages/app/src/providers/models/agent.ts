export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "build") ?? items[0]
}

export type DraftAgentSelection = {
  draftID: string
  name?: string
}

export function resolveDraftAgent<T extends { name: string }>(
  items: T[],
  draftID: string,
  selection?: DraftAgentSelection,
) {
  if (selection?.draftID === draftID && selection.name) {
    const selected = items.find((item) => item.name === selection.name)

    if (selected) return { item: selected, selection }
    // An unloaded or temporarily empty catalog cannot invalidate a manual choice.
    if (items.length === 0) return { item: undefined, selection }
  }

  return { item: items[0], selection: { draftID } }
}
