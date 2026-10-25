import type { TFile } from 'obsidian'

import type EaglePlugin from '../main'

import { fileUrlToOsPath } from '../ui/file-url'
import { rewriteNote } from '../ui/obsidian-vault'
import { wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { eagleItemIdFromAlt } from '../utils/eagle-item-id'
import { extractFileExtension } from '../utils/image-format'
import { findMarkdownImageTokens } from '../utils/markdown-image'
import { countLabel } from '../utils/plural'

function findOldFormatTokens(content: string) {
  return findMarkdownImageTokens(content).flatMap((token) => {
    const itemId = eagleItemIdFromAlt(token.alt)
    return itemId === null ? [] : [{ token, itemId }]
  })
}

export class ImageMigrationService {
  constructor(private readonly plugin: EaglePlugin) {}

  async migrateAllImages(): Promise<void> {
    const cacheFolderName = this.plugin.settings.cacheFolderName

    // Phase 1: Find files with old-format tokens
    const filesWithOldFormat: TFile[] = []
    const itemIds = new Set<string>()

    await Promise.all(
      this.plugin.app.vault.getMarkdownFiles().map(async (file) => {
        const content = await this.plugin.app.vault.cachedRead(file)
        const ids = findOldFormatTokens(content).map((c) => c.itemId)
        if (ids.length === 0) return
        filesWithOldFormat.push(file)
        for (const id of ids) itemIds.add(id)
      }),
    )

    if (filesWithOldFormat.length === 0) {
      this.plugin.notices.show('migrate_none')
      return
    }

    // Phase 2: Resolve Eagle API URLs
    const resolvedUrls = new Map<string, string>()
    const failedIds = new Set<string>()

    await Promise.allSettled(
      Array.from(itemIds).map(async (itemId) => {
        try {
          const fileUrl = await this.plugin.eagleUploader.getFileUrlForItemId(itemId)
          if (fileUrl.startsWith('file://')) {
            resolvedUrls.set(itemId, fileUrl)
          } else {
            failedIds.add(itemId)
          }
        } catch {
          this.plugin.log.warn('failed to resolve URL during migration', { itemId })
          failedIds.add(itemId)
        }
      }),
    )

    // Phase 3: Copy image files from Eagle library into the vault cache folder
    const successExt = new Map<string, string>()

    await Promise.allSettled(
      Array.from(resolvedUrls.entries()).map(async ([itemId, fileUrl]) => {
        const ext = extractFileExtension(fileUrl) || 'jpg'
        try {
          await this.plugin.cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl))
          successExt.set(itemId, ext)
        } catch (err) {
          this.plugin.log.error('failed to cache file during migration', err)
          failedIds.add(itemId)
        }
      }),
    )

    // Phase 4: Update vault files atomically, re-reading tokens from the content being written
    let migratedCount = 0
    for (const file of filesWithOldFormat) {
      migratedCount += await rewriteNote(this.plugin.app.vault, file, (content) =>
        findOldFormatTokens(content).flatMap(({ token, itemId }) => {
          const ext = successExt.get(itemId)
          return ext ? [{ start: token.start, end: token.end, text: wikilinkForCacheItem(cacheFolderName, itemId, ext) }] : []
        }),
      )
    }

    let failureSuffix = ''
    if (failedIds.size > 0) {
      const sample = Array.from(failedIds).slice(0, 3).join(', ')
      const extra = failedIds.size > 3 ? ` and ${failedIds.size - 3} more` : ''
      failureSuffix = ` Failed: ${failedIds.size} (${sample}${extra})`
    }
    this.plugin.notices.show('migrate_done', { images: countLabel(migratedCount, 'image'), folder: `${cacheFolderName}/`, failureSuffix })
  }
}
