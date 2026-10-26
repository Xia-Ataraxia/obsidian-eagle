import { describe, expect, it } from 'vitest'

import { nextThumbnailRetry } from '../src/utils/thumbnail-retry'

describe('nextThumbnailRetry', () => {
  it('backs off exponentially then gives up', () => {
    expect(nextThumbnailRetry(1)).toEqual({ giveUp: false, delayMs: 400 })
    expect(nextThumbnailRetry(2)).toEqual({ giveUp: false, delayMs: 800 })
    expect(nextThumbnailRetry(3).giveUp).toBe(true)
  })
})
