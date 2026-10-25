import {
  Editor,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Plugin,
  TFile,
} from 'obsidian'

import EagleApiError from './domain/EagleApiError'
import { sanitizeFolderMappings } from './domain/folder-mapping'
import { DEFAULT_SETTINGS, EaglePluginSettings } from './domain/settings'
import { DebounceController } from './utils/debounce-controller'
import { PluginLogger } from './utils/plugin-logger'
import { NoticeCatalog, PluginNotices } from './ui/plugin-notices'
import { createEagleCanvasPasteHandler } from './ui/Canvas'
import EagleCacheManager from './ui/EagleCacheManager'
import EagleHashStore, { STORE_KEY } from './ui/EagleHashStore'
import EaglePluginSettingsTab from './ui/EaglePluginSettingsTab'
import EagleSearchPickerModal from './ui/EagleSearchPickerModal'
import EagleUploader, { type EagleItemSearchResult } from './ui/EagleUploader'
import { findLocalFileUnderCursor } from './ui/editor'
import { fileUrlToDisplayUrl, fileUrlToOsPath } from './ui/file-url'
import { renameCache } from './services/cache-rename'
import { CacheSyncService } from './services/cache-sync'
import { ImageMigrationService } from './services/image-migration'
import { UploadService } from './services/upload'
import { eagleItemIdFromAlt, eagleItemIdFromLink } from './utils/eagle-item-id'
import { safeCacheFolderPath } from './utils/eagle-path-contract'
import { extractFileExtension } from './utils/image-format'

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

export default class EaglePlugin extends Plugin {
  readonly log = new PluginLogger('Eagle')
  declare settings: EaglePluginSettings

  declare notices: PluginNotices

  private declare _eagleUploader: EagleUploader

  get eagleUploader(): EagleUploader {
    return this._eagleUploader
  }

  private declare _cacheManager: EagleCacheManager

  get cacheManager(): EagleCacheManager {
    return this._cacheManager
  }

  set cacheManager(manager: EagleCacheManager) {
    this._cacheManager = manager
  }

  private declare _hashStore: EagleHashStore

  get hashStore(): EagleHashStore {
    return this._hashStore
  }

  private readonly uploads = new UploadService(this)
  private readonly cacheSync = new CacheSyncService(this)
  private readonly imageMigration = new ImageMigrationService(this)
  private _lastSyncedFilePath: string | null = null
  private _pendingSyncFile: TFile | null = null
  private readonly syncDebounce = new DebounceController({
    delayMs: 500,
    onRun: async () => {
      const file = this._pendingSyncFile
      if (!file) return
      if (file.path === this._lastSyncedFilePath) return
      this._lastSyncedFilePath = file.path
      await this.cacheSync.syncCacheForFile(file).catch((err) => {
        this.log.error('syncCacheForFile failed', err)
      })
    },
  })

  private customPasteEventCallback = (e: ClipboardEvent) => {
    if (e.clipboardData) this.uploads.handleImageFiles(e.clipboardData.files, e)
  }

  private customDropEventListener = (e: DragEvent) => {
    if (e.dataTransfer) this.uploads.handleImageFiles(e.dataTransfer.files, e)
  }

  private eaglePluginRightClickHandler = (menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
    const localFile = findLocalFileUnderCursor(editor, view)
    const noteFile = view.file
    if (!localFile || !noteFile) return

    menu.addItem((item) =>
      item
        .setTitle('Upload to Eagle')
        .setIcon('upload')
        .onClick(() => {
          void this.uploads.doUploadLocalImage({ image: localFile, editor, noteFile })
        }),
    )
  }

  private async loadSettings() {
    // data.json also holds the hash store; keep it out of settings so saveSettings() can't overwrite newer entries with this stale copy.
    const { [STORE_KEY]: _hashStore, ...saved } = ((await this.loadData()) as Record<string, unknown> | null) ?? {}
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(saved as Partial<EaglePluginSettings>),
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
    await this.cacheSync.migrateCacheFilesToReadableNames().catch((err) => {
      this.log.error('cache filename migration failed', err)
    })
    this.setupEagleHandlers()
    this.addUploadLocalCommand()
    this.addImportFromEagleLibraryCommand()
    this.addMigrateAllImagesCommand()
    this.registerEagleImageRenderer()
    void this.cacheSync.lazySyncEagleCache().catch((err) => {
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

  private readonly wrappedCanvasViews = new WeakSet<CanvasView>()

  private overridePasteHandlerForCanvasView(view: CanvasView) {
    // active-leaf-change fires on every activation; wrap once or each layer retries the upload.
    if (this.wrappedCanvasViews.has(view)) return
    this.wrappedCanvasViews.add(view)
    const originalPasteFn = view.handlePaste
    view.handlePaste = createEagleCanvasPasteHandler(this, originalPasteFn)
    this.register(() => {
      view.handlePaste = originalPasteFn
    })
  }

  private addUploadLocalCommand() {
    this.addCommand({
      id: 'upload-local',
      name: 'Upload to Eagle',
      editorCheckCallback: this.editorCheckCallbackForLocalUpload,
    })
  }

  private addImportFromEagleLibraryCommand() {
    this.addCommand({
      id: 'import-from-library',
      name: 'Insert image from Eagle (search)',
      editorCheckCallback: this.editorCheckCallbackForLibraryImport,
    })
  }

  private addMigrateAllImagesCommand() {
    this.addCommand({
      id: 'migrate-all-images',
      name: 'Migrate all images to eagle-cache',
      callback: () => {
        void this.imageMigration.migrateAllImages()
      },
    })
  }

  private registerEagleImageRenderer(): void {
    this.registerMarkdownPostProcessor((el) => {
      // Backward-compat: recover old-format ![eagle:ID](...) images
      el.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
        const itemId =
          eagleItemIdFromAlt(img.alt) ??
          eagleItemIdFromLink(img.getAttribute('src') ?? '')
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
    const noteFile = ctx.file
    if (!localFile || !noteFile) return false
    if (checking) return true

    void this.uploads.doUploadLocalImage({ image: localFile, editor, noteFile })
    return true
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
      const markdownImage = this.uploads.markdownImageFor(item.id, ext, displayName)
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

  resolveTargetEagleFolderForActiveFile(): string | undefined {
    return this.uploads.resolveTargetEagleFolderForActiveFile()
  }

  renameCache(oldFolder: string, newFolder: string): Promise<void> {
    return renameCache(this, oldFolder, newFolder)
  }
}
