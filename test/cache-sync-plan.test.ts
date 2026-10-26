import { describe, expect, it } from 'vitest'

import { planCacheSync } from '../src/utils/cache-sync-plan'
import { findEagleWikilinkTokens } from '../src/utils/markdown-image'

const tokens = (md: string) => findEagleWikilinkTokens(md, 'eagle-cache')

describe(planCacheSync, () => {
  it('skips notes without cache links', () => {
    expect(planCacheSync(tokens('# plain note ![[photo.png]]'), new Set())).toEqual({ items: [], hasLegacyNames: false })
  })

  it('checks each item once per session, across notes', () => {
    const checked = new Set<string>()
    const first = planCacheSync(tokens('![[eagle-cache/Sky_ABC.png]] ![[eagle-cache/Sky_ABC.png|300]] ![[eagle-cache/Sea_DEF.jpg]]'), checked)
    expect(first.items.map((t) => t.itemId)).toEqual(['ABC', 'DEF'])

    const second = planCacheSync(tokens('![[eagle-cache/Sea_DEF.jpg]] ![[eagle-cache/Hill_GHI.png]]'), checked)
    expect(second.items.map((t) => t.itemId)).toEqual(['GHI'])
    expect(planCacheSync(tokens('![[eagle-cache/Sky_ABC.png]]'), checked).items).toEqual([])
  })

  it('flags legacy names even for items already checked', () => {
    const checked = new Set(['ABC'])
    expect(planCacheSync(tokens('![[eagle-cache/ABC.png]]'), checked)).toEqual({ items: [], hasLegacyNames: true })
  })
})
