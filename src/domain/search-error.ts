import EagleApiError, { EagleUnreachableError } from './EagleApiError'

export function searchErrorStatus(error: unknown): string {
  if (error instanceof EagleUnreachableError) return "Couldn't reach Eagle. Make sure Eagle is open, then retry."
  if (error instanceof EagleApiError) return `Search failed: ${error.message}`
  return 'Search failed. Try again.'
}
