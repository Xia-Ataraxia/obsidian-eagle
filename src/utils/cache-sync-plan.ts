import type { WikilinkEmbedToken } from './markdown-image'

export interface CacheSyncPlan {
  /** One token per item to check now; marked in `checked`. */
  items: WikilinkEmbedToken[]
  /** The note has pre-display-name `{itemId}.{ext}` links and the vault hasn't been migrated. */
  migrate: boolean
}

/**
 * Picks the items in one note that still need a cache check this session.
 * While a migration is pending, legacy links stay unmarked: the rename rewrites
 * them, and the rewritten note (or the next event, if it failed) brings them back.
 */
export function planCacheSync(tokens: WikilinkEmbedToken[], checked: Set<string>, legacyMigrated: boolean): CacheSyncPlan {
  const migrate = !legacyMigrated && tokens.some((t) => t.displayName === undefined)
  const items: WikilinkEmbedToken[] = []
  for (const token of tokens) {
    if (migrate && token.displayName === undefined) continue
    if (checked.has(token.itemId)) continue
    checked.add(token.itemId)
    items.push(token)
  }
  return { items, migrate }
}
