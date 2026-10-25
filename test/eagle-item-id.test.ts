import { describe, expect, it } from 'vitest'

import { eagleItemIdFromAlt, eagleItemIdFromLink } from '../src/utils/eagle-item-id'

describe('eagleItemIdFromAlt', () => {
  it('extracts the id from old-format alt text', () => {
    expect(eagleItemIdFromAlt('eagle:ABC123')).toBe('ABC123')
    expect(eagleItemIdFromAlt(' eagle:ABC123|400 ')).toBe('ABC123')
  })

  it('returns null for other alt text', () => {
    expect(eagleItemIdFromAlt('photo')).toBeNull()
    expect(eagleItemIdFromAlt('eagle:')).toBeNull()
  })
})

describe('eagleItemIdFromLink', () => {
  it('extracts the id from a library path', () => {
    expect(eagleItemIdFromLink('/Lib.library/images/ABC123.info/pic.png')).toBe('ABC123')
    expect(eagleItemIdFromLink('C:\\Lib.library\\images\\ABC123.info\\pic.png')).toBe('ABC123')
  })

  it('returns null for unrelated links', () => {
    expect(eagleItemIdFromLink('https://example.com/a.png')).toBeNull()
  })
})
