import { describe, expect, it } from 'vitest'

import { findEagleWikilinkTokens, findMarkdownImageTokens } from '../src/utils/markdown-image'

describe(findMarkdownImageTokens, () => {
  it('finds image links containing spaces and parentheses', () => {
    const md = 'Hello ![](file:///Users/me/images/ID.info/우리가 (PFD).jpg) world'
    const tokens = findMarkdownImageTokens(md)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.alt).toBe('')
    expect(tokens[0]?.link).toBe('file:///Users/me/images/ID.info/우리가 (PFD).jpg')
  })

  it('skips fenced code blocks', () => {
    const md = [
      '```md',
      '![](file:///Users/me/images/ID.info/a b.jpg)',
      '```',
      '',
      '![](file:///Users/me/images/ID.info/c d.jpg)',
    ].join('\n')
    const tokens = findMarkdownImageTokens(md)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.link).toContain('c d.jpg')
  })
})

describe(findEagleWikilinkTokens, () => {
  const CACHE = 'eagle-cache'

  it('parses old-format token (bare itemId, no displayName)', () => {
    const md = '![[eagle-cache/M2K8ABC123.jpg]]'
    const tokens = findEagleWikilinkTokens(md, CACHE)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.itemId).toBe('M2K8ABC123')
    expect(tokens[0]?.displayName).toBeUndefined()
    expect(tokens[0]?.ext).toBe('jpg')
  })

  it('parses new-format token (displayName_itemId)', () => {
    const md = '![[eagle-cache/screenshot_2025-03-14_M2K8ABC.png]]'
    const tokens = findEagleWikilinkTokens(md, CACHE)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.itemId).toBe('M2K8ABC')
    expect(tokens[0]?.displayName).toBe('screenshot_2025-03-14')
    expect(tokens[0]?.ext).toBe('png')
  })

  it('handles displayName with multiple underscores correctly', () => {
    const md = '![[eagle-cache/my_cool_photo_ITEMID123.jpeg]]'
    const tokens = findEagleWikilinkTokens(md, CACHE)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.itemId).toBe('ITEMID123')
    expect(tokens[0]?.displayName).toBe('my_cool_photo')
    expect(tokens[0]?.ext).toBe('jpeg')
  })

  it('finds multiple tokens of mixed formats', () => {
    const md = [
      '![[eagle-cache/OLDID.jpg]]',
      '![[eagle-cache/my_image_NEWID.png]]',
    ].join('\n')
    const tokens = findEagleWikilinkTokens(md, CACHE)
    expect(tokens).toHaveLength(2)
    expect(tokens[0]).toMatchObject({ itemId: 'OLDID', displayName: undefined, ext: 'jpg' })
    expect(tokens[1]).toMatchObject({ itemId: 'NEWID', displayName: 'my_image', ext: 'png' })
  })

  it('skips fenced code blocks', () => {
    const md = [
      '```',
      '![[eagle-cache/ITEMID.jpg]]',
      '```',
      '![[eagle-cache/REALID.png]]',
    ].join('\n')
    const tokens = findEagleWikilinkTokens(md, CACHE)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]?.itemId).toBe('REALID')
  })

  it('returns empty array when no eagle wikilinks are present', () => {
    expect(findEagleWikilinkTokens('no images here', CACHE)).toHaveLength(0)
  })
})
