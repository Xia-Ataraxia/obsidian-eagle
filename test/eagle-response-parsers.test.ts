import { describe, expect, it } from 'vitest'

import EagleApiError from '../src/domain/EagleApiError'
import {
  extractResponseMessage,
  flattenFolderTree,
  parseFolderList,
  parseStringDataResponse,
} from '../src/utils/eagle-response-parsers'

describe('parseStringDataResponse', () => {
  it('keeps only string fields', () => {
    expect(parseStringDataResponse({ status: 'success', message: 1, data: 'x' })).toEqual({
      status: 'success',
      message: undefined,
      data: 'x',
    })
  })

  it('returns empty for non-objects', () => {
    expect(parseStringDataResponse(null)).toEqual({})
  })
})

describe('extractResponseMessage', () => {
  it('trims message and ignores blanks', () => {
    expect(extractResponseMessage({ message: ' hi ' })).toBe('hi')
    expect(extractResponseMessage({ message: '  ' })).toBe('')
    expect(extractResponseMessage('nope')).toBe('')
  })
})

describe('folder tree', () => {
  const tree = parseFolderList([
    { id: 'a', name: 'A', children: [{ id: 'b', name: 'B', children: [] }] },
  ])

  it('flattens to slash paths', () => {
    expect(flattenFolderTree(tree)).toEqual([
      { id: 'a', name: 'A', path: 'A' },
      { id: 'b', name: 'B', path: 'A/B' },
    ])
  })

  it('rejects malformed nodes', () => {
    expect(() => parseFolderList([{ id: 1, name: 'x' }])).toThrow(EagleApiError)
  })
})
