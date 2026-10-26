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
