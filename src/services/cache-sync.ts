import type { TFile } from 'obsidian'

import type EaglePlugin from '../main'

import EagleApiError from '../domain/EagleApiError'
import { wikilinkForCacheItem } from '../utils/eagle-path-contract'
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

  /** Startup pass: the legacy-name migration is attempted once per vault; afterwards only the cache sync runs. */
  async startupSync(): Promise<void> {
    if (this.plugin.settings.legacyCacheNamesMigrated) return this.lazySyncEagleCache()

    const contents = await this.readAllMarkdown()
    const cacheFolder = this.plugin.cacheManager.cacheFolder
    const hasLegacyNames = contents.some((c) => findEagleWikilinkTokens(c, cacheFolder).some((t) => t.displayName === undefined))
    if (hasLegacyNames) {
      await this.migrateCacheFilesToReadableNames().catch((err) => {
        this.plugin.log.error('cache filename migration failed', err)
      })
    }
    this.plugin.settings.legacyCacheNamesMigrated = true
    await this.plugin.saveSettings()
    // Migration rewrites links, so the sync must re-read afterwards.
    return hasLegacyNames ? this.lazySyncEagleCache() : this.lazySyncEagleCache(contents)
  }

  private readAllMarkdown(): Promise<string[]> {
    return Promise.all(
      this.plugin.app.vault.getMarkdownFiles().map(async (file) => {
        try {
          return await this.plugin.app.vault.read(file)
        } catch {
          this.plugin.log.warn('failed to read file during lazy cache sync', { path: file.path })
          return ''
        }
      }),
    )
  }

  async lazySyncEagleCache(contents?: string[]): Promise<void> {
    const cacheFolder = this.plugin.cacheManager.cacheFolder
    // Phase 1: Collect unique itemId → ext across all vault files in parallel
    const seen = new Map<string, { ext: string; displayName: string | undefined }>() // itemId → {ext, displayName}
    const fileContents = contents ?? await this.readAllMarkdown()
    for (const content of fileContents) {
      for (const token of findEagleWikilinkTokens(content, cacheFolder)) {
        if (!seen.has(token.itemId)) seen.set(token.itemId, { ext: token.ext, displayName: token.displayName })
      }
    }

    // Phase 2: Filter to uncached in parallel — allSettled so one adapter failure doesn't abort the rest
    const entries = Array.from(seen.entries())
    const cachedResults = await Promise.allSettled(
      entries.map(([id, { ext, displayName }]) => this.plugin.cacheManager.isCached(id, ext, displayName)),
    )
    const uncached = entries
      .filter((_, i) => {
        const result = cachedResults[i]
        if (!result || result.status === 'rejected') {
          this.plugin.log.warn('isCached check failed, treating as uncached', { id: entries[i]?.[0] })
          return true // attempt sync anyway
        }
        return !result.value
      })
      .map(([itemId, { ext, displayName }]) => ({ itemId, ext, displayName }))
    if (uncached.length === 0) return

    // Phase 3: Fetch URLs and cache all concurrently
    await Promise.allSettled(
      uncached.map(async ({ itemId, ext, displayName }) => {
        try {
          const fileUrl = await this.plugin.eagleUploader.getFileUrlForItemId(itemId)
          if (!fileUrl.startsWith('file://')) return
          await this.plugin.cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName)
        } catch (err) {
          if (err instanceof EagleApiError) return // Eagle not running or item missing — expected
          this.plugin.log.error('unexpected error during lazy cache sync', err)
        }
      }),
    )
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
