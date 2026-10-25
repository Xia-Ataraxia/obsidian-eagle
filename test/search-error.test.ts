import { describe, expect, it } from 'vitest'

import EagleApiError, { EagleUnreachableError } from '../src/domain/EagleApiError'
import { searchErrorStatus } from '../src/domain/search-error'

describe(searchErrorStatus, () => {
  it('hides the engine error when Eagle is unreachable', () => {
    const status = searchErrorStatus(new EagleUnreachableError('net::ERR_UNSAFE_PORT'))
    expect(status).toBe("Couldn't reach Eagle. Make sure Eagle is open, then retry.")
    expect(status).not.toContain('net::')
  })

  it('shows Eagle API messages and hides unexpected errors', () => {
    expect(searchErrorStatus(new EagleApiError('Library not found'))).toBe('Search failed: Library not found')
    expect(searchErrorStatus(new TypeError('x is undefined'))).toBe('Search failed. Try again.')
  })
})
