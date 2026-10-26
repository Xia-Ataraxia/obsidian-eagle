import { describe, expect, it } from 'vitest'

import EagleApiError, { EagleUnreachableError } from '../src/domain/EagleApiError'
import { legacyMigrationComplete, marksChecked, outcomeForError, planCacheSync, shouldReportProgress } from '../src/utils/cache-sync-plan'
import { findEagleWikilinkTokens } from '../src/utils/markdown-image'

const tokens = (md: string) => findEagleWikilinkTokens(md, 'eagle-cache')
const ids = (list: { itemId: string }[]) => list.map((t) => t.itemId)

describe(planCacheSync, () => {
  it('skips notes without cache links', () => {
    expect(planCacheSync(tokens('# plain note ![[photo.png]]'), new Set(), false)).toEqual({ items: [], legacy: [] })
  })

  it('lists each unchecked item once', () => {
    const plan = planCacheSync(tokens('![[eagle-cache/Sky_ABC.png]] ![[eagle-cache/Sky_ABC.png|300]] ![[eagle-cache/Sea_DEF.jpg]]'), new Set(['DEF']), true)
    expect(ids(plan.items)).toEqual(['ABC'])
  })

  it('splits legacy links out for renaming until the vault is migrated', () => {
    const md = '![[eagle-cache/OLD.png]] ![[eagle-cache/Sky_ABC.png]]'
    const pending = planCacheSync(tokens(md), new Set(), false)
    expect([ids(pending.items), ids(pending.legacy)]).toEqual([['ABC'], ['OLD']])
    expect(ids(planCacheSync(tokens(md), new Set(), true).items)).toEqual(['OLD', 'ABC'])
  })
})

describe('item outcomes', () => {
  it('tells an unreachable Eagle apart from an item Eagle rejects', () => {
    expect(outcomeForError(new EagleUnreachableError('ECONNREFUSED'))).toBe('unreachable')
    expect(outcomeForError(new EagleApiError('404 Not Found'))).toBe('missing')
    expect(outcomeForError(new Error('EACCES'))).toBe('failed')
  })

  it('leaves only unreachable items unchecked, so they are retried once Eagle is back', () => {
    expect(marksChecked('unreachable')).toBe(false)
    for (const outcome of ['present', 'cached', 'skipped', 'missing', 'failed'] as const) expect(marksChecked(outcome)).toBe(true)
  })
})

describe(legacyMigrationComplete, () => {
  it('needs an answer from Eagle for every legacy link', () => {
    expect(legacyMigrationComplete([])).toBe(true)
    expect(legacyMigrationComplete(['missing'])).toBe(true)
    expect(legacyMigrationComplete(['missing', 'unreachable'])).toBe(false)
    expect(legacyMigrationComplete(['failed'])).toBe(false)
  })
})

describe(shouldReportProgress, () => {
  it('reports every 25 files, every 250 ms, and at the end', () => {
    expect(shouldReportProgress(3, 100, 1000, 1100)).toBe(false)
    expect(shouldReportProgress(25, 100, 1000, 1100)).toBe(true)
    expect(shouldReportProgress(3, 100, 1000, 1250)).toBe(true)
    expect(shouldReportProgress(100, 100, 1000, 1001)).toBe(true)
  })
})
