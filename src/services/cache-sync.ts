import type { TFile } from 'obsidian'

import type EaglePlugin from '../main'

import { wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { legacyMigrationComplete, marksChecked, outcomeForError, planCacheSync, shouldReportProgress, type ItemOutcome } from '../utils/cache-sync-plan'
import { countLabel } from '../utils/plural'
import { findEagleWikilinkTokens, type WikilinkEmbedToken } from '../utils/markdown-image'
import { fileUrlToOsPath } from '../ui/file-url'
import { rewriteNote } from '../ui/obsidian-vault'

const UNREACHABLE_BACKOFF_MS = 30_000

interface Tally {
  /** Latest outcome per item, so an item linked from many notes counts once. */
  outcomes: Map<string, ItemOutcome>
  /** Outcomes of legacy links Eagle gave no name for; decides whether the vault counts as migrated. */
  legacy: ItemOutcome[]
  /** Links to renamed items that couldn't be rewritten. */
  linkFailures: number
  unreadable: number
}

interface LegacyNote {
  file: TFile
  /** Item id per legacy link in the note, repeats included, so failures count links. */
  itemIds: string[]
}

const newTally = (): Tally => ({ outcomes: new Map(), legacy: [], linkFailures: 0, unreadable: 0 })

/**
 * Passive syncs (open notes, file-open, edits) only backfill the note at hand, under the filenames its
 * links already use. Renaming legacy cache files rewrites other notes, so only the explicit command does it.
 */
export class CacheSyncService {
  constructor(private readonly plugin: EaglePlugin) {}

  private readonly checkedItems = new Set<string>()
  // Items Eagle confirmed this session; later deletions in Eagle are noticed after a restart or the command.
  private readonly confirmedItems = new Set<string>()
  // Note syncs run one at a time so a bulk external sync can't flood the Eagle API.
  private queue: Promise<void> = Promise.resolve()
  // While Eagle is down, syncs make no API calls until this passes, so typing stays free.
  private eagleUnreachableUntil = 0
  // Content this plugin last wrote per note, so its own rewrite doesn't trigger a sync.
  private readonly ownWrites = new Map<string, string>()

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err) => this.plugin.log.error('cache sync failed unexpectedly', err))
    return this.queue
  }

  private isBackingOff(): boolean {
    return Date.now() < this.eagleUnreachableUntil
  }

  /** True once for the change event carrying content this plugin wrote. */
  isOwnWrite(path: string, content: string): boolean {
    if (this.ownWrites.get(path) !== content) return false
    this.ownWrites.delete(path)
    return true
  }

  /** Backfills one note from its current content; `evict` also drops cache files of items deleted from Eagle. */
  syncNote(file: TFile, evict = false): Promise<void> {
    return this.enqueue(async () => {
      const { vault } = this.plugin.app
      if (vault.getFileByPath(file.path) !== file) return
      const content = await vault.cachedRead(file)
      const { items } = this.plan(content, false)
      await this.backfillAll(items, newTally())
      if (evict && !this.isBackingOff()) await this.evictDeleted(file, content)
    })
  }

  /** Explicit command: re-checks every note's links and renames legacy cache files vault-wide, with progress. */
  syncAllNotes(): Promise<void> {
    const { notices, log } = this.plugin
    // A fresh session starts at invocation, so syncs already queued behind the command re-check too.
    this.checkedItems.clear()
    this.confirmedItems.clear()
    this.eagleUnreachableUntil = 0
    return this.enqueue(async () => {
      const renameLegacy = !this.plugin.settings.legacyCacheNamesMigrated
      const files = this.plugin.app.vault.getMarkdownFiles()
      const tally = newTally()
      const legacyNotes: LegacyNote[] = []
      const legacyItems = new Map<string, WikilinkEmbedToken>()
      let lastReportAt = 0
      const report = (step: string, done: number, total: number) => notices.show('cache_sync_progress', { step }, { progress: { done, total } })
      report('Checking notes for images…', 0, files.length)
      try {
        for (const [i, file] of files.entries()) {
          try {
            const tokens = findEagleWikilinkTokens(await this.plugin.app.vault.cachedRead(file), this.plugin.cacheManager.cacheFolder)
            const { items, legacy } = planCacheSync(tokens, this.checkedItems, renameLegacy)
            if (legacy.length > 0) {
              for (const token of legacy) legacyItems.set(token.itemId, token)
              legacyNotes.push({ file, itemIds: tokens.filter((t) => t.displayName === undefined).map((t) => t.itemId) })
            }
            await this.backfillAll(items, tally)
          } catch (err) {
            tally.unreadable++
            log.warn('cache sync skipped a note', { path: file.path, err })
          }
          const now = Date.now()
          if (shouldReportProgress(i + 1, files.length, lastReportAt, now)) {
            report('Checking notes for images…', i + 1, files.length)
            lastReportAt = now
          }
        }
        if (legacyItems.size > 0) {
          report('Renaming cached images…', 0, legacyItems.size)
          await this.renameLegacy(legacyItems, legacyNotes, tally)
        }
        if (renameLegacy && tally.unreadable === 0 && legacyMigrationComplete(tally.legacy, tally.linkFailures)) {
          this.plugin.settings.legacyCacheNamesMigrated = true
          await this.plugin.saveSettings()
        }
      } finally {
        notices.remove('cache_sync_progress')
        this.showSummary(tally)
      }
    })
  }

  private showSummary({ outcomes, linkFailures, unreadable }: Tally): void {
    const counts = { cached: 0, unreachable: 0, failed: 0 }
    for (const outcome of outcomes.values()) if (outcome in counts) counts[outcome as keyof typeof counts]++
    const failures = [
      counts.unreachable > 0 ? `${countLabel(counts.unreachable, 'image')} couldn't be fetched. Make sure Eagle is open.` : '',
      counts.failed > 0 ? `${countLabel(counts.failed, 'image')} couldn't be copied.` : '',
      linkFailures > 0 ? `${countLabel(linkFailures, 'link')} couldn't be updated.` : '',
      unreadable > 0 ? `${countLabel(unreadable, 'note')} couldn't be read.` : '',
    ].filter(Boolean)
    if (counts.cached === 0 && failures.length === 0) {
      this.plugin.notices.show('cache_sync_current')
      return
    }
    this.plugin.notices.show('cache_sync_done', { images: countLabel(counts.cached, 'image'), failureSuffix: failures.map((f) => ` ${f}`).join('') })
  }

  private settle(itemId: string, outcome: ItemOutcome, tally: Tally): void {
    tally.outcomes.set(itemId, outcome)
    if (marksChecked(outcome)) this.checkedItems.add(itemId)
  }

  /** Only a real failed call starts the window; skips during it don't extend it. */
  private classify(err: unknown): ItemOutcome {
    const outcome = outcomeForError(err)
    if (outcome === 'unreachable') this.eagleUnreachableUntil = Date.now() + UNREACHABLE_BACKOFF_MS
    return outcome
  }

  private plan(content: string, renameLegacy: boolean) {
    const tokens = findEagleWikilinkTokens(content, this.plugin.cacheManager.cacheFolder)
    return planCacheSync(tokens, this.checkedItems, renameLegacy)
  }

  private async backfillAll(items: WikilinkEmbedToken[], tally: Tally): Promise<void> {
    await Promise.all(items.map(async (token) => this.settle(token.itemId, await this.backfill(token), tally)))
  }

  private async backfill({ itemId, ext, displayName }: WikilinkEmbedToken): Promise<ItemOutcome> {
    const { cacheManager, eagleUploader } = this.plugin
    try {
      if (await cacheManager.isCached(itemId, ext, displayName)) return 'present'
      if (this.plugin.isUploading(itemId)) return 'uploading'
      if (this.isBackingOff()) return 'unreachable'
      const fileUrl = await eagleUploader.getFileUrlForItemId(itemId)
      if (!fileUrl.startsWith('file://')) return 'skipped'
      await cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName)
      return 'cached'
    } catch (err) {
      const outcome = this.classify(err)
      if (outcome === 'failed') this.plugin.log.error('unexpected error during cache sync', err)
      return outcome
    }
  }

  /**
   * Renames `{itemId}.{ext}` cache files to `{displayName}_{itemId}.{ext}`. Links are rewritten first;
   * a file is moved only once every note linking it was rewritten, so a failed rewrite never dangles.
   */
  private async renameLegacy(legacyItems: Map<string, WikilinkEmbedToken>, notes: LegacyNote[], tally: Tally): Promise<void> {
    const { app, cacheManager, eagleUploader, log, notices } = this.plugin
    const names = new Map<string, string>()
    let done = 0
    for (const itemId of legacyItems.keys()) {
      let outcome: ItemOutcome | undefined
      try {
        const name = this.isBackingOff() ? undefined : await eagleUploader.getItemName(itemId)
        if (name) names.set(itemId, name)
        else outcome = name === null ? 'missing' : 'unreachable'
      } catch (err) {
        outcome = this.classify(err)
        if (outcome === 'failed') log.warn('cache migration name lookup failed', { itemId, err })
      }
      if (outcome) {
        tally.legacy.push(outcome)
        this.settle(itemId, outcome, tally)
      }
      notices.show('cache_sync_progress', { step: 'Renaming cached images…' }, { progress: { done: ++done, total: legacyItems.size } })
    }
    if (names.size === 0) return

    const cacheFolder = cacheManager.cacheFolder
    const unrewritten = new Set<string>()
    for (const { file, itemIds } of notes) {
      const renamed = itemIds.filter((id) => names.has(id))
      if (renamed.length === 0) continue
      try {
        await rewriteNote(
          app.vault,
          file,
          (content) =>
            findEagleWikilinkTokens(content, cacheFolder)
              .filter((t) => t.displayName === undefined && names.has(t.itemId))
              .map((t) => ({ start: t.start, end: t.end, text: wikilinkForCacheItem(cacheFolder, t.itemId, t.ext, names.get(t.itemId) ?? '', t.alias) })),
          (written) => this.ownWrites.set(file.path, written),
        )
      } catch (err) {
        log.error('cache migration link rewrite failed', { path: file.path, err })
        tally.linkFailures += renamed.length
        for (const id of renamed) unrewritten.add(id)
      }
    }

    const { adapter } = app.vault
    for (const token of legacyItems.values()) {
      const { itemId, ext } = token
      const name = names.get(itemId)
      if (!name) continue
      const oldPath = cacheManager.cachedVaultPath(itemId, ext)
      const newPath = cacheManager.cachedVaultPath(itemId, ext, name)
      try {
        // A note still linking the old name keeps its file; the backfill copies one under the new name.
        if (!unrewritten.has(itemId) && (await adapter.exists(oldPath))) {
          if (await adapter.exists(newPath)) await adapter.remove(oldPath)
          else await adapter.rename(oldPath, newPath)
        }
      } catch (err) {
        log.warn('cache migration rename failed', { itemId, err })
      }
      // A note already linking the new name settled the item in the first pass.
      if (!this.checkedItems.has(itemId)) this.settle(itemId, await this.backfill({ ...token, displayName: name }), tally)
    }
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
          else if (exists === false && (await cacheManager.isCached(itemId, ext, displayName))) {
            log.info('evicting deleted item from cache', { itemId, file: file.path })
            await cacheManager.removeCache(itemId, ext, displayName)
          }
        } catch (err) {
          if (this.classify(err) === 'failed') log.warn('cache eviction check failed', { itemId, err })
        }
      }),
    )
  }
}
