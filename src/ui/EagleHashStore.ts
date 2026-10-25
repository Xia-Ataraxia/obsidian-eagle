import { HASH_STORE_KEY as STORE_KEY } from '../domain/settings'

import { PluginLogger } from '../utils/plugin-logger'

interface HashEntry {
  itemId: string
  displayName: string
  libraryPath: string
  uploadedAt: number
}

interface EagleHashStoreData {
  version: number
  entries: Record<string, HashEntry>
}

const STORE_VERSION = 1

export default class EagleHashStore {
  private readonly log = new PluginLogger('Eagle')
  private data: EagleHashStoreData = { version: STORE_VERSION, entries: {} }

  lookup(hash: string, libraryPath: string): { itemId: string; displayName: string } | null {
    const entry = this.data.entries[hash]
    if (!entry) return null
    if (entry.libraryPath !== libraryPath) return null
    return { itemId: entry.itemId, displayName: entry.displayName ?? '' }
  }

  store(hash: string, itemId: string, displayName: string, libraryPath: string): void {
    this.data.entries[hash] = { itemId, displayName, libraryPath, uploadedAt: Date.now() }
  }

  evict(hash: string): void {
    delete this.data.entries[hash]
  }

  pruneOldEntries(maxAgeDays = 90): void {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    for (const [hash, entry] of Object.entries(this.data.entries)) {
      if (entry.uploadedAt < cutoff) {
        delete this.data.entries[hash]
      }
    }
  }

  load(raw: Record<string, unknown> | null): void {
    try {
      if (raw && typeof raw === 'object' && STORE_KEY in raw) {
        const stored = raw[STORE_KEY] as EagleHashStoreData
        if (stored?.version === STORE_VERSION && stored.entries) {
          this.data = stored
        }
      }
    } catch (err) {
       
      this.log.warn('failed to load hash store', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  async save(owner: { mergeData(patch: () => Record<string, unknown>): Promise<void> }): Promise<void> {
    try {
      await owner.mergeData(() => ({ [STORE_KEY]: this.data }))
    } catch (err) {
       
      this.log.warn('failed to save hash store', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  static async computeHash(buffer: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const bytes = new Uint8Array(hashBuffer)
    let hex = ''
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
    return hex
  }
}
