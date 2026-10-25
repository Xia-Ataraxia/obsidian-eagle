export function eagleItemIdFromAlt(alt: string): string | null {
  const match = alt.trim().match(/^eagle:([A-Za-z0-9]+)(?:\|\d+)?$/)
  return match ? match[1] ?? null : null
}

export function eagleItemIdFromLink(link: string): string | null {
  const match = link.match(/[\\/]+images[\\/]+([^\\/]+)\.info[\\/]+/i)
  return match ? match[1] ?? null : null
}
