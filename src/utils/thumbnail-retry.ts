export const THUMBNAIL_MAX_ATTEMPTS = 3
const BASE_DELAY_MS = 400

/** Decides what to do after the nth consecutive failure (1-based) of a thumbnail fetch. */
export function nextThumbnailRetry(failures: number): { giveUp: boolean; delayMs: number } {
  return { giveUp: failures >= THUMBNAIL_MAX_ATTEMPTS, delayMs: BASE_DELAY_MS * 2 ** (failures - 1) }
}
