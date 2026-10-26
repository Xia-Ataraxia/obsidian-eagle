import { describe, expect, it, vi } from 'vitest'

vi.mock('obsidian', () => ({}))

import { EagleNotFoundError } from '../src/domain/EagleApiError'
import { CacheSyncService } from '../src/services/cache-sync'
import { cachePathFor } from '../src/utils/eagle-path-contract'

const OLD = cachePathFor('eagle-cache', 'ID', 'png')
const NEW = cachePathFor('eagle-cache', 'ID', 'png', 'Sky')
const LEGACY_LINK = `![[${OLD}]]`

/** In-memory vault: notes and canvases by path, cache files on disk. */
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
    settings: { legacyCacheNamesMigrated: false, cacheLibraryPath: '/lib/A.library' },
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

describe('legacy migration command', () => {
  it('rewrites a note that gained a legacy link during the run before the old file goes', async () => {
    const { service, plugin, notes, disk } = setup({ 'a.md': LEGACY_LINK, 'b.md': 'draft' })
    plugin.eagleUploader.getItemName.mockImplementation(() => {
      notes['b.md'] = `draft ${LEGACY_LINK}`
      service.noteChanged('b.md')
      return Promise.resolve('Sky')
    })
    await service.syncAllNotes()
    expect(notes['b.md']).toBe(`draft ![[${NEW}]]`)
    expect([disk.has(OLD), disk.has(NEW)]).toEqual([false, true])
    expect(plugin.settings.legacyCacheNamesMigrated).toBe(true)
  })

  it('rewrites readable notes but keeps every old file when a note cannot be read', async () => {
    const { service, plugin, notes, disk } = setup({ 'a.md': LEGACY_LINK, 'b.md': LEGACY_LINK }, { unreadable: ['b.md'] })
    await service.syncAllNotes()
    expect(notes['a.md']).toBe(`![[${NEW}]]`)
    expect([disk.has(OLD), disk.has(NEW)]).toEqual([true, true])
    expect(plugin.settings.legacyCacheNamesMigrated).toBe(false)
  })

  it('keeps the old file beside the new copy for an item a canvas references', async () => {
    const { service, plugin, notes, disk } = setup({ 'a.md': LEGACY_LINK, 'board.canvas': `{"nodes":[{"file":"${OLD}"}]}` })
    await service.syncAllNotes()
    expect(notes['a.md']).toBe(`![[${NEW}]]`)
    expect(notes['board.canvas']).toContain(OLD)
    expect([disk.has(OLD), disk.has(NEW)]).toEqual([true, true])
    expect(plugin.settings.legacyCacheNamesMigrated).toBe(false)
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
