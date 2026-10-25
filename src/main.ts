import {
  Editor,
  EditorPosition,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Plugin,
  ReferenceCache,
  TFile,
} from 'obsidian'

import EagleApiError from './domain/EagleApiError'
import { resolveMappedEagleFolder, sanitizeFolderMappings } from './domain/folder-mapping'
import { DEFAULT_SETTINGS, EaglePluginSettings } from './domain/settings'
import { DebounceController } from './utils/debounce-controller'
import { PluginLogger } from './utils/plugin-logger'
import { NoticeCatalog, PluginNotices } from './ui/plugin-notices'
import { createEagleCanvasPasteHandler } from './ui/Canvas'
import EagleCacheManager from './ui/EagleCacheManager'
import EagleHashStore from './ui/EagleHashStore'
import EaglePluginSettingsTab from './ui/EaglePluginSettingsTab'
import EagleSearchPickerModal from './ui/EagleSearchPickerModal'
import EagleUploader, { type EagleItemSearchResult } from './ui/EagleUploader'
import { findLocalFileUnderCursor, replaceFirstOccurrence } from './ui/editor'
import { fileUrlToDisplayUrl, fileUrlToOsPath } from './ui/file-url'
import ImageUploadBlockingModal from './ui/ImageUploadBlockingModal'
import InfoModal from './ui/InfoModal'
import { normalizeImageForUpload, removeReferenceIfPresent } from './ui/misc'
import { filesAndLinksStatsFrom, getAllCachedReferencesForFile, replaceAllLocalReferencesWithRemoteOne } from './ui/obsidian-vault'
import UpdateLinksConfirmationModal from './ui/UpdateLinksConfirmationModal'
import { allFilesAreImages } from './utils/FileList'
import { safeCacheFolderPath, safePathSegment, wikilinkForCacheItem } from './utils/eagle-path-contract'
import { extractFileExtension } from './utils/image-format'
import { resolveItemName } from './utils/item-naming'
import { applyTextReplacements, findEagleWikilinkTokens, findMarkdownImageTokens, type WikilinkEmbedToken } from './utils/markdown-image'
import { generatePseudoRandomId } from './utils/pseudo-random'

const EAGLE_NOTICE_CATALOG: NoticeCatalog = {
  links_updated: { template: 'Updated {{linksCount}} links in {{filesCount}} files' },
  migrate_none: { template: 'No images to migrate.' },
  migrate_done: { template: 'Migrated {{count}} image(s) to {{folder}}.{{failureSuffix}}', timeout: 8000 },
  import_failed_api: { template: 'Failed to import from Eagle: {{message}}' },
  import_failed: { template: 'Failed to insert Eagle image.' },
  no_active_editor: { template: 'No active editor — cannot upload.' },
  duplicate_detected: { template: 'Duplicate detected, reusing existing item' },
  cache_renamed: {
    template: "Moved cache to '{{newFolder}}'. Updated {{linksCount}} link(s) in {{filesCount}} file(s), moved {{movedFiles}} file(s).",
    timeout: 10000,
  },
  connection_ok: { template: 'Connected to Eagle' },
  connection_fail: { template: 'Cannot reach Eagle — check host/port' },
}

interface CanvasView {
  handlePaste: (e: ClipboardEvent) => Promise<void>
  getViewType(): string
}

interface LocalImageInEditor {
  image: {
    file: TFile
    start: EditorPosition
    end: EditorPosition
  }
  editor: Editor
  noteFile: TFile
}

interface OldFormatMatch {
  token: ReturnType<typeof findMarkdownImageTokens>[number]
  itemId: string
}

export default class EaglePlugin extends Plugin {
  private readonly log = new PluginLogger('Eagle')
  declare settings: EaglePluginSettings

  notices: PluginNotices

  private _eagleUploader: EagleUploader

  get eagleUploader(): EagleUploader {
    return this._eagleUploader
  }

  private _cacheManager: EagleCacheManager

  get cacheManager(): EagleCacheManager {
    return this._cacheManager
  }

  private _hashStore: EagleHashStore
  private _lastSyncedFilePath: string | null = null
  private _pendingSyncFile: TFile | null = null
  private readonly syncDebounce = new DebounceController({
    delayMs: 500,
    onRun: async () => {
      const file = this._pendingSyncFile
      if (!file) return
      if (file.path === this._lastSyncedFilePath) return
      this._lastSyncedFilePath = file.path
      await this.syncCacheForFile(file).catch((err) => {
        this.log.error('syncCacheForFile failed', err)
      })
    },
  })

