import EagleApiError, { EagleUnreachableError } from '../domain/EagleApiError'
import type { WikilinkEmbedToken } from './markdown-image'

/**
 * present: already on disk. cached: copied now. skipped: Eagle has no local file for it.
 * missing: Eagle doesn't know the item. unreachable: Eagle didn't answer. failed: anything else.
 */
export type ItemOutcome = 'present' | 'cached' | 'skipped' | 'missing' | 'unreachable' | 'failed'

export interface CacheSyncPlan {
  /** One token per named item not yet checked this session. */
  items: WikilinkEmbedToken[]
  /** Pre-display-name `{itemId}.{ext}` links to rename first, while the vault isn't fully migrated. */
  legacy: WikilinkEmbedToken[]
}

/** Picks the items in one note that still need a check; marking them checked is up to the outcome. */
export function planCacheSync(tokens: WikilinkEmbedToken[], checked: ReadonlySet<string>, legacyMigrated: boolean): CacheSyncPlan {
  const seen = new Set<string>()
  const plan: CacheSyncPlan = { items: [], legacy: [] }
  for (const token of tokens) {
    if (checked.has(token.itemId) || seen.has(token.itemId)) continue
    seen.add(token.itemId)
    const isLegacy = !legacyMigrated && token.displayName === undefined
    plan[isLegacy ? 'legacy' : 'items'].push(token)
  }
  return plan
}

export function outcomeForError(err: unknown): 'missing' | 'unreachable' | 'failed' {
  if (err instanceof EagleUnreachableError) return 'unreachable'
  return err instanceof EagleApiError ? 'missing' : 'failed'
}

/** An item Eagle didn't answer for is retried once Eagle is back; everything else is settled for the session. */
export function marksChecked(outcome: ItemOutcome): boolean {
  return outcome !== 'unreachable'
}

/** The vault counts as migrated only when Eagle answered for every legacy link (missing items can never be renamed). */
export function legacyMigrationComplete(outcomes: Iterable<ItemOutcome>): boolean {
  for (const outcome of outcomes) if (outcome === 'unreachable' || outcome === 'failed') return false
  return true
}

export const PROGRESS_INTERVAL_MS = 250
export const PROGRESS_EVERY_FILES = 25

export function shouldReportProgress(done: number, total: number, lastReportAt: number, now: number): boolean {
  return done === total || done % PROGRESS_EVERY_FILES === 0 || now - lastReportAt >= PROGRESS_INTERVAL_MS
}
