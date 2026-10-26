import { describe, expect, it, vi } from 'vitest'

vi.mock('obsidian', () => ({}))

import { EagleNotFoundError, EagleUnreachableError } from '../src/domain/EagleApiError'
import { CacheSyncService } from '../src/services/cache-sync'
import { cachePathFor } from '../src/utils/eagle-path-contract'

const OLD = cachePathFor('eagle-cache', 'ID', 'png')
const NEW = cachePathFor('eagle-cache', 'ID', 'png', 'Sky')
const LEGACY_LINK = `![[${OLD}]]`

/** In-memory vault: notes by path, cache files on disk. */
function setup(notes: Record<string, string>, opts: { libraryPath?: string; unreadable?: string[] } = {}) {
  const files = new Map(Object.entries(notes).map(([path]) => [path, { path, extension: path.split('.').pop() }]))
  const disk = new Set<string>([OLD])
  const read = (file: { path: string }) => (opts.unreadable?.includes(file.path) ? Promise.reject(new Error('EIO')) : Promise.resolve(notes[file.path] ?? ''))
  const vault = {
    getFileByPath: (path: string) => files.get(path) ?? null,
    getMarkdownFiles: () => [...files.values()].filter((f) => f.extension === 'md'),
    getFiles: () => [...files.values()],
    cachedRead: read,
    read,
    process: (file: { path: string }, fn: (c: string) => string) => Promise.resolve((notes[file.path] = fn(notes[file.path] ?? ''))),
    adapter: {
      exists: (p: string) => Promise.resolve(disk.has(p)),
      rename: (a: string, b: string) => Promise.resolve(void (disk.delete(a), disk.add(b))),
      remove: (p: string) => Promise.resolve(void disk.delete(p)),
    },
  }
  const plugin = {
    app: { vault },
    settings: { cacheLibraryPath: '/lib/A.library' },
    saveSettings: vi.fn().mockResolvedValue(undefined),
    notices: { show: vi.fn(), remove: vi.fn() },
    log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    isUploading: () => false,
    cacheManager: {
      cacheFolder: 'eagle-cache',
      cachedVaultPath: (id: string, ext: string, name?: string) => cachePathFor('eagle-cache', id, ext, name),
      isCached: (id: string, ext: string, name?: string) => Promise.resolve(disk.has(cachePathFor('eagle-cache', id, ext, name))),
      cacheFromOsPath: (id: string, ext: string, _os: string, name?: string) => Promise.resolve(void disk.add(cachePathFor('eagle-cache', id, ext, name))),
      removeCache: (id: string, ext: string, name?: string) => Promise.resolve(void disk.delete(cachePathFor('eagle-cache', id, ext, name))),
    },
    eagleUploader: {
      getItemName: vi.fn().mockResolvedValue('Sky'),
      getFileUrlForItemId: vi.fn().mockResolvedValue('file:///lib/A.library/images/ID.info/Sky.png'),
      getLibraryRootPath: vi.fn().mockResolvedValue(opts.libraryPath ?? '/lib/A.library'),
      itemExists: vi.fn().mockResolvedValue(false),
    },
  }
  const service = new CacheSyncService(plugin as never)
  return { service, plugin, notes, disk, file: (path: string) => files.get(path) as never }
}

describe('eviction', () => {
  it('keeps the cache when another library answers not-found', async () => {
    const { service, disk, file } = setup({ 'a.md': LEGACY_LINK }, { libraryPath: '/lib/B.library' })
    await service.syncNote(file('a.md'), true)
    expect(disk.has(OLD)).toBe(true)
  })

  it('evicts when the cache library confirms the item is gone', async () => {
    const { service, disk, file } = setup({ 'a.md': LEGACY_LINK })
    await service.syncNote(file('a.md'), true)
    expect(disk.has(OLD)).toBe(false)
  })

  it('treats a not-found backfill from another library as a retryable error', async () => {
    const { service, plugin, file } = setup({ 'a.md': `![[${NEW}]]` }, { libraryPath: '/lib/B.library' })
    plugin.eagleUploader.getFileUrlForItemId.mockRejectedValue(new EagleNotFoundError('no such item'))
    await service.syncNote(file('a.md'))
    await service.syncNote(file('a.md'))
    expect(plugin.eagleUploader.getFileUrlForItemId).toHaveBeenCalledTimes(2)
    service.dispose()
  })
})

describe('legacy cache names', () => {
  it('moves the open note to the named file and keeps the old file for other notes', async () => {
    const { service, notes, disk, file } = setup({ 'a.md': `see ${LEGACY_LINK}` })
    await service.syncNote(file('a.md'))
    expect(notes['a.md']).toBe(`see ![[${NEW}]]`)
    expect([disk.has(OLD), disk.has(NEW)]).toEqual([true, true])
  })

  it('moves a later note without asking Eagle again', async () => {
    const { service, plugin, notes, file } = setup({ 'a.md': LEGACY_LINK, 'b.md': `${LEGACY_LINK} twice ${LEGACY_LINK}` })
    await service.syncNote(file('a.md'))
    await service.syncNote(file('b.md'))
    expect(notes['b.md']).toBe(`![[${NEW}]] twice ![[${NEW}]]`)
    expect(plugin.eagleUploader.getItemName).toHaveBeenCalledTimes(1)
  })

  it('leaves the note alone while Eagle is closed', async () => {
    const { service, plugin, notes, file } = setup({ 'a.md': LEGACY_LINK })
    plugin.eagleUploader.getItemName.mockRejectedValue(new EagleUnreachableError('ECONNREFUSED'))
    await service.syncNote(file('a.md'))
    expect(notes['a.md']).toBe(LEGACY_LINK)
    service.dispose()
  })

  it('stops asking about an item the cache library no longer has', async () => {
    const { service, plugin, notes, file } = setup({ 'a.md': LEGACY_LINK })
    plugin.eagleUploader.getItemName.mockResolvedValue(null)
    await service.syncNote(file('a.md'))
    await service.syncNote(file('a.md'))
    expect(notes['a.md']).toBe(LEGACY_LINK)
    expect(plugin.eagleUploader.getItemName).toHaveBeenCalledTimes(1)
  })
})

describe('unload', () => {
  it('runs no queued sync after dispose', async () => {
    const { service, plugin, file } = setup({ 'a.md': `![[${NEW}]]` })
    service.dispose()
    await service.syncNote(file('a.md'))
    expect(plugin.eagleUploader.getFileUrlForItemId).not.toHaveBeenCalled()
  })
})
