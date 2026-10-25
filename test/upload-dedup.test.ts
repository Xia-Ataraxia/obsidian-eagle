import { describe, expect, it, vi } from 'vitest'

vi.mock('obsidian', () => {
  class Stub {}
  const names = ['MarkdownView', 'Modal', 'Notice', 'Plugin', 'PluginSettingTab', 'Setting', 'SuggestModal', 'FuzzySuggestModal', 'TFile', 'TFolder', 'Menu', 'Component', 'ButtonComponent']
  return Object.fromEntries(names.map((n) => [n, Stub]))
})

import EagleApiError, { EagleUnreachableError } from '../src/domain/EagleApiError'
import { UploadService } from '../src/services/upload'

type Reuse = (hash: string, existing: { itemId: string; displayName: string }, signal: AbortSignal) => Promise<string | null>

function setup(getFileUrl: () => Promise<string>) {
  const hashStore = { evict: vi.fn(), save: vi.fn().mockResolvedValue(undefined) }
  const plugin = {
    eagleUploader: { getFileUrlForItemId: getFileUrl },
    hashStore,
    notices: { show: vi.fn() },
    cacheManager: { cacheFolder: 'cache', cacheFromOsPath: vi.fn().mockResolvedValue(undefined) },
    log: { warn: vi.fn() },
  }
  const service = new UploadService(plugin as never) as unknown as { reuseExistingItem: Reuse }
  return { hashStore, run: () => service.reuseExistingItem('h', { itemId: 'ID', displayName: 'n' }, new AbortController().signal) }
}

describe('dedup of stale hash entries', () => {
  it('evicts the hash and asks for a re-upload when Eagle no longer has the item', async () => {
    const { hashStore, run } = setup(() => Promise.reject(new EagleApiError('not found')))
    expect(await run()).toBeNull()
    expect(hashStore.evict).toHaveBeenCalledWith('h')
    expect(hashStore.save).toHaveBeenCalled()
  })

  it('evicts when the lookup falls back to an eagle:// url', async () => {
    const { hashStore, run } = setup(() => Promise.resolve('eagle://item/ID'))
    expect(await run()).toBeNull()
    expect(hashStore.evict).toHaveBeenCalledWith('h')
  })

  it('keeps the hash and rethrows when Eagle is unreachable', async () => {
    const { hashStore, run } = setup(() => Promise.reject(new EagleUnreachableError('ECONNREFUSED')))
    await expect(run()).rejects.toBeInstanceOf(EagleUnreachableError)
    expect(hashStore.evict).not.toHaveBeenCalled()
  })
})
