import type EaglePlugin from '../main'

import EagleCacheManager from '../ui/EagleCacheManager'
import { safeCacheFolderPath, safePathSegment, wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { applyTextReplacements, findEagleWikilinkTokens } from '../utils/markdown-image'
import { countLabel } from '../utils/plural'

export async function renameCache(plugin: EaglePlugin, oldFolder: string, newFolder: string): Promise<void> {
  // Step 1: Update wikilinks in all markdown files
  let updatedFiles = 0
  let updatedLinks = 0
  const files = plugin.app.vault.getMarkdownFiles()

  await Promise.all(
    files.map(async (file) => {
      const content = await plugin.app.vault.read(file)
      const tokens = findEagleWikilinkTokens(content, oldFolder)
      if (tokens.length === 0) return

      const replacements = tokens.map((t) => ({
        start: t.start,
        end: t.end,
        text: wikilinkForCacheItem(safeCacheFolderPath(newFolder), t.itemId, t.ext, t.displayName, t.alias),
      }))
      await plugin.app.vault.modify(file, applyTextReplacements(content, replacements))
      updatedFiles++
      updatedLinks += replacements.length
    }),
  )

  // Step 2: Move cached files from oldFolder to newFolder (OS-level rename, no I/O)
  const safeNewFolder = safeCacheFolderPath(newFolder)
  plugin.cacheManager = new EagleCacheManager(plugin.app, safeNewFolder)

  let movedFiles = 0
  try {
    const listed = await plugin.app.vault.adapter.list(oldFolder)
    await plugin.cacheManager.ensureCacheFolder()
    await Promise.allSettled(
      listed.files.map(async (srcPath) => {
        const fileName = srcPath.split('/').pop()
        const destPath = `${safeNewFolder}/${safePathSegment(fileName ?? 'image')}`
        try {
          await plugin.app.vault.adapter.rename(srcPath, destPath)
          movedFiles++
        } catch {
          plugin.log.warn('failed to move cache file', { srcPath })
        }
      }),
    )
    // Non-recursive rmdir fails with EISDIR even on empty folders, so verify emptiness and remove recursively.
    const remaining = await plugin.app.vault.adapter.list(oldFolder)
    if (remaining.files.length === 0 && remaining.folders.length === 0) {
      await plugin.app.vault.adapter.rmdir(oldFolder, true).catch(() => plugin.log.warn('failed to remove old cache folder', { oldFolder }))
    }
  } catch {
    // oldFolder doesn't exist or is empty — that's fine
  }

  plugin.notices.show('cache_renamed', {
    newFolder: safeNewFolder,
    links: countLabel(updatedLinks, 'link'),
    files: countLabel(updatedFiles, 'file'),
    moved: countLabel(movedFiles, 'file'),
  })
}
