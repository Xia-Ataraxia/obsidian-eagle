import { describe, expect, it } from 'vitest'

import { planCacheSync } from '../src/utils/cache-sync-plan'
import { findEagleWikilinkTokens } from '../src/utils/markdown-image'

const tokens = (md: string) => findEagleWikilinkTokens(md, 'eagle-cache')
const ids = (md: string, checked: Set<string>, migrated = true) => planCacheSync(tokens(md), checked, migrated).items.map((t) => t.itemId)

describe(planCacheSync, () => {
  it('skips notes without cache links', () => {
    expect(planCacheSync(tokens('# plain note ![[photo.png]]'), new Set(), false)).toEqual({ items: [], migrate: false })
  })

  it('checks each item once per session, across notes', () => {
    const checked = new Set<string>()
    expect(ids('![[eagle-cache/Sky_ABC.png]] ![[eagle-cache/Sky_ABC.png|300]] ![[eagle-cache/Sea_DEF.jpg]]', checked)).toEqual(['ABC', 'DEF'])
    expect(ids('![[eagle-cache/Sea_DEF.jpg]] ![[eagle-cache/Hill_GHI.png]]', checked)).toEqual(['GHI'])
  })

  it('keeps items checked after a failed fetch, so an offline Eagle is not re-queried on every edit', () => {
    const checked = new Set<string>()
    ids('![[eagle-cache/Sky_ABC.png]]', checked)
    expect(ids('![[eagle-cache/Sky_ABC.png]] edited', checked)).toEqual([])
  })

  it('asks for the migration and still syncs the named links in the same note', () => {
    const checked = new Set<string>()
    const plan = planCacheSync(tokens('![[eagle-cache/OLD.png]] ![[eagle-cache/Sky_ABC.png]]'), checked, false)
    expect(plan.migrate).toBe(true)
    expect(plan.items.map((t) => t.itemId)).toEqual(['ABC'])
    expect(checked.has('OLD')).toBe(false)
  })

  it('retries legacy links on the next event if the migration left them in place', () => {
    const checked = new Set<string>()
    planCacheSync(tokens('![[eagle-cache/OLD.png]]'), checked, false)
    expect(ids('![[eagle-cache/OLD.png]]', checked, true)).toEqual(['OLD'])
  })
})
