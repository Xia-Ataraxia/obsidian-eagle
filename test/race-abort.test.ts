import { describe, expect, it } from 'vitest'

import { raceAbort } from '../src/utils/race-abort'

describe('raceAbort', () => {
  it('rejects only the aborting caller; the shared promise still serves the others', async () => {
    let resolveShared!: (v: string) => void
    const shared = new Promise<string>((r) => { resolveShared = r })
    const first = new AbortController()
    const a = raceAbort(shared, first.signal)
    const b = raceAbort(shared, new AbortController().signal)
    first.abort()
    await expect(a).rejects.toMatchObject({ name: 'AbortError' })
    resolveShared('file:///x.png')
    await expect(b).resolves.toBe('file:///x.png')
  })

  it('rejects immediately when already aborted', async () => {
    const c = new AbortController()
    c.abort()
    await expect(raceAbort(new Promise<string>(() => undefined), c.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('passes through without a signal', async () => {
    await expect(raceAbort(Promise.resolve(1))).resolves.toBe(1)
  })
})
