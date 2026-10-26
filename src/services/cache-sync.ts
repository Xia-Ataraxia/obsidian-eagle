import type { TFile } from 'obsidian'

import type EaglePlugin from '../main'

import EagleApiError from '../domain/EagleApiError'
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
  /** Outcomes of legacy links left as they were; decides whether the vault counts as migrated. */
  legacy: ItemOutcome[]
}

const newTally = (): Tally => ({ outcomes: new Map(), legacy: [] })

export class CacheSyncService {
  constructor(private readonly plugin: EaglePlugin) {}

  private readonly checkedItems = new Set<string>()
  // Note syncs run one at a time so a bulk external sync can't flood the Eagle API.
  private queue: Promise<void> = Promise.resolve()
  // While Eagle is down, syncs make no API calls until this passes, so typing stays free.
  private eagleUnreachableUntil = 0

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err) => this.plugin.log.error('cache sync failed unexpectedly', err))
    return this.queue
  }

  private isBackingOff(): boolean {
    return Date.now() < this.eagleUnreachableUntil
  }

  /** Backfills one open note's cache links; `content` skips the read when the caller already has it. */
  syncNote(file: TFile, content?: string): Promise<void> {
    return this.enqueue(async () => {
      await this.syncNoteNow(file, content ?? (await this.plugin.app.vault.cachedRead(file)), newTally())
    })
  }

  /** file-open: backfill like any open note, then evict items deleted from Eagle. */
  syncOpenedFile(file: TFile): Promise<void> {
    return this.enqueue(async () => {
      await this.syncNoteNow(file, await this.plugin.app.vault.read(file), newTally())
      if (!this.isBackingOff()) await this.syncCacheForFile(file)
    })
  }

  /** Explicit command: re-checks every note's links and finishes the vault-wide legacy rename, with progress. */
  syncAllNotes(): Promise<void> {
    const { notices, log } = this.plugin
    // A fresh session starts at invocation, so syncs already queued behind the command re-check too.
    this.checkedItems.clear()
    this.eagleUnreachableUntil = 0
    return this.enqueue(async () => {
      const files = this.plugin.app.vault.getMarkdownFiles()
      const tally = newTally()
      let unreadable = 0
      let lastReportAt = 0
      const report = (done: number) => notices.show('cache_sync_progress', { step: 'Checking notes for images…' }, { progress: { done, total: files.length } })
      report(0)
      try {
        for (const [i, file] of files.entries()) {
          try {
            await this.syncNoteNow(file, await this.plugin.app.vault.cachedRead(file), tally)
          } catch (err) {
            unreadable++
            log.warn('cache sync skipped a note', { path: file.path, err })
          }
          const now = Date.now()
          if (shouldReportProgress(i + 1, files.length, lastReportAt, now)) {
            report(i + 1)
            lastReportAt = now
          }
        }
        if (!this.plugin.settings.legacyCacheNamesMigrated && unreadable === 0 && legacyMigrationComplete(tally.legacy)) {
          this.plugin.settings.legacyCacheNamesMigrated = true
          await this.plugin.saveSettings()
        }
      } finally {
        notices.remove('cache_sync_progress')
        this.showSummary(tally, unreadable)
      }
    })
  }

  private showSummary({ outcomes }: Tally, unreadable: number): void {
    const counts = { cached: 0, unreachable: 0, failed: 0 }
    for (const outcome of outcomes.values()) if (outcome in counts) counts[outcome as keyof typeof counts]++
    const failures = [
      counts.unreachable > 0 ? `${countLabel(counts.unreachable, 'image')} couldn't be fetched. Make sure Eagle is open.` : '',
      counts.failed > 0 ? `${countLabel(counts.failed, 'image')} couldn't be copied.` : '',
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

  private plan(content: string) {
    const tokens = findEagleWikilinkTokens(content, this.plugin.cacheManager.cacheFolder)
    return planCacheSync(tokens, this.checkedItems, this.plugin.settings.legacyCacheNamesMigrated)
  }

  private async syncNoteNow(file: TFile, content: string, tally: Tally): Promise<void> {
    let { items, legacy } = this.plan(content)
    if (legacy.length > 0) {
      const leftInPlace = this.isBackingOff()
        ? new Map(legacy.map((t): [string, ItemOutcome] => [t.itemId, 'unreachable']))
        : await this.renameLegacyLinks(file, legacy)
      for (const [itemId, outcome] of leftInPlace) {
        tally.legacy.push(outcome)
        this.settle(itemId, outcome, tally)
      }
      // Renamed links are named now; re-plan from the rewritten note so they get backfilled too.
      if (leftInPlace.size < legacy.length) items = this.plan(await this.plugin.app.vault.read(file)).items
    }

    await Promise.all(items.map(async (token) => this.settle(token.itemId, await this.backfill(token), tally)))
  }

  private async backfill({ itemId, ext, displayName }: WikilinkEmbedToken): Promise<ItemOutcome> {
    const { cacheManager, eagleUploader } = this.plugin
    try {
      if (await cacheManager.isCached(itemId, ext, displayName)) return 'present'
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
   * Renames this note's `{itemId}.{ext}` cache files to `{displayName}_{itemId}.{ext}` and rewrites
   * the links in every note embedding them. Returns the outcome of each link left as it was.
   */
  private async renameLegacyLinks(file: TFile, legacy: WikilinkEmbedToken[]): Promise<Map<string, ItemOutcome>> {
    const { app, cacheManager, eagleUploader, log } = this.plugin
    const leftInPlace = new Map<string, ItemOutcome>()
    const names = new Map<string, string>()
    const notes = new Set([file.path])

    await Promise.all(
      legacy.map(async ({ itemId, ext }) => {
        try {
          const name = await eagleUploader.getItemName(itemId)
          if (!name) {
            leftInPlace.set(itemId, 'missing')
            return
          }
          const oldPath = cacheManager.cachedVaultPath(itemId, ext)
          // Other notes embedding the same file come from the link index, not a vault read.
          for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
            if (oldPath in targets) notes.add(source)
          }
          const newPath = cacheManager.cachedVaultPath(itemId, ext, name)
          const { adapter } = app.vault
          // The link is renamed even with no file to move; the backfill then fetches it under the new name.
          if (!(await adapter.exists(newPath)) && (await adapter.exists(oldPath))) await adapter.rename(oldPath, newPath)
          names.set(itemId, name)
        } catch (err) {
          const outcome = this.classify(err)
          if (outcome === 'failed') log.warn('cache migration rename failed', { itemId, err })
          leftInPlace.set(itemId, outcome)
        }
      }),
    )
    if (names.size === 0) return leftInPlace

    const cacheFolder = cacheManager.cacheFolder
    const results = await Promise.allSettled(
      Array.from(notes, (path) => app.vault.getFileByPath(path)).map(async (note) => {
        if (!note) return
        await rewriteNote(app.vault, note, (content) =>
          findEagleWikilinkTokens(content, cacheFolder)
            .filter((t) => t.displayName === undefined && names.has(t.itemId))
            .map((t) => ({ start: t.start, end: t.end, text: wikilinkForCacheItem(cacheFolder, t.itemId, t.ext, names.get(t.itemId) ?? '', t.alias) })),
        )
      }),
    )
    for (const result of results) if (result.status === 'rejected') log.error('cache migration link rewrite failed', result.reason)
    return leftInPlace
  }

  private async syncCacheForFile(file: TFile): Promise<void> {
    const content = await this.plugin.app.vault.read(file)
    const tokens = findEagleWikilinkTokens(content, this.plugin.cacheManager.cacheFolder)
    if (tokens.length === 0) return

    const results = await Promise.allSettled(
      tokens.map(async ({ itemId, ext, displayName }) => {
        const isCached = await this.plugin.cacheManager.isCached(itemId, ext, displayName)
        const exists = await this.plugin.eagleUploader.itemExists(itemId)

        if (exists === null) {
          // Eagle unreachable or error: skip to avoid data loss, and back off like the backfill does.
          this.eagleUnreachableUntil = Date.now() + UNREACHABLE_BACKOFF_MS
          return
        }

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
