import EagleApiError, { EagleNotFoundError, EagleUnreachableError } from '../domain/EagleApiError'
import type { WikilinkEmbedToken } from './markdown-image'

/**
 * present: already on disk. cached: copied now. skipped: Eagle has no local file for it.
 * missing: Eagle confirmed it has no such item. unreachable: Eagle didn't answer.
 * error: Eagle answered with another error (e.g. while switching libraries). failed: anything else.
 * uploading: an upload in flight is writing it; the next sync looks again.
 */
export type ItemOutcome = 'present' | 'cached' | 'skipped' | 'missing' | 'unreachable' | 'error' | 'failed' | 'uploading'

export interface CacheSyncPlan {
  /** One token per named item not yet checked this session. */
  items: WikilinkEmbedToken[]
  /** Pre-display-name `{itemId}.{ext}` links set aside for the rename, only when `renameLegacy` is on. */
  legacy: WikilinkEmbedToken[]
}

/**
 * Picks the items in one note that still need a check; marking them checked is up to the outcome.
 * Without `renameLegacy`, legacy links are backfilled under the filename they already use.
 */
export function planCacheSync(tokens: WikilinkEmbedToken[], checked: ReadonlySet<string>, renameLegacy: boolean): CacheSyncPlan {
  const seen = new Set<string>()
  const plan: CacheSyncPlan = { items: [], legacy: [] }
  for (const token of tokens) {
    if (checked.has(token.itemId) || seen.has(token.itemId)) continue
    seen.add(token.itemId)
    const isLegacy = renameLegacy && token.displayName === undefined
    plan[isLegacy ? 'legacy' : 'items'].push(token)
  }
  return plan
}

export function outcomeForError(err: unknown): 'missing' | 'unreachable' | 'error' | 'failed' {
  if (err instanceof EagleUnreachableError) return 'unreachable'
  if (err instanceof EagleNotFoundError) return 'missing'
  return err instanceof EagleApiError ? 'error' : 'failed'
}

/** Items Eagle didn't answer for, answered with an error, or an upload is still writing are retried; the rest are settled for the session. */
export function marksChecked(outcome: ItemOutcome): boolean {
  return outcome !== 'unreachable' && outcome !== 'error' && outcome !== 'uploading'
}

/**
 * The vault counts as migrated only when Eagle answered for every legacy link (missing items can never
 * be renamed) and every link to a renamed item was rewritten.
 */
export function legacyMigrationComplete(outcomes: Iterable<ItemOutcome>, linkFailures: number): boolean {
  if (linkFailures > 0) return false
  for (const outcome of outcomes) if (outcome === 'unreachable' || outcome === 'error' || outcome === 'failed') return false
  return true
}

/** Cheap stand-in for a note's content, enough to recognise the plugin's own write. */
export function contentFingerprint(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) hash = (Math.imul(hash, 31) + content.charCodeAt(i)) | 0
  return `${content.length}:${hash}`
}

export const PROGRESS_INTERVAL_MS = 250
export const PROGRESS_EVERY_FILES = 25

export function shouldReportProgress(done: number, total: number, lastReportAt: number, now: number): boolean {
  return done === total || done % PROGRESS_EVERY_FILES === 0 || now - lastReportAt >= PROGRESS_INTERVAL_MS
}
