import type { TFile } from 'obsidian'

import type EaglePlugin from '../main'

import { fileUrlToOsPath } from '../ui/file-url'
import { wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { eagleItemIdFromAlt } from '../utils/eagle-item-id'
import { extractFileExtension } from '../utils/image-format'
import { applyTextReplacements, findMarkdownImageTokens } from '../utils/markdown-image'

interface OldFormatMatch {
  token: ReturnType<typeof findMarkdownImageTokens>[number]
  itemId: string
}

export class ImageMigrationService {
  constructor(private readonly plugin: EaglePlugin) {}

  async migrateAllImages(): Promise<void> {
    const cacheFolderName = this.plugin.settings.cacheFolderName

    // Phase 1: Scan all files for old-format tokens in parallel
    const oldFormatByFile = new Map<string, { file: TFile; content: string; candidates: OldFormatMatch[] }>()
    const itemIds = new Set<string>()

    const fileResults = await Promise.all(
      this.plugin.app.vault.getMarkdownFiles().map(async (file) => {
        const content = await this.plugin.app.vault.read(file)
        const oldCandidates = findMarkdownImageTokens(content)
          .map((token) => ({ token, itemId: eagleItemIdFromAlt(token.alt) }))
          .filter((c): c is OldFormatMatch => c.itemId !== null)
        return { file, content, oldCandidates }
      }),
    )

    for (const { file, content, oldCandidates } of fileResults) {
      if (oldCandidates.length > 0) {
        oldFormatByFile.set(file.path, { file, content, candidates: oldCandidates })
        for (const { itemId } of oldCandidates) itemIds.add(itemId)
      }
    }

    if (oldFormatByFile.size === 0) {
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

    // Phase 4: Update vault files
    let migratedCount = 0

    for (const [, { file, content, candidates }] of oldFormatByFile) {
      const replacements: { start: number; end: number; text: string }[] = []

      for (const { token, itemId } of candidates) {
        const ext = successExt.get(itemId)
        if (!ext) continue
        replacements.push({ start: token.start, end: token.end, text: wikilinkForCacheItem(cacheFolderName, itemId, ext) })
        migratedCount++
      }

      if (replacements.length > 0) {
        await this.plugin.app.vault.modify(file, applyTextReplacements(content, replacements))
      }
    }

    let failureSuffix = ''
    if (failedIds.size > 0) {
      const sample = Array.from(failedIds).slice(0, 3).join(', ')
      const extra = failedIds.size > 3 ? ` and ${failedIds.size - 3} more` : ''
      failureSuffix = ` Failed: ${failedIds.size} (${sample}${extra})`
    }
    this.plugin.notices.show('migrate_done', { count: migratedCount, folder: `${cacheFolderName}/`, failureSuffix })
  }
}
