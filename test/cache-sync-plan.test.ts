import { describe, expect, it } from 'vitest'

import EagleApiError, { EagleNotFoundError, EagleUnreachableError } from '../src/domain/EagleApiError'
import { contentFingerprint, legacyMigrationComplete, marksChecked, outcomeForError, planCacheSync, shouldReportProgress } from '../src/utils/cache-sync-plan'
import { findEagleWikilinkTokens } from '../src/utils/markdown-image'

const tokens = (md: string) => findEagleWikilinkTokens(md, 'eagle-cache')
const ids = (list: { itemId: string }[]) => list.map((t) => t.itemId)

describe(planCacheSync, () => {
  it('skips notes without cache links', () => {
    expect(planCacheSync(tokens('# plain note ![[photo.png]]'), new Set(), true)).toEqual({ items: [], legacy: [] })
  })

  it('lists each unchecked item once', () => {
    const plan = planCacheSync(tokens('![[eagle-cache/Sky_ABC.png]] ![[eagle-cache/Sky_ABC.png|300]] ![[eagle-cache/Sea_DEF.jpg]]'), new Set(['DEF']), false)
    expect(ids(plan.items)).toEqual(['ABC'])
  })

  it('splits legacy links out only for the rename, otherwise backfills them as they are', () => {
    const md = '![[eagle-cache/OLD.png]] ![[eagle-cache/Sky_ABC.png]]'
    const renaming = planCacheSync(tokens(md), new Set(), true)
    expect([ids(renaming.items), ids(renaming.legacy)]).toEqual([['ABC'], ['OLD']])
    const passive = planCacheSync(tokens(md), new Set(), false)
    expect([ids(passive.items), passive.items[0]?.displayName, passive.legacy]).toEqual([['OLD', 'ABC'], undefined, []])
  })
})

describe('item outcomes', () => {
  it('tells an unreachable Eagle apart from an item Eagle rejects', () => {
    expect(outcomeForError(new EagleUnreachableError('ECONNREFUSED'))).toBe('unreachable')
    expect(outcomeForError(new EagleNotFoundError('no such item'))).toBe('missing')
    expect(outcomeForError(new EagleApiError('500 library is switching'))).toBe('error')
    expect(outcomeForError(new Error('EACCES'))).toBe('failed')
  })

  it('leaves unreachable and uploading items unchecked, so they are retried', () => {
    expect(marksChecked('unreachable')).toBe(false)
    expect(marksChecked('uploading')).toBe(false)
    expect(marksChecked('error')).toBe(false)
    for (const outcome of ['present', 'cached', 'skipped', 'missing', 'failed'] as const) expect(marksChecked(outcome)).toBe(true)
  })
})

describe(legacyMigrationComplete, () => {
  it('needs an answer from Eagle for every legacy link', () => {
    expect(legacyMigrationComplete([], 0)).toBe(true)
    expect(legacyMigrationComplete(['missing'], 0)).toBe(true)
    expect(legacyMigrationComplete(['missing', 'unreachable'], 0)).toBe(false)
    expect(legacyMigrationComplete(['failed'], 0)).toBe(false)
    expect(legacyMigrationComplete(['error'], 0)).toBe(false)
  })

  it('stays unmigrated while any link could not be rewritten', () => {
    expect(legacyMigrationComplete(['cached'], 1)).toBe(false)
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

describe(contentFingerprint, () => {
  it('matches equal content and tells edits apart', () => {
    expect(contentFingerprint('![[a.png]]')).toBe(contentFingerprint('![[a.png]]'))
    expect(contentFingerprint('![[a.png]]')).not.toBe(contentFingerprint('![[b.png]]'))
    expect(contentFingerprint('ab')).not.toBe(contentFingerprint('abc'))
  })
})
