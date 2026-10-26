import { describe, expect, it } from 'vitest'

import { parseSearchQuery } from '../src/utils/search-query'

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
