import type { TFile } from 'obsidian'

import type EaglePlugin from '../main'

import EagleApiError from '../domain/EagleApiError'
import { wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { planCacheSync } from '../utils/cache-sync-plan'
import { countLabel } from '../utils/plural'
import { findEagleWikilinkTokens, type WikilinkEmbedToken } from '../utils/markdown-image'
import { fileUrlToOsPath } from '../ui/file-url'
import { rewriteNote } from '../ui/obsidian-vault'

export class CacheSyncService {
  constructor(private readonly plugin: EaglePlugin) {}

  /**
   * One-time migration: renames existing `{itemId}.{ext}` cache files to
   * `{displayName}_{itemId}.{ext}` and updates all wikilinks in the vault.
   * Requires Eagle to be running — silently skips items it cannot resolve.
   */
  async migrateCacheFilesToReadableNames(): Promise<void> {
    const cacheFolder = this.plugin.cacheManager.cacheFolder
    const adapter = this.plugin.app.vault.adapter

    // Collect all old-format tokens (stem has no underscore before the itemId).
    // New-format tokens already have displayName set, so we skip them.
    const tokensByFile = new Map<string, { file: TFile; tokens: WikilinkEmbedToken[] }>()

    await Promise.all(
      this.plugin.app.vault.getMarkdownFiles().map(async (file) => {
        const content = await this.plugin.app.vault.read(file)
        const oldTokens = findEagleWikilinkTokens(content, cacheFolder).filter((t) => t.displayName === undefined)
        if (oldTokens.length > 0) tokensByFile.set(file.path, { file, tokens: oldTokens })
      }),
    )

    if (tokensByFile.size === 0) return

    // Fetch display names from Eagle for each unique itemId.
    const uniqueIds = new Set<string>()
    for (const { tokens } of tokensByFile.values()) {
      for (const t of tokens) uniqueIds.add(t.itemId)
    }

    const nameMap = new Map<string, string>() // itemId → displayName
    await Promise.allSettled(
      Array.from(uniqueIds).map(async (itemId) => {
        const name = await this.plugin.eagleUploader.getItemName(itemId)
        if (name) nameMap.set(itemId, name)
      }),
    )

    if (nameMap.size === 0) return

    // Rename cache files on disk and collect wikilink replacements.
    const renamedIds = new Set<string>()
    await Promise.allSettled(
      Array.from(nameMap.entries()).map(async ([itemId, displayName]) => {
        // Find which ext this item uses by scanning the tokens we already have.
        let ext: string | undefined
        for (const { tokens } of tokensByFile.values()) {
          const match = tokens.find((t) => t.itemId === itemId)
          if (match) { ext = match.ext; break }
        }
        if (!ext) return

        const oldPath = this.plugin.cacheManager.cachedVaultPath(itemId, ext)
        const newPath = this.plugin.cacheManager.cachedVaultPath(itemId, ext, displayName)
        if (oldPath === newPath) return

        try {
          // Links are rewritten only when the target really exists under its new name.
          if (await adapter.exists(oldPath)) await adapter.rename(oldPath, newPath)
          if (await adapter.exists(newPath)) renamedIds.add(itemId)
        } catch {
          this.plugin.log.warn('cache migration rename failed', { itemId })
        }
      }),
    )

    if (renamedIds.size === 0) return

    // Update wikilinks atomically; tokens are re-read from the content being written.
    await Promise.allSettled(
      Array.from(tokensByFile.values()).map(({ file }) =>
        rewriteNote(this.plugin.app.vault, file, (content) =>
          findEagleWikilinkTokens(content, cacheFolder)
            .filter((t) => t.displayName === undefined && renamedIds.has(t.itemId))
            .map((t) => ({ start: t.start, end: t.end, text: wikilinkForCacheItem(cacheFolder, t.itemId, t.ext, nameMap.get(t.itemId) ?? '', t.alias) })),
        ),
      ),
    )
  }

  private readonly checkedItems = new Set<string>()
  // Note syncs run one at a time so a bulk external sync can't flood the Eagle API.
  private queue: Promise<void> = Promise.resolve()

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err) => this.plugin.log.error('cache sync failed unexpectedly', err))
    return this.queue
  }

  /**
   * Per-note backfill, fed by metadataCache 'changed' and open tabs, so no vault scan runs at launch.
   * Each item is checked once per session; file-open runs the full check via syncCacheForFile.
   */
  syncNoteContent(content: string): Promise<void> {
    return this.enqueue(async () => {
      await this.syncNote(content)
    })
  }

  /** Explicit command: re-checks every note's links, with progress. */
  syncAllNotes(): Promise<void> {
    const { notices } = this.plugin
    return this.enqueue(async () => {
      this.checkedItems.clear()
      const files = this.plugin.app.vault.getMarkdownFiles()
      let cached = 0
      let failed = 0
      notices.show('cache_sync_progress', { step: 'Checking notes for images…' }, { progress: { done: 0, total: files.length } })
      try {
        for (const [i, file] of files.entries()) {
          const result = await this.syncNote(await this.plugin.app.vault.cachedRead(file))
          cached += result.cached
          failed += result.failed
          notices.show('cache_sync_progress', { step: 'Checking notes for images…' }, { progress: { done: i + 1, total: files.length } })
        }
      } finally {
        notices.remove('cache_sync_progress')
      }
      if (cached === 0 && failed === 0) {
        notices.show('cache_sync_current')
        return
      }
      const failureSuffix = failed > 0 ? ` ${countLabel(failed, 'image')} couldn't be fetched. Make sure Eagle is open.` : ''
      notices.show('cache_sync_done', { images: countLabel(cached, 'image'), failureSuffix })
    })
  }

  private async syncNote(content: string): Promise<{ cached: number; failed: number }> {
    const tokens = findEagleWikilinkTokens(content, this.plugin.cacheManager.cacheFolder)
    if (tokens.length === 0) return { cached: 0, failed: 0 }
    const { items, migrate } = planCacheSync(tokens, this.checkedItems, this.plugin.settings.legacyCacheNamesMigrated)
    if (migrate) await this.migrateLegacyNames()

    let cached = 0
    let failed = 0
    await Promise.allSettled(
      items.map(async ({ itemId, ext, displayName }) => {
        try {
          if (await this.plugin.cacheManager.isCached(itemId, ext, displayName)) return
          const fileUrl = await this.plugin.eagleUploader.getFileUrlForItemId(itemId)
          if (!fileUrl.startsWith('file://')) return
          await this.plugin.cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName)
          cached++
        } catch (err) {
          // The item stays checked: an offline Eagle isn't re-queried while the user types; file-open and the command retry.
          failed++
          if (err instanceof EagleApiError) return
          this.plugin.log.error('unexpected error during cache sync', err)
        }
      }),
    )
    return { cached, failed }
  }

  /** Attempted once per vault, when the first note with legacy links shows up; the rewrite re-fires 'changed'. */
  private async migrateLegacyNames(): Promise<void> {
    try {
      await this.migrateCacheFilesToReadableNames()
    } catch (err) {
      this.plugin.log.error('cache filename migration failed', err)
    }
    this.plugin.settings.legacyCacheNamesMigrated = true
    await this.plugin.saveSettings()
  }

  async syncCacheForFile(file: TFile): Promise<void> {
    const content = await this.plugin.app.vault.read(file)
    const tokens = findEagleWikilinkTokens(content, this.plugin.cacheManager.cacheFolder)
    if (tokens.length === 0) return

    const results = await Promise.allSettled(
      tokens.map(async ({ itemId, ext, displayName }) => {
        const isCached = await this.plugin.cacheManager.isCached(itemId, ext, displayName)
        const exists = await this.plugin.eagleUploader.itemExists(itemId)

        if (exists === null) return // Eagle unreachable or error — skip to avoid data loss

        if (exists === false && isCached) {
          // Item confirmed deleted from Eagle — evict from cache
          this.plugin.log.info('evicting deleted item from cache', { itemId, file: file.path })
          await this.plugin.cacheManager.removeCache(itemId, ext, displayName)
        } else if (exists === true && !isCached) {
          // Cache file absent but item exists (cache cleared, synced from another device) — backfill
          try {
            const fileUrl = await this.plugin.eagleUploader.getFileUrlForItemId(itemId)
            if (!fileUrl.startsWith('file://')) {
              this.plugin.log.debug('syncCacheForFile backfill skipped — non-local URL', { itemId })
              return
            }
            await this.plugin.cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName)
          } catch (err) {
            if (err instanceof EagleApiError) {
              this.plugin.log.debug('syncCacheForFile backfill skipped — Eagle API error', { itemId })
              return
            }
            this.plugin.log.warn('syncCacheForFile backfill failed', { itemId })
          }
        }
      }),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        this.plugin.log.error('syncCacheForFile token processing failed', result.reason)
      }
    }
  }
}
