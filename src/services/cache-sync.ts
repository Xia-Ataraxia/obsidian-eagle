import type { TFile } from 'obsidian'

import type EaglePlugin from '../main'

import { wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { contentFingerprint, isSameLibrary, legacyMigrationComplete, marksChecked, outcomeForError, planCacheSync, retryPlan, shouldReportProgress, type ItemOutcome } from '../utils/cache-sync-plan'
import { countLabel } from '../utils/plural'
import { findEagleWikilinkTokens, type WikilinkEmbedToken } from '../utils/markdown-image'
import { fileUrlToOsPath } from '../ui/file-url'
import { rewriteNote } from '../ui/obsidian-vault'

const UNREACHABLE_BACKOFF_MS = 30_000
const OWN_WRITE_GRACE_MS = 5_000

interface Tally {
  /** Latest outcome per item, so an item linked from many notes counts once. */
  outcomes: Map<string, ItemOutcome>
  /** Outcomes of legacy links Eagle gave no name for; decides whether the vault counts as migrated. */
  legacy: ItemOutcome[]
  /** Links to renamed items that couldn't be rewritten. */
  linkFailures: number
  unreadable: number
  /** Legacy items whose old file stays beside the new-name copy because a canvas file references them. */
  canvasKept: number
  /** Every old file stayed because some file couldn't be read and might still link it. */
  oldFilesKept: boolean
}

interface LegacyNote {
  file: TFile
  /** Item id per legacy link in the note, repeats included, so failures count links. */
  itemIds: string[]
}

const newTally = (): Tally => ({ outcomes: new Map(), legacy: [], linkFailures: 0, unreadable: 0, canvasKept: 0, oldFilesKept: false })

/**
 * Passive syncs (open notes, file-open, edits) only backfill the note at hand, under the filenames its
 * links already use. Renaming legacy cache files rewrites other notes, so only the explicit command does it.
 * The command runs beside the passive queue, so opening or editing a note never waits on it.
 */
export class CacheSyncService {
  constructor(private readonly plugin: EaglePlugin) {}

  private readonly checkedItems = new Set<string>()
  // Items Eagle confirmed this session; later deletions in Eagle are noticed after a restart or the command.
  private readonly confirmedItems = new Set<string>()
  // Note syncs run one at a time so a bulk external sync can't flood the Eagle API.
  private queue: Promise<void> = Promise.resolve()
  private commandRun: Promise<void> | null = null
  // While the command renames, passive syncs leave legacy links alone so they never fetch a file it is moving.
  private migrationRunning = false
  // While Eagle is down, syncs make no API calls until this passes, so typing stays free.
  private eagleUnreachableUntil = 0
  // Notes with items that couldn't settle, synced again when due; one timer serves them all.
  private readonly deferred = new Map<string, { evict: boolean; dueAt: number }>()
  private retryTimer: number | null = null
  // Fingerprint of what the command last wrote per note, so its own rewrite doesn't trigger a sync.
  private readonly ownWrites = new Map<string, string>()
  // Notes edited while the command migrates; re-read before old files go, since the scan missed their edits.
  private readonly changedDuringRun = new Set<string>()
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

  /** Called for every edit the plugin didn't write itself. */
  noteChanged(path: string): void {
    if (this.migrationRunning) this.changedDuringRun.add(path)
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
      const items = this.plan(content, false).items.filter((t) => !this.migrationRunning || t.displayName !== undefined)
      const tally = newTally()
      await this.backfillAll(items, tally)
      const outcomes = [...tally.outcomes.values()]
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

  /** Explicit command: re-checks every note's links and renames legacy cache files vault-wide, with progress. */
  syncAllNotes(): Promise<void> {
    if (this.commandRun) return this.commandRun
    // A fresh session starts at invocation, so passive syncs re-check too.
    this.checkedItems.clear()
    this.confirmedItems.clear()
    this.eagleUnreachableUntil = 0
    this.library = null
    this.commandRun = this.runCommand()
      .catch((err) => this.plugin.log.error('cache sync failed unexpectedly', err))
      .finally(() => {
        this.commandRun = null
      })
    return this.commandRun
  }

  private async runCommand(): Promise<void> {
    const { app, cacheManager, notices, log } = this.plugin
    const renameLegacy = !this.plugin.settings.legacyCacheNamesMigrated
    const files = app.vault.getMarkdownFiles()
    const tally = newTally()
    const legacyNotes: LegacyNote[] = []
    const legacyItems = new Map<string, WikilinkEmbedToken>()
    let lastReportAt = 0
    const report = (step: string, done: number, total: number) => notices.show('cache_sync_progress', { step }, { progress: { done, total } })
    report('Checking notes for images…', 0, files.length)
    this.migrationRunning = renameLegacy
    this.changedDuringRun.clear()
    try {
      for (const [i, file] of files.entries()) {
        if (this.unloaded) return
        try {
          const tokens = findEagleWikilinkTokens(await app.vault.cachedRead(file), cacheManager.cacheFolder)
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
      if (legacyItems.size > 0 && !this.unloaded) {
        const canvasKept = tally.unreadable === 0 ? await this.canvasReferenced(legacyItems, tally) : new Set<string>()
        // An unread note or canvas might link any old name, so every old file stays beside its new-name copy.
        tally.oldFilesKept = tally.unreadable > 0
        const keepOld = tally.oldFilesKept ? new Set(legacyItems.keys()) : canvasKept
        report('Renaming cached images…', 0, legacyItems.size)
        await this.renameLegacy(legacyItems, legacyNotes, keepOld, tally)
      }
      if (renameLegacy && tally.unreadable === 0 && tally.canvasKept === 0 && legacyMigrationComplete(tally.legacy, tally.linkFailures)) {
        this.plugin.settings.legacyCacheNamesMigrated = true
        await this.plugin.saveSettings()
      }
    } finally {
      this.migrationRunning = false
      this.changedDuringRun.clear()
      // Obsidian reports the command's writes a moment later; matched entries drop themselves, the rest expire.
      window.setTimeout(() => {
        if (!this.commandRun) this.ownWrites.clear()
      }, OWN_WRITE_GRACE_MS)
      notices.remove('cache_sync_progress')
      this.showSummary(tally)
    }
  }

  /** Legacy items a canvas file references; canvases are only searched, never rewritten. */
  private async canvasReferenced(legacyItems: Map<string, WikilinkEmbedToken>, tally: Tally): Promise<Set<string>> {
    const { app, cacheManager, log } = this.plugin
    const canvases: string[] = []
    for (const file of app.vault.getFiles()) {
      if (file.extension !== 'canvas') continue
      try {
        canvases.push(await app.vault.cachedRead(file))
      } catch (err) {
        tally.unreadable++
        log.warn('cache sync skipped a canvas', { path: file.path, err })
      }
    }
    const kept = new Set<string>()
    for (const { itemId, ext } of legacyItems.values()) {
      const path = cacheManager.cachedVaultPath(itemId, ext)
      if (canvases.some((canvas) => canvas.includes(path))) kept.add(itemId)
    }
    tally.canvasKept = kept.size
    return kept
  }

  private showSummary({ outcomes, linkFailures, unreadable, canvasKept, oldFilesKept }: Tally): void {
    const counts = { cached: 0, unreachable: 0, failed: 0 }
    for (const outcome of outcomes.values()) {
      // An Eagle error (e.g. while it switches libraries) reads like an unreachable Eagle to the user.
      const key = outcome === 'error' ? 'unreachable' : outcome
      if (key in counts) counts[key as keyof typeof counts]++
    }
    const canvasClause = canvasKept === 1 ? '1 image is used in canvas files, so its old file was kept.' : `${countLabel(canvasKept, 'image')} are used in canvas files, so their old files were kept.`
    const failures = [
      counts.unreachable > 0 ? `${countLabel(counts.unreachable, 'image')} couldn't be fetched. Make sure Eagle is open.` : '',
      counts.failed > 0 ? `${countLabel(counts.failed, 'image')} couldn't be copied.` : '',
      linkFailures > 0 ? `${countLabel(linkFailures, 'link')} couldn't be updated.` : '',
      unreadable > 0 ? `${countLabel(unreadable, 'note')} couldn't be read${oldFilesKept ? ', so old cache files were kept' : ''}.` : '',
      canvasKept > 0 ? canvasClause : '',
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
  private async classify(err: unknown): Promise<ItemOutcome> {
    const outcome = outcomeForError(err)
    if (outcome === 'unreachable') {
      this.eagleUnreachableUntil = Date.now() + UNREACHABLE_BACKOFF_MS
      // The user may switch libraries while Eagle is away.
      this.library = null
    }
    return outcome === 'missing' ? this.confirmMissing() : outcome
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
   * Renames `{itemId}.{ext}` cache files to `{displayName}_{itemId}.{ext}`. Links are rewritten first;
   * a file is moved only once every note linking it was rewritten, so a failed rewrite never dangles.
   * Items in `keepOld`, and items whose rewrite failed, keep the old file beside a new-name copy.
   */
  private async renameLegacy(legacyItems: Map<string, WikilinkEmbedToken>, notes: LegacyNote[], keepOld: Set<string>, tally: Tally): Promise<void> {
    const { app, cacheManager, eagleUploader, log, notices } = this.plugin
    const names = new Map<string, string>()
    let done = 0
    for (const itemId of legacyItems.keys()) {
      if (this.unloaded) return
      let outcome: ItemOutcome | undefined
      try {
        const name = this.isBackingOff() ? undefined : await eagleUploader.getItemName(itemId)
        if (name) names.set(itemId, name)
        else outcome = name === null ? await this.confirmMissing() : 'unreachable'
      } catch (err) {
        outcome = await this.classify(err)
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
    const unrewritten = new Set(keepOld)
    const rewrite = async (file: TFile, renamed: string[]) => {
      if (renamed.length === 0) return
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
        log.error('cache migration link rewrite failed', { path: file.path, err })
        tally.linkFailures += renamed.length
        for (const id of renamed) unrewritten.add(id)
      }
    }
    for (const { file, itemIds } of notes) await rewrite(file, itemIds.filter((id) => names.has(id)))
    // A note edited during the run may have gained a legacy link the scan never saw.
    for (const path of this.changedDuringRun) {
      const file = app.vault.getFileByPath(path)
      if (!file) continue
      try {
        const tokens = findEagleWikilinkTokens(await app.vault.read(file), cacheFolder)
        await rewrite(file, tokens.filter((t) => t.displayName === undefined && names.has(t.itemId)).map((t) => t.itemId))
      } catch (err) {
        log.warn('cache migration could not re-read an edited note', { path, err })
        tally.unreadable++
        tally.oldFilesKept = true
        for (const id of names.keys()) unrewritten.add(id)
      }
    }
    if (this.unloaded) return

    const { adapter } = app.vault
    for (const token of legacyItems.values()) {
      const { itemId, ext } = token
      const name = names.get(itemId)
      if (!name) continue
      const oldPath = cacheManager.cachedVaultPath(itemId, ext)
      const newPath = cacheManager.cachedVaultPath(itemId, ext, name)
      try {
        // A file that may still be linked by its old name stays; the backfill copies one under the new name.
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
