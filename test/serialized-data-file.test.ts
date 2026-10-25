import { describe, expect, it } from 'vitest'

import { SerializedDataFile } from '../src/utils/serialized-data-file'

function slowHost() {
  let disk: Record<string, unknown> = {}
  const tick = () => new Promise((r) => setTimeout(r, 5))
  return {
    host: {
      loadData: async () => { const snapshot = { ...disk }; await tick(); return snapshot },
      saveData: async (d: unknown) => { await tick(); disk = d as Record<string, unknown> },
    },
    read: () => disk,
  }
}

describe('SerializedDataFile', () => {
  it('keeps both keys when two owners save concurrently', async () => {
    const { host, read } = slowHost()
    const file = new SerializedDataFile(host)
    await Promise.all([file.merge(() => ({ settings: 1 })), file.merge(() => ({ hashes: 2 }))])
    expect(read()).toEqual({ settings: 1, hashes: 2 })
  })

  it('keeps writing after a failed save', async () => {
    const { host, read } = slowHost()
    let fail = true
    const file = new SerializedDataFile({ loadData: host.loadData, saveData: (d) => (fail ? Promise.reject(new Error('disk')) : host.saveData(d)) })
    await expect(file.merge(() => ({ a: 1 }))).rejects.toThrow('disk')
    fail = false
    await file.merge(() => ({ b: 2 }))
    expect(read()).toEqual({ b: 2 })
  })
})
