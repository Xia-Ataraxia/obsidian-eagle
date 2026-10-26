import type { TFile } from 'obsidian'

import type EaglePlugin from '../main'

import { wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { contentFingerprint, isSameLibrary, marksChecked, outcomeForError, planCacheSync, retryPlan, type ItemOutcome } from '../utils/cache-sync-plan'
import { findEagleWikilinkTokens, type WikilinkEmbedToken } from '../utils/markdown-image'
import { fileUrlToOsPath } from '../ui/file-url'
import { rewriteNote } from '../ui/obsidian-vault'

const UNREACHABLE_BACKOFF_MS = 30_000

/** Latest outcome per item, so an item linked twice counts once. */
type Outcomes = Map<string, ItemOutcome>

/**
 * Syncs only the note at hand (open notes, file-open, edits): backfills its cache files and moves its
 * legacy `{itemId}.{ext}` links to `{displayName}_{itemId}.{ext}`. It never reads other notes.
 */
export class CacheSyncService {
  constructor(private readonly plugin: EaglePlugin) {}

  private readonly checkedItems = new Set<string>()
  // Display names of legacy items per session; null once Eagle settled that the item can't be renamed.
  private readonly legacyNames = new Map<string, string | null>()
  // Items Eagle confirmed this session; later deletions in Eagle are noticed after a restart or the command.
  private readonly confirmedItems = new Set<string>()
  // Note syncs run one at a time so a bulk external sync can't flood the Eagle API.
  private queue: Promise<void> = Promise.resolve()
  // While Eagle is down, syncs make no API calls until this passes, so typing stays free.
  private eagleUnreachableUntil = 0
  // Notes with items that couldn't settle, synced again when due; one timer serves them all.
  private readonly deferred = new Map<string, { evict: boolean; dueAt: number }>()
  private retryTimer: number | null = null
  // Fingerprint of what this plugin last wrote per note, so its own rewrite doesn't trigger a sync.
  private readonly ownWrites = new Map<string, string>()
  // Whether the open Eagle library is the one the cache came from; asked once per connection.
  private library: Promise<boolean> | null = null
  private unloaded = false

  /** Registered with the plugin lifecycle; after it, queued work and timers never touch Eagle or the vault. */
  dispose(): void {
    this.unloaded = true
    this.deferred.clear()
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue
      .then(() => (this.unloaded ? undefined : task()))
      .catch((err) => this.plugin.log.error('cache sync failed unexpectedly', err))
    return this.queue
  }

  private isBackingOff(): boolean {
    return Date.now() < this.eagleUnreachableUntil
  }

  /** True once for the change event carrying content this plugin wrote. */
  isOwnWrite(path: string, content: string): boolean {
    const written = this.ownWrites.get(path)
    if (written === undefined || written !== contentFingerprint(content)) return false
    this.ownWrites.delete(path)
    return true
  }

  /** Records the open library as the cache's library the first time something is cached into it. */
  async rememberLibrary(): Promise<void> {
    const { settings, eagleUploader } = this.plugin
    if (settings.cacheLibraryPath) return
    const path = await eagleUploader.getLibraryRootPath().catch(() => null)
    if (!path || settings.cacheLibraryPath || this.unloaded) return
    settings.cacheLibraryPath = path
    this.library = null
    await this.plugin.saveSettings()
  }

  private sameLibrary(): Promise<boolean> {
    this.library ??= this.plugin.eagleUploader.getLibraryRootPath().then(
      (path) => isSameLibrary(this.plugin.settings.cacheLibraryPath, path),
      () => {
        this.library = null
        return false
      },
    )
    return this.library
  }

  /** Eagle answers not-found for every id while another library is open, so only the cache's own library may say missing. */
  private async confirmMissing(): Promise<ItemOutcome> {
    return (await this.sameLibrary()) ? 'missing' : 'error'
  }

  /** Backfills one note from its current content; `evict` also drops cache files of items deleted from Eagle. */
  syncNote(file: TFile, evict = false, isRetry = false): Promise<void> {
    return this.enqueue(async () => {
      const { vault } = this.plugin.app
      if (vault.getFileByPath(file.path) !== file) return
      const content = await vault.cachedRead(file)
      if (this.unloaded) return
      const { items, legacy } = planCacheSync(findEagleWikilinkTokens(content, this.plugin.cacheManager.cacheFolder), this.checkedItems)
      const tally: Outcomes = new Map()
      await this.backfillAll(items, tally)
      if (legacy.length > 0) await this.renameLegacy(file, legacy, tally)
      const outcomes = [...tally.values()]
      if (evict && this.isBackingOff()) outcomes.push('unreachable')
      else if (evict) await this.evictDeleted(file, content)
      const retry = retryPlan(outcomes, this.eagleUnreachableUntil - Date.now())
      if (retry && (!isRetry || retry.repeat)) this.deferRetry(file.path, evict, retry.delayMs)
    })
  }

  private deferRetry(path: string, evict: boolean, delayMs: number): void {
    const prev = this.deferred.get(path)
    const dueAt = Date.now() + delayMs
    this.deferred.set(path, { evict: evict || (prev?.evict ?? false), dueAt: prev ? Math.min(prev.dueAt, dueAt) : dueAt })
    this.scheduleRetry()
  }

  // ponytail: main-window timer rather than activeWindow, so closing a popout never drops pending retries.
  private scheduleRetry(): void {
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.unloaded || this.deferred.size === 0) return
    const next = Math.min(...[...this.deferred.values()].map((d) => d.dueAt))
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      const now = Date.now()
      for (const [path, { evict, dueAt }] of this.deferred) {
        if (dueAt > now) continue
        this.deferred.delete(path)
        const file = this.plugin.app.vault.getFileByPath(path)
        if (file) void this.syncNote(file, evict, true)
      }
      this.scheduleRetry()
    }, Math.max(0, next - Date.now()))
  }

  private settle(itemId: string, outcome: ItemOutcome, tally: Outcomes): void {
    tally.set(itemId, outcome)
    if (marksChecked(outcome)) this.checkedItems.add(itemId)
  }

  /** Only a real failed call starts the window; skips during it don't extend it. */
  private async classify(err: unknown): Promise<ItemOutcome> {
    const outcome = outcomeForError(err)
    if (outcome === 'unreachable') {
      this.eagleUnreachableUntil = Date.now() + UNREACHABLE_BACKOFF_MS
      // The user may switch libraries while Eagle is away.
      this.library = null
    }
    return outcome === 'missing' ? this.confirmMissing() : outcome
  }

  private async backfillAll(items: WikilinkEmbedToken[], tally: Outcomes): Promise<void> {
    await Promise.all(items.map(async (token) => this.settle(token.itemId, await this.backfill(token), tally)))
  }

  private async backfill({ itemId, ext, displayName }: WikilinkEmbedToken): Promise<ItemOutcome> {
    const { cacheManager, eagleUploader } = this.plugin
    try {
      if (await cacheManager.isCached(itemId, ext, displayName)) return 'present'
      if (this.plugin.isUploading(itemId)) return 'uploading'
      if (this.isBackingOff() || this.unloaded) return 'unreachable'
      const fileUrl = await eagleUploader.getFileUrlForItemId(itemId)
      if (!fileUrl.startsWith('file://')) return 'skipped'
      await cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName)
      void this.rememberLibrary()
      return 'cached'
    } catch (err) {
      const outcome = await this.classify(err)
      if (outcome === 'failed') this.plugin.log.error('unexpected error during cache sync', err)
      return outcome
    }
  }

  /**
   * Copies each legacy item's cache file to `{displayName}_{itemId}.{ext}` and points this note's links at it.
   * The old file stays: other notes or canvases may still link it, and finding them would mean reading the vault.
   */
  // ponytail: old-name files are never removed, so a fully migrated vault keeps duplicates; remove them if disk use matters.
  private async renameLegacy(file: TFile, legacy: WikilinkEmbedToken[], tally: Outcomes): Promise<void> {
    const { app, cacheManager, log } = this.plugin
    const names = new Map<string, string>()
    await Promise.all(
      legacy.map(async (token) => {
        const name = await this.legacyName(token, tally)
        if (name) names.set(token.itemId, name)
      }),
    )
    if (names.size === 0 || this.unloaded) return
    const cacheFolder = cacheManager.cacheFolder
    try {
      await rewriteNote(
        app.vault,
        file,
        (content) =>
          findEagleWikilinkTokens(content, cacheFolder)
            .filter((t) => t.displayName === undefined && names.has(t.itemId))
            .map((t) => ({ start: t.start, end: t.end, text: wikilinkForCacheItem(cacheFolder, t.itemId, t.ext, names.get(t.itemId) ?? '', t.alias) })),
        (written) => this.ownWrites.set(file.path, contentFingerprint(written)),
      )
    } catch (err) {
      log.warn('cache link rename failed', { path: file.path, err })
    }
  }

  /** The item's display name once its new-name file is on disk; otherwise settles why not and returns null. */
  private async legacyName(token: WikilinkEmbedToken, tally: Outcomes): Promise<string | null> {
    const { itemId } = token
    let name = this.legacyNames.get(itemId)
    if (name === null) return null
    if (name === undefined) {
      if (this.isBackingOff() || this.unloaded) {
        this.settle(itemId, 'unreachable', tally)
        return null
      }
      try {
        name = await this.plugin.eagleUploader.getItemName(itemId)
      } catch (err) {
        const outcome = await this.classify(err)
        if (outcome === 'failed') this.plugin.log.warn('cache name lookup failed', { itemId, err })
        this.settle(itemId, outcome, tally)
        return null
      }
      if (!name) {
        const outcome = await this.confirmMissing()
        if (marksChecked(outcome)) this.legacyNames.set(itemId, null)
        this.settle(itemId, outcome, tally)
        return null
      }
    }
    const outcome = await this.backfill({ ...token, displayName: name })
    this.settle(itemId, outcome, tally)
    if (outcome === 'present' || outcome === 'cached') {
      this.legacyNames.set(itemId, name)
      return name
    }
    if (marksChecked(outcome)) this.legacyNames.set(itemId, null)
    return null
  }

  private async evictDeleted(file: TFile, content: string): Promise<void> {
    const { cacheManager, eagleUploader, log } = this.plugin
    const tokens = findEagleWikilinkTokens(content, cacheManager.cacheFolder).filter((t) => !this.confirmedItems.has(t.itemId))
    await Promise.all(
      tokens.map(async ({ itemId, ext, displayName }) => {
        if (this.isBackingOff()) return
        try {
          const exists = await eagleUploader.itemExists(itemId)
          if (exists) this.confirmedItems.add(itemId)
          else if (exists === false && (await this.sameLibrary()) && (await cacheManager.isCached(itemId, ext, displayName))) {
            log.info('evicting deleted item from cache', { itemId, file: file.path })
            await cacheManager.removeCache(itemId, ext, displayName)
          }
        } catch (err) {
          if ((await this.classify(err)) === 'failed') log.warn('cache eviction check failed', { itemId, err })
        }
      }),
    )
  }
}
