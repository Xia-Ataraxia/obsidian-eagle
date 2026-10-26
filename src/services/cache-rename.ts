import type { DataAdapter, MetadataCache } from 'obsidian'

import type EaglePlugin from '../main'

import EagleCacheManager from '../ui/EagleCacheManager'
import { rewriteNote } from '../ui/obsidian-vault'
import { cachePathFor, safeCacheFolderPath, wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { findEagleWikilinkTokens } from '../utils/markdown-image'
import { countLabel } from '../utils/plural'

function notesLinkingInto(metadataCache: MetadataCache, folder: string): string[] {
  return Object.entries(metadataCache.resolvedLinks)
    .filter(([source, targets]) => source.endsWith('.md') && Object.keys(targets).some((target) => target.startsWith(`${folder}/`)))
    .map(([source]) => source)
}

async function listFilesRecursive(adapter: DataAdapter, folder: string): Promise<string[]> {
  const listed = await adapter.list(folder)
  const nested = await Promise.all(listed.folders.map((sub) => listFilesRecursive(adapter, sub)))
  return [...listed.files, ...nested.flat()]
}

/** Moves every file under `from` into `to`, keeping relative paths. Returns the old paths that really moved. */
async function moveCacheFiles(plugin: EaglePlugin, from: string, to: string): Promise<Set<string>> {
  const { adapter } = plugin.app.vault
  const moved = new Set<string>()
  if (!(await adapter.exists(from))) return moved

  const files = (await listFilesRecursive(adapter, from)).filter((path) => !path.startsWith(`${to}/`))
  if (files.length === 0) return moved

  await plugin.cacheManager.ensureCacheFolder()
  await Promise.all(
    files.map(async (srcPath) => {
      const destPath = `${to}${srcPath.slice(from.length)}`
      try {
        const parent = destPath.slice(0, destPath.lastIndexOf('/'))
        if (!(await adapter.exists(parent))) await adapter.mkdir(parent)
        await adapter.rename(srcPath, destPath)
        moved.add(srcPath)
      } catch {
        plugin.log.warn('failed to move cache file', { srcPath })
      }
    }),
  )

  // Remove the old folder only once nothing is left anywhere inside it.
  if ((await listFilesRecursive(adapter, from)).length === 0) {
    await adapter.rmdir(from, true).catch(() => plugin.log.warn('failed to remove old cache folder', { oldFolder: from }))
  }
  return moved
}

export async function renameCache(plugin: EaglePlugin, oldFolder: string, newFolder: string): Promise<void> {
  const from = safeCacheFolderPath(oldFolder)
  const to = safeCacheFolderPath(newFolder)
  plugin.cacheManager = new EagleCacheManager(plugin.app, to)
  if (from === to) return

  // Obsidian's link index names the notes to rewrite; read before the move, while the links still resolve.
  const linking = notesLinkingInto(plugin.app.metadataCache, from)
  // Files move first; links are rewritten only for files that actually arrived.
  const moved = await moveCacheFiles(plugin, from, to).catch((err: unknown) => {
    plugin.log.warn('cache move failed', { err: err instanceof Error ? err.message : String(err) })
    return new Set<string>()
  })

  let updatedFiles = 0
  let updatedLinks = 0
  if (moved.size > 0) {
    const { vault } = plugin.app
    for (const path of linking) {
      const file = vault.getFileByPath(path)
      if (!file) continue
      const count = await rewriteNote(vault, file, (content) =>
        findEagleWikilinkTokens(content, from)
          .filter((t) => moved.has(cachePathFor(from, t.itemId, t.ext, t.displayName)))
          .map((t) => ({ start: t.start, end: t.end, text: wikilinkForCacheItem(to, t.itemId, t.ext, t.displayName, t.alias) })),
      )
      if (count > 0) {
        updatedFiles++
        updatedLinks += count
      }
    }
  }

  plugin.notices.show('cache_renamed', {
    newFolder: to,
    links: countLabel(updatedLinks, 'link'),
    files: countLabel(updatedFiles, 'file'),
    moved: countLabel(moved.size, 'file'),
  })
}