  private handleImageFiles(files: FileList, e: Event): void {
    if (!allFilesAreImages(files)) return

    e.preventDefault()
    for (const file of files) {
      void this.uploadFileAndEmbedEagleImage(file).catch((err) => {
        this.log.error('Failed to upload image', err)
      })
    }
  }

  private customPasteEventCallback = (e: ClipboardEvent) => {
    this.handleImageFiles(e.clipboardData.files, e)
  }

  private customDropEventListener = (e: DragEvent) => {
    this.handleImageFiles(e.dataTransfer.files, e)
  }

  private eaglePluginRightClickHandler = (menu: Menu, editor: Editor, view: MarkdownView) => {
    const localFile = findLocalFileUnderCursor(editor, view)
    if (!localFile) return

    menu.addItem((item) =>
      item
        .setTitle('Upload to eagle')
        .setIcon('upload')
        .onClick(() => {
          void this.doUploadLocalImage({ image: localFile, editor, noteFile: view.file })
        }),
    )
  }

  private async doUploadLocalImage(imageInEditor: LocalImageInEditor) {
    const remoteMarkdownImage = await this.uploadLocalImageFromEditor(
      imageInEditor.editor,
      imageInEditor.image.file,
      imageInEditor.image.start,
      imageInEditor.image.end,
    )

    this.proposeToReplaceOtherLocalLinksIfAny(imageInEditor.image.file, remoteMarkdownImage, {
      path: imageInEditor.noteFile.path,
      startPosition: imageInEditor.image.start,
    })
  }

  private proposeToReplaceOtherLocalLinksIfAny(
    originalLocalFile: TFile,
    remoteMarkdownImage: string,
    originalReference: { path: string; startPosition: EditorPosition },
  ) {
    const referencesByNotes = this.getAllCachedReferencesForFile(originalLocalFile)
    this.removeReferenceToOriginalNoteIfPresent(referencesByNotes, originalReference)

    if (Object.keys(referencesByNotes).length > 0) {
      this.showLinksUpdateDialog(originalLocalFile, remoteMarkdownImage, referencesByNotes)
    }
  }

  private getAllCachedReferencesForFile(file: TFile): Record<string, ReferenceCache[]> {
    return getAllCachedReferencesForFile(this.app.metadataCache, file)
  }

  private removeReferenceToOriginalNoteIfPresent = (
    referencesByNote: Record<string, ReferenceCache[]>,
    originalNoteRef: { path: string; startPosition: EditorPosition },
  ) => removeReferenceIfPresent(referencesByNote, originalNoteRef)

  private showLinksUpdateDialog(
    localFile: TFile,
    remoteMarkdownImage: string,
    otherReferencesByNote: Record<string, ReferenceCache[]>,
  ) {
    const stats = filesAndLinksStatsFrom(otherReferencesByNote)
    const dialogBox = new UpdateLinksConfirmationModal(this.app, localFile.path, stats)
    dialogBox.onDoNotUpdateClick(() => dialogBox.close())
    dialogBox.onDoUpdateClick(() => {
      dialogBox.disableButtons()
      dialogBox.setContent('Working...')
      replaceAllLocalReferencesWithRemoteOne(
        this.app.vault,
        otherReferencesByNote,
        remoteMarkdownImage,
      )
        .catch((e) => {
          new InfoModal(
            this.app,
            'Error',
            'Unexpected error occurred, check Developer Tools console for details',
          ).open()
          this.log.error('Something bad happened during links update', e)
        })
        .finally(() => dialogBox.close())
      this.notices.show('links_updated', { linksCount: stats.linksCount, filesCount: stats.filesCount })
    })
    dialogBox.open()
  }

  private async uploadLocalImageFromEditor(
    editor: Editor,
    file: TFile,
    start: EditorPosition,
    end: EditorPosition,
  ) {
    const arrayBuffer = await this.app.vault.readBinary(file)
    const fileToUpload = new File([arrayBuffer], file.name)
    editor.replaceRange('\n', end, end)
    const remoteMarkdownImage = await this.uploadFileAndEmbedEagleImage(fileToUpload, {
      ch: 0,
      line: end.line + 1,
    })
    if (remoteMarkdownImage) {
      editor.replaceRange(`<!--${editor.getRange(start, end)}-->`, start, end)
    }
    return remoteMarkdownImage
  }

