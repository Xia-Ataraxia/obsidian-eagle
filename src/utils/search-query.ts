export interface ParsedSearchQuery {
  keyword: string
  tags: string[]
}

/** Text before the first `#` is the keyword; each `#tag` (may contain spaces) runs to the next `#`. */
export function parseSearchQuery(input: string): ParsedSearchQuery {
  const [keyword = '', ...tagParts] = input.split('#')
  const tags = tagParts.map((tag) => tag.trim()).filter(Boolean)
  return { keyword: keyword.trim(), tags }
}

/** Eagle ORs the `tags` param; the picker narrows to items carrying every requested tag. */
export function hasAllTags(itemTags: string[] | undefined, wanted: string[]): boolean {
  const have = new Set((itemTags ?? []).map((tag) => tag.toLowerCase()))
  return wanted.every((tag) => have.has(tag.toLowerCase()))
}

/** Eagle ORs the `tags` param, so multi-tag queries fetch a wide page and narrow locally. */
export function tagFetchLimit(limit: number, tagCount: number): number {
  return tagCount >= 2 ? Math.max(limit, 1000) : limit
}

export function selectByTags<T extends { tags?: string[] }>(items: T[], wanted: string[], limit: number): T[] {
  return items.filter((item) => hasAllTags(item.tags, wanted)).slice(0, limit)
}
