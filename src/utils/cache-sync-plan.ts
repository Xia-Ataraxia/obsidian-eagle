import EagleApiError, { EagleNotFoundError, EagleUnreachableError } from '../domain/EagleApiError'
import type { WikilinkEmbedToken } from './markdown-image'

/**
 * present: already on disk. cached: copied now. skipped: Eagle has no local file for it.
 * missing: the cache's own library confirmed it has no such item. unreachable: Eagle didn't answer.
 * error: Eagle answered with another error, or not-found from another library. failed: anything else.
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

/** Only outcomes that won't change on a retry settle an item for the session. */
export function marksChecked(outcome: ItemOutcome): boolean {
  return outcome !== 'unreachable' && outcome !== 'error' && outcome !== 'failed' && outcome !== 'uploading'
}

/** An unknown cache library (nothing cached yet, or Eagle gave no path) is never the same library. */
export function isSameLibrary(cacheLibraryPath: string, openLibraryPath: string | null): boolean {
  return cacheLibraryPath !== '' && cacheLibraryPath === openLibraryPath
}

export const ERROR_RETRY_MS = 30_000
export const UPLOAD_RETRY_MS = 2_000

/**
 * When to sync a note again after some of its items couldn't settle: when Eagle is due back, after an
 * Eagle error has had time to clear, or soon for an upload in flight. Only the upload case repeats,
 * because uploads always finish; the others retry once and later events retry again.
 */
export function retryPlan(outcomes: Iterable<ItemOutcome>, backoffRemainingMs: number): { delayMs: number; repeat: boolean } | null {
  const seen = new Set(outcomes)
  if (seen.has('unreachable')) return { delayMs: Math.max(0, backoffRemainingMs) + 100, repeat: false }
  if (seen.has('error')) return { delayMs: ERROR_RETRY_MS, repeat: false }
  if (seen.has('uploading')) return { delayMs: UPLOAD_RETRY_MS, repeat: true }
  return null
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
