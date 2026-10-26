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
  /** One token per pre-display-name `{itemId}.{ext}` item; every note's links move, so checked items stay in. */
  legacy: WikilinkEmbedToken[]
}

/** Picks the items in one note that still need work; marking them checked is up to the outcome. */
export function planCacheSync(tokens: WikilinkEmbedToken[], checked: ReadonlySet<string>): CacheSyncPlan {
  const seen = new Set<string>()
  const plan: CacheSyncPlan = { items: [], legacy: [] }
  for (const token of tokens) {
    if (seen.has(token.itemId)) continue
    const isLegacy = token.displayName === undefined
    if (!isLegacy && checked.has(token.itemId)) continue
    seen.add(token.itemId)
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

/** Cheap stand-in for a note's content, enough to recognise the plugin's own write. */
export function contentFingerprint(content: string): string {
  let hash = 0
  for (let i = 0; i < content.length; i++) hash = (Math.imul(hash, 31) + content.charCodeAt(i)) | 0
  return `${content.length}:${hash}`
}
