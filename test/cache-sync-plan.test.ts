import { describe, expect, it } from 'vitest'

import EagleApiError, { EagleNotFoundError, EagleUnreachableError } from '../src/domain/EagleApiError'
import { ERROR_RETRY_MS, UPLOAD_RETRY_MS, contentFingerprint, isSameLibrary, marksChecked, outcomeForError, planCacheSync, retryPlan } from '../src/utils/cache-sync-plan'
import { findEagleWikilinkTokens } from '../src/utils/markdown-image'

const tokens = (md: string) => findEagleWikilinkTokens(md, 'eagle-cache')
const ids = (list: { itemId: string }[]) => list.map((t) => t.itemId)

describe(planCacheSync, () => {
  it('skips notes without cache links', () => {
    expect(planCacheSync(tokens('# plain note ![[photo.png]]'), new Set())).toEqual({ items: [], legacy: [] })
  })

  it('lists each unchecked item once', () => {
    const plan = planCacheSync(tokens('![[eagle-cache/Sky_ABC.png]] ![[eagle-cache/Sky_ABC.png|300]] ![[eagle-cache/Sea_DEF.jpg]]'), new Set(['DEF']))
    expect(ids(plan.items)).toEqual(['ABC'])
  })

  it('splits legacy links out and keeps them even once checked, since every note linking them moves', () => {
    const plan = planCacheSync(tokens('![[eagle-cache/OLD.png]] ![[eagle-cache/OLD.png|200]] ![[eagle-cache/Sky_ABC.png]]'), new Set(['OLD']))
    expect([ids(plan.items), ids(plan.legacy)]).toEqual([['ABC'], ['OLD']])
  })
})

describe('item outcomes', () => {
  it('tells an unreachable Eagle apart from an item Eagle rejects', () => {
    expect(outcomeForError(new EagleUnreachableError('ECONNREFUSED'))).toBe('unreachable')
    expect(outcomeForError(new EagleNotFoundError('no such item'))).toBe('missing')
    expect(outcomeForError(new EagleApiError('500 library is switching'))).toBe('error')
    expect(outcomeForError(new Error('EACCES'))).toBe('failed')
  })

  it('leaves outcomes a retry could change unchecked', () => {
    for (const outcome of ['unreachable', 'uploading', 'error', 'failed'] as const) expect(marksChecked(outcome)).toBe(false)
    for (const outcome of ['present', 'cached', 'skipped', 'missing'] as const) expect(marksChecked(outcome)).toBe(true)
  })

  it('trusts a not-found only from the library the cache came from', () => {
    expect(isSameLibrary('/lib/A.library', '/lib/A.library')).toBe(true)
    expect(isSameLibrary('/lib/A.library', '/lib/B.library')).toBe(false)
    expect(isSameLibrary('', '/lib/A.library')).toBe(false)
    expect(isSameLibrary('/lib/A.library', null)).toBe(false)
  })
})

describe(retryPlan, () => {
  it('retries once Eagle is due back, after an error has had time to clear, and soon while uploading', () => {
    expect(retryPlan(['cached', 'unreachable', 'error'], 12_000)).toEqual({ delayMs: 12_100, repeat: false })
    expect(retryPlan(['error', 'uploading'], 0)).toEqual({ delayMs: ERROR_RETRY_MS, repeat: false })
    expect(retryPlan(['uploading'], 0)).toEqual({ delayMs: UPLOAD_RETRY_MS, repeat: true })
    expect(retryPlan(['present', 'failed', 'missing'], 0)).toBeNull()
  })
})

describe(contentFingerprint, () => {
  it('matches equal content and tells edits apart', () => {
    expect(contentFingerprint('![[a.png]]')).toBe(contentFingerprint('![[a.png]]'))
    expect(contentFingerprint('![[a.png]]')).not.toBe(contentFingerprint('![[b.png]]'))
    expect(contentFingerprint('ab')).not.toBe(contentFingerprint('abc'))
  })
})