  private async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...((await this.loadData()) as EaglePluginSettings),
    }

    this.settings.folderMappings = sanitizeFolderMappings(this.settings.folderMappings ?? [])
    this.settings.cacheFolderName = safeCacheFolderPath(this.settings.cacheFolderName)
  }

  async saveSettings(): Promise<void> {
    this.settings.folderMappings = sanitizeFolderMappings(this.settings.folderMappings ?? [])
    this.settings.cacheFolderName = safeCacheFolderPath(this.settings.cacheFolderName)
    const existing = ((await this.loadData()) as Record<string, unknown>) ?? {}
    await this.saveData({ ...existing, ...this.settings })
  }

  override onload() {
    void this.initPlugin()
  }

  override onunload() {
    this.notices.unload()
    this.syncDebounce.dispose()
  }

  private async initPlugin() {
    await this.loadSettings()
    this.notices = new PluginNotices(this, EAGLE_NOTICE_CATALOG, 'Eagle')
    this.addSettingTab(new EaglePluginSettingsTab(this.app, this))

    this.setupEagleUploader()
    this._cacheManager = new EagleCacheManager(this.app, this.settings.cacheFolderName)
    this._hashStore = new EagleHashStore()
    await this._hashStore.load(this)
    await this.migrateCacheFilesToReadableNames().catch((err) => {
      this.log.error('cache filename migration failed', err)
    })
    this.setupEagleHandlers()
    this.addUploadLocalCommand()
    this.addImportFromEagleLibraryCommand()
    this.addMigrateAllImagesCommand()
    this.registerEagleImageRenderer()
    void this.lazySyncEagleCache().catch((err) => {
      this.log.error('background cache sync failed unexpectedly', err)
    })
  }

  setupEagleUploader(): void {
    this._eagleUploader = new EagleUploader(this.app, this.settings)
  }

  private setupEagleHandlers() {
    this.registerEvent(this.app.workspace.on('editor-paste', this.customPasteEventCallback))
    this.registerEvent(this.app.workspace.on('editor-drop', this.customDropEventListener))
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf) => {
        const view = leaf?.view
        if (!view) return

        if (view.getViewType() === 'canvas') {
          this.overridePasteHandlerForCanvasView(view as unknown as CanvasView)
        }

        const file = (view as unknown as { file?: unknown }).file
        if (file instanceof TFile && file.extension === 'md') {
          this._pendingSyncFile = file
          this.syncDebounce.markDirty()
        }
      }),
    )

    this.registerEvent(this.app.workspace.on('editor-menu', this.eaglePluginRightClickHandler))
  }

  private overridePasteHandlerForCanvasView(view: CanvasView) {
    const originalPasteFn = view.handlePaste
    view.handlePaste = createEagleCanvasPasteHandler(this, originalPasteFn)
  }

  private addUploadLocalCommand() {
    this.addCommand({
      id: 'upload-local',
      name: 'Upload to eagle',
      editorCheckCallback: this.editorCheckCallbackForLocalUpload,
    })
  }

  private addImportFromEagleLibraryCommand() {
    this.addCommand({
      id: 'import-from-library',
      name: 'Insert image from eagle (search)',
      editorCheckCallback: this.editorCheckCallbackForLibraryImport,
    })
  }

  private addMigrateAllImagesCommand() {
    this.addCommand({
      id: 'migrate-all-images',
      name: 'Migrate all images to eagle-cache',
      callback: () => {
        void this.migrateAllImages()
      },
    })
  }

  private async migrateAllImages(): Promise<void> {
    const cacheFolderName = this.settings.cacheFolderName

    // Phase 1: Scan all files for old-format tokens in parallel
    const oldFormatByFile = new Map<string, { file: TFile; content: string; candidates: OldFormatMatch[] }>()
    const itemIds = new Set<string>()

    const fileResults = await Promise.all(
      this.app.vault.getMarkdownFiles().map(async (file) => {
        const content = await this.app.vault.read(file)
        const oldCandidates = findMarkdownImageTokens(content)
          .map((token) => ({ token, itemId: EaglePlugin.eagleItemIdFromAlt(token.alt) }))
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
      this.notices.show('migrate_none')
      return
    }

    // Phase 2: Resolve Eagle API URLs
    const resolvedUrls = new Map<string, string>()
    const failedIds = new Set<string>()

    await Promise.allSettled(
      Array.from(itemIds).map(async (itemId) => {
        try {
          const fileUrl = await this._eagleUploader.getFileUrlForItemId(itemId)
          if (fileUrl.startsWith('file://')) {
            resolvedUrls.set(itemId, fileUrl)
          } else {
            failedIds.add(itemId)
          }
        } catch {
          this.log.warn('failed to resolve URL during migration', { itemId })
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
          await this._cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl))
          successExt.set(itemId, ext)
        } catch (err) {
          this.log.error('failed to cache file during migration', err)
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
        await this.app.vault.modify(file, applyTextReplacements(content, replacements))
      }
    }

    let failureSuffix = ''
    if (failedIds.size > 0) {
      const sample = Array.from(failedIds).slice(0, 3).join(', ')
      const extra = failedIds.size > 3 ? ` and ${failedIds.size - 3} more` : ''
      failureSuffix = ` Failed: ${failedIds.size} (${sample}${extra})`
    }
    this.notices.show('migrate_done', { count: migratedCount, folder: `${cacheFolderName}/`, failureSuffix })
  }

  /**
   * One-time migration: renames existing `{itemId}.{ext}` cache files to
   * `{displayName}_{itemId}.{ext}` and updates all wikilinks in the vault.
   * Requires Eagle to be running — silently skips items it cannot resolve.
   */
  private async migrateCacheFilesToReadableNames(): Promise<void> {
    const cacheFolder = this._cacheManager.cacheFolder
    const adapter = this.app.vault.adapter

    // Collect all old-format tokens (stem has no underscore before the itemId).
    // New-format tokens already have displayName set, so we skip them.
    const tokensByFile = new Map<string, { file: ReturnType<typeof this.app.vault.getMarkdownFiles>[number]; content: string; tokens: WikilinkEmbedToken[] }>()

    await Promise.all(
      this.app.vault.getMarkdownFiles().map(async (file) => {
        const content = await this.app.vault.read(file)
        const oldTokens = findEagleWikilinkTokens(content, cacheFolder).filter((t) => t.displayName === undefined)
        if (oldTokens.length > 0) tokensByFile.set(file.path, { file, content, tokens: oldTokens })
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
        const name = await this._eagleUploader.getItemName(itemId)
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

        const oldPath = this._cacheManager.cachedVaultPath(itemId, ext)
        const newPath = this._cacheManager.cachedVaultPath(itemId, ext, displayName)
        if (oldPath === newPath) return

        try {
          if (await adapter.exists(oldPath)) {
            await adapter.rename(oldPath, newPath)
          }
          renamedIds.add(itemId)
        } catch {
          this.log.warn('cache migration rename failed', { itemId })
        }
      }),
    )

    if (renamedIds.size === 0) return

    // Update wikilinks in all affected vault files.
    await Promise.allSettled(
      Array.from(tokensByFile.values()).map(async ({ file, content, tokens }) => {
        const replacements = tokens
          .filter((t) => renamedIds.has(t.itemId))
          .map((t) => {
            const displayName = nameMap.get(t.itemId) ?? ''
            return { start: t.start, end: t.end, text: wikilinkForCacheItem(cacheFolder, t.itemId, t.ext, displayName) }
          })
        if (replacements.length > 0) {
          await this.app.vault.modify(file as import('obsidian').TFile, applyTextReplacements(content, replacements))
        }
      }),
    )
  }

  private async lazySyncEagleCache(): Promise<void> {
    const cacheFolder = this._cacheManager.cacheFolder
    // Phase 1: Collect unique itemId → ext across all vault files in parallel
    const seen = new Map<string, { ext: string; displayName: string | undefined }>() // itemId → {ext, displayName}
    const fileContents = await Promise.all(
      this.app.vault.getMarkdownFiles().map(async (file) => {
        try {
          return await this.app.vault.read(file)
        } catch {
          this.log.warn('failed to read file during lazy cache sync', { path: file.path })
          return ''
        }
      }),
    )
    for (const content of fileContents) {
      for (const token of findEagleWikilinkTokens(content, cacheFolder)) {
        if (!seen.has(token.itemId)) seen.set(token.itemId, { ext: token.ext, displayName: token.displayName })
      }
    }

    // Phase 2: Filter to uncached in parallel — allSettled so one adapter failure doesn't abort the rest
    const entries = Array.from(seen.entries())
    const cachedResults = await Promise.allSettled(
      entries.map(([id, { ext, displayName }]) => this._cacheManager.isCached(id, ext, displayName)),
    )
    const uncached = entries
      .filter((_, i) => {
        const result = cachedResults[i]
        if (result.status === 'rejected') {
          this.log.warn('isCached check failed, treating as uncached', { id: entries[i][0] })
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
          const fileUrl = await this._eagleUploader.getFileUrlForItemId(itemId)
          if (!fileUrl.startsWith('file://')) return
          await this._cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName)
        } catch (err) {
          if (err instanceof EagleApiError) return // Eagle not running or item missing — expected
          this.log.error('unexpected error during lazy cache sync', err)
        }
      }),
    )
  }

  private async syncCacheForFile(file: TFile): Promise<void> {
    const content = await this.app.vault.read(file)
    const tokens = findEagleWikilinkTokens(content, this._cacheManager.cacheFolder)
    if (tokens.length === 0) return

    const results = await Promise.allSettled(
      tokens.map(async ({ itemId, ext, displayName }) => {
        const isCached = await this._cacheManager.isCached(itemId, ext, displayName)
        const exists = await this._eagleUploader.itemExists(itemId)

        if (exists === null) return // Eagle unreachable or error — skip to avoid data loss

        if (exists === false && isCached) {
          // Item confirmed deleted from Eagle — evict from cache
          this.log.info('evicting deleted item from cache', { itemId, file: file.path })
          await this._cacheManager.removeCache(itemId, ext, displayName)
        } else if (exists === true && !isCached) {
          // Cache file absent but item exists (cache cleared, synced from another device) — backfill
          try {
            const fileUrl = await this._eagleUploader.getFileUrlForItemId(itemId)
            if (!fileUrl.startsWith('file://')) {
              this.log.debug('syncCacheForFile backfill skipped — non-local URL', { itemId })
              return
            }
            await this._cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName)
          } catch (err) {
            if (err instanceof EagleApiError) {
              this.log.debug('syncCacheForFile backfill skipped — Eagle API error', { itemId })
              return
            }
            this.log.warn('syncCacheForFile backfill failed', { itemId })
          }
        }
      }),
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        this.log.error('syncCacheForFile token processing failed', result.reason)
      }
    }
  }

  private static eagleItemIdFromAlt(alt: string) {
    const match = alt.trim().match(/^eagle:([A-Za-z0-9]+)(?:\|\d+)?$/)
    return match ? match[1] : null
  }

  private static eagleItemIdFromLink(link: string) {
    const match = link.match(/[\\/]+images[\\/]+([^\\/]+)\.info[\\/]+/i)
    return match ? match[1] : null
  }

  private registerEagleImageRenderer(): void {
    this.registerMarkdownPostProcessor((el) => {
      // Backward-compat: recover old-format ![eagle:ID](...) images
      el.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
        const itemId =
          EaglePlugin.eagleItemIdFromAlt(img.alt) ??
          EaglePlugin.eagleItemIdFromLink(img.getAttribute('src') ?? '')
        if (!itemId) return

        const recoverImage = async () => {
          try {
            const url = await this._eagleUploader.getFileUrlForItemId(itemId)
            if (url.startsWith('file://')) img.src = fileUrlToDisplayUrl(url)
          } catch (err) {
            if (!(err instanceof EagleApiError)) {
              this.log.error('unexpected error during image recovery', err)
            }
          }
        }

        // Image already failed before this handler was registered
        if (img.complete && img.naturalWidth === 0 && img.src) {
          void recoverImage()
          return
        }

        img.addEventListener('error', () => { void recoverImage() }, { once: true })
      })
    })
  }

  private editorCheckCallbackForLocalUpload = (
    checking: boolean,
    editor: Editor,
    ctx: MarkdownFileInfo,
  ) => {
    const localFile = findLocalFileUnderCursor(editor, ctx)
    if (!localFile) return false
    if (checking) return true

    void this.doUploadLocalImage({ image: localFile, editor, noteFile: ctx.file })
  }

  private editorCheckCallbackForLibraryImport = (checking: boolean, editor: Editor) => {
    if (checking) return true

    void this.importFromLibrary(editor)
    return true
  }

  private importFromLibrary(editor: Editor) {
    new EagleSearchPickerModal(
      this.app,
      this._eagleUploader,
      (item) => {
        void this.insertSelectedSearchItem(editor, item)
      },
      this.settings.debugSearchDiagnostics,
      this.settings.searchDebounceMs,
    ).open()
  }

  private async insertSelectedSearchItem(editor: Editor, item: EagleItemSearchResult): Promise<void> {
    try {
      const fileUrl = await this._eagleUploader.resolveFileUrl(item)
      const ext = item.ext || extractFileExtension(fileUrl) || 'jpg'
      const displayName = item.name || undefined
      if (fileUrl.startsWith('file://')) {
        await this._cacheManager.cacheFromOsPath(item.id, ext, fileUrlToOsPath(fileUrl), displayName).catch((e) => {
          this.log.warn('cache write failed — image may appear broken', {})
        })
      }
      const markdownImage = this.markdownImageFor(item.id, ext, displayName)
      editor.replaceRange(markdownImage, editor.getCursor())
    } catch (error) {
      if (error instanceof EagleApiError) {
        this.notices.show('import_failed_api', { message: error.message })
      } else {
        this.log.error('Unexpected error while importing Eagle image', error)
        this.notices.show('import_failed')
      }
    }
  }

  private async uploadFileAndEmbedEagleImage(file: File, atPos?: EditorPosition) {
    if (!this.activeEditor) {
      this.notices.show('no_active_editor')
      return
    }
    const pasteId = generatePseudoRandomId()
    this.insertTemporaryText(pasteId, atPos)

    const modal = new ImageUploadBlockingModal(this.app)
    modal.open()
    const controller = new AbortController()
    modal.onCancel = () => {
      controller.abort()
    }

    let markdownImage = ''
    try {
      const folderName = this.resolveTargetEagleFolderForActiveFile()
      const normalizedFile = await normalizeImageForUpload(file)
      const originalName = file.name.replace(/\.[^.]+$/, '')
      const noteName = this.app.workspace.getActiveFile()?.basename ?? ''
      const displayName = resolveItemName(this.settings.uploadItemNameTemplate, { originalName, noteName })

      // Deduplication: compute hash and library path once, reuse for lookup + storage
      let dedupHash: string | null = null
      let dedupLibraryPath: string | null = null

      if (this.settings.deduplicateUploads) {
        const buffer = await normalizedFile.arrayBuffer()
        dedupHash = await EagleHashStore.computeHash(buffer)
        dedupLibraryPath = await this._eagleUploader.getLibraryRootPath(controller.signal) ?? null
        if (dedupLibraryPath) {
          const existingItemId = this._hashStore.lookup(dedupHash, dedupLibraryPath)
          if (existingItemId) {
            this.notices.show('duplicate_detected')
            const fileUrl = await this._eagleUploader.getFileUrlForItemId(existingItemId.itemId, controller.signal)
            const ext = fileUrl.startsWith('file://') ? (extractFileExtension(fileUrl) || 'jpg') : 'jpg'
            if (fileUrl.startsWith('file://')) {
              await this._cacheManager.cacheFromOsPath(existingItemId.itemId, ext, fileUrlToOsPath(fileUrl), existingItemId.displayName).catch((e) => {
                this.log.warn('cache write failed — image may appear broken', {})
              })
            }
            markdownImage = this.markdownImageFor(existingItemId.itemId, ext, existingItemId.displayName)
            this.embedMarkDownImage(pasteId, markdownImage)
            modal.close()
            return markdownImage
          }
        }
      }

      const { itemId, fileUrl, ext } = await this._eagleUploader.upload(normalizedFile, { folderName, signal: controller.signal, displayName })

      if (fileUrl.startsWith('file://')) {
        await this._cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName).catch((e) => {
          this.log.warn('cache write failed — image may appear broken', {})
        })
      }

      // Store hash for future deduplication (reuse pre-computed values)
      if (dedupHash && dedupLibraryPath) {
        this._hashStore.store(dedupHash, itemId, displayName, dedupLibraryPath)
        await this._hashStore.save(this).catch((e) => {
          this.log.warn('failed to store upload hash', {})
        })
      }

      markdownImage = this.markdownImageFor(itemId, ext, displayName)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        modal.close()
        this.handleFailedUpload(pasteId, ' upload cancelled ')
        return markdownImage
      }
      if (e instanceof EagleApiError) {
        this.log.error('Eagle upload failed', e)
        modal.showError(`Upload failed: ${e.message}`)
        this.handleFailedUpload(pasteId, `Eagle upload failed, API returned an error: ${e.message}`)
      } else {
        this.log.error('Failed upload request', e)
        modal.showError('Upload failed — check the developer console for details.')
        this.handleFailedUpload(pasteId, '⚠️Eagle upload failed, check dev console')
      }
      return markdownImage
    }

    modal.close()
    this.embedMarkDownImage(pasteId, markdownImage)
    return markdownImage
  }

  private insertTemporaryText(pasteId: string, atPos?: EditorPosition) {
    const progressText = EaglePlugin.progressTextFor(pasteId)
    const replacement = `${progressText}\n`
    const editor = this.activeEditor
    if (!editor) return
    if (atPos) {
      editor.replaceRange(replacement, atPos, atPos)
    } else {
      editor.replaceSelection(replacement)
    }
  }

  private static progressTextFor(id: string) {
    return `![Uploading to Eagle...${id}]()`
  }

  private markdownImageFor(itemId: string, ext: string, displayName?: string) {
    return wikilinkForCacheItem(this._cacheManager.cacheFolder, itemId, ext, displayName)
  }

  private embedMarkDownImage(pasteId: string, markdownImage: string) {
    const progressText = EaglePlugin.progressTextFor(pasteId)
    const editor = this.activeEditor
    if (!editor) return
    replaceFirstOccurrence(editor, progressText, markdownImage)
  }

  private handleFailedUpload(pasteId: string, message: string) {
    const progressText = EaglePlugin.progressTextFor(pasteId)
    const editor = this.activeEditor
    if (!editor) return
    replaceFirstOccurrence(editor, progressText, `<!--${message}-->`)
  }

  private get activeEditor(): Editor | null {
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView)
    return mdView?.editor ?? null
  }

  async renameCache(oldFolder: string, newFolder: string): Promise<void> {
    // Step 1: Update wikilinks in all markdown files
    let updatedFiles = 0
    let updatedLinks = 0
    const files = this.app.vault.getMarkdownFiles()

    await Promise.all(
      files.map(async (file) => {
        const content = await this.app.vault.read(file)
        const tokens = findEagleWikilinkTokens(content, oldFolder)
        if (tokens.length === 0) return

        const replacements = tokens.map((t) => ({
          start: t.start,
          end: t.end,
          text: wikilinkForCacheItem(safeCacheFolderPath(newFolder), t.itemId, t.ext, t.displayName),
        }))
        await this.app.vault.modify(file, applyTextReplacements(content, replacements))
        updatedFiles++
        updatedLinks += replacements.length
      }),
    )

    // Step 2: Move cached files from oldFolder to newFolder (OS-level rename, no I/O)
    const safeNewFolder = safeCacheFolderPath(newFolder)
    this._cacheManager = new EagleCacheManager(this.app, safeNewFolder)

    let movedFiles = 0
    try {
      const listed = await this.app.vault.adapter.list(oldFolder)
      await this._cacheManager.ensureCacheFolder()
      await Promise.allSettled(
        listed.files.map(async (srcPath) => {
          const fileName = srcPath.split('/').pop()
          const destPath = `${safeNewFolder}/${safePathSegment(fileName ?? 'image')}`
          try {
            await this.app.vault.adapter.rename(srcPath, destPath)
            movedFiles++
          } catch {
            this.log.warn('failed to move cache file', { srcPath })
          }
        }),
      )
      // Remove the now-empty old folder
      await this.app.vault.adapter.rmdir(oldFolder, false).catch(() => {/* ignore if not empty */})
    } catch {
      // oldFolder doesn't exist or is empty — that's fine
    }

    this.notices.show('cache_renamed', {
      newFolder: safeNewFolder,
      linksCount: updatedLinks,
      filesCount: updatedFiles,
      movedFiles,
    })
  }

  resolveTargetEagleFolderForActiveFile(): string | undefined {
    const activeFilePath = this.app.workspace.getActiveFile()?.path ?? null
    const mappedFolderName = resolveMappedEagleFolder(activeFilePath, this.settings.folderMappings)
    if (mappedFolderName) {
      return mappedFolderName
    }

    const fallbackFolderName = this.settings.eagleFolderName.trim()
    return fallbackFolderName || undefined
  }
}
