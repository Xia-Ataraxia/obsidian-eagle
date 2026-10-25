import { describe, expect, it, vi } from 'vitest'

vi.mock('obsidian', () => ({}))

import { rewriteNote } from '../src/ui/obsidian-vault'

type Vault = Parameters<typeof rewriteNote>[0]
type File = Parameters<typeof rewriteNote>[1]

function vaultWith(content: string) {
  let stored = content
  const vault = { process: async (_f: File, fn: (c: string) => string) => (stored = fn(stored)) }
  return { vault: vault as unknown as Vault, get: () => stored }
}

describe('rewriteNote', () => {
  it('computes replacements from the content being written and reports the count', async () => {
    const v = vaultWith('a OLD b OLD')
    const seen: string[] = []
    const n = await rewriteNote(v.vault, {} as File, (c) => {
      seen.push(c)
      return [...c.matchAll(/OLD/g)].map((m) => ({ start: m.index, end: m.index + 3, text: 'NEW' }))
    })
    expect(n).toBe(2)
    expect(v.get()).toBe('a NEW b NEW')
    expect(seen).toEqual(['a OLD b OLD'])
  })

  it('leaves the note untouched when nothing matches', async () => {
    const v = vaultWith('plain')
    expect(await rewriteNote(v.vault, {} as File, () => [])).toBe(0)
    expect(v.get()).toBe('plain')
  })
})
