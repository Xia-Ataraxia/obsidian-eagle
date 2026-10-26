import type { WikilinkEmbedToken } from './markdown-image'

export interface CacheSyncPlan {
  /** One token per item not yet checked this session. */
  items: WikilinkEmbedToken[]
  /** Links still in the pre-display-name `{itemId}.{ext}` form. */
  hasLegacyNames: boolean
}

/** Picks the items in one note that still need a cache check; marks them in `checked`. */
export function planCacheSync(tokens: WikilinkEmbedToken[], checked: Set<string>): CacheSyncPlan {
  const items: WikilinkEmbedToken[] = []
  for (const token of tokens) {
    if (checked.has(token.itemId)) continue
    checked.add(token.itemId)
    items.push(token)
  }
  return { items, hasLegacyNames: tokens.some((t) => t.displayName === undefined) }
}
