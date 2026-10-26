import { describe, expect, it } from 'vitest'

import { hasAllTags, parseSearchQuery, selectByTags, tagFetchLimit } from '../src/utils/search-query'

describe(parseSearchQuery, () => {
  it.each([
    ['sunset', { keyword: 'sunset', tags: [] }],
    ['#Forest', { keyword: '', tags: ['Forest'] }],
    ['#Analog #BlackAndWhite', { keyword: '', tags: ['Analog', 'BlackAndWhite'] }],
    ['Anna #Portrait', { keyword: 'Anna', tags: ['Portrait'] }],
    ['#black and white', { keyword: '', tags: ['black and white'] }],
    ['  Anna   #  Portrait  # ', { keyword: 'Anna', tags: ['Portrait'] }],
    ['#', { keyword: '', tags: [] }],
    ['', { keyword: '', tags: [] }],
  ])('parses %j', (input, expected) => {
    expect(parseSearchQuery(input)).toEqual(expected)
  })
})

describe(hasAllTags, () => {
  it('requires every wanted tag, case-insensitively', () => {
    expect(hasAllTags(['Analog', 'Black and White'], ['analog', 'black and white'])).toBe(true)
    expect(hasAllTags(['Analog'], ['analog', 'portrait'])).toBe(false)
    expect(hasAllTags(undefined, [])).toBe(true)
    expect(hasAllTags(undefined, ['a'])).toBe(false)
  })
})

describe('multi-tag fetch', () => {
  it('widens the request only for 2+ tags', () => {
    expect(tagFetchLimit(100, 1)).toBe(100)
    expect(tagFetchLimit(100, 2)).toBe(1000)
  })
  it('keeps only items with every tag, trimmed to the limit', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: i, tags: ['a', 'b'] })).concat([{ id: 9, tags: ['a'] }])
    expect(selectByTags(items, ['a', 'b'], 3).map((i) => i.id)).toEqual([0, 1, 2])
  })
})
