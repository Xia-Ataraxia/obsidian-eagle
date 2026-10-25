import { describe, expect, it } from 'vitest'

import { countLabel } from '../src/utils/plural'

describe(countLabel, () => {
  it('uses the singular only for exactly one', () => {
    expect(countLabel(1, 'link')).toBe('1 link')
    expect(countLabel(0, 'link')).toBe('0 links')
    expect(countLabel(3, 'file')).toBe('3 files')
  })
})
