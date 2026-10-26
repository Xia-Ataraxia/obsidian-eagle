import { describe, expect, it, vi } from 'vitest'

import { withTimeout } from '../src/utils/with-timeout'

vi.stubGlobal('window', { setTimeout, clearTimeout })

describe(withTimeout, () => {
  it('returns the fallback when the promise hangs', async () => {
    expect(await withTimeout(new Promise<boolean>(() => {}), 10, false)).toBe(false)
  })
  it('returns the value when the promise settles first', async () => {
    expect(await withTimeout(Promise.resolve(true), 1000, false)).toBe(true)
  })
})
