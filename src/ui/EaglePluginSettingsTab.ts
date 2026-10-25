/* global require -- Obsidian runs in Electron's Node context; require() is available at runtime */
import {
  App,
  ButtonComponent,
  DropdownComponent,
  EventRef,
  Notice,
  PluginSettingTab,
  Setting,
  TextComponent,
  TFolder,
} from 'obsidian'

import type EaglePlugin from '../main'

import { resolveDestinationPreview, sanitizeFolderMappings } from '../domain/folder-mapping'
import { ObsidianEagleFolderMapping } from '../domain/settings'
import { PluginLogger } from '../shared/plugin-logger'
import { EagleFolderWithPath } from './EagleUploader'
import RenameCacheModal from './RenameCacheModal'
import VaultFolderSuggestModal from './VaultFolderSuggestModal'

type EagleFolderList = EagleFolderWithPath[]

function resolveVaultFolderPath(folder: TFolder): string {
  return folder.path === '/' ? '' : folder.path
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const clamped = Math.min(i, units.length - 1)
  const value = bytes / Math.pow(1024, clamped)
  return `${value % 1 === 0 ? value.toString() : value.toFixed(1)} ${units[clamped]}`
}

export default class EaglePluginSettingsTab extends PluginSettingTab {
  plugin: EaglePlugin
  private readonly log = new PluginLogger('Eagle')
  private originalCacheFolderName = ''
  private previewDescEl: HTMLElement | null = null
  private leafChangeRef: EventRef | null = null

  constructor(app: App, plugin: EaglePlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  override display(): void {
    const { containerEl } = this

    this.originalCacheFolderName = this.plugin.settings.cacheFolderName

    containerEl.empty()

    // ── Connection ──────────────────────────────────────────────────────────
    new Setting(containerEl).setHeading().setName('Connection')

    const statusBadge = containerEl.createDiv({ cls: 'eagle-connection-status', text: '○ checking…' })

    new Setting(containerEl)
      .setName('Eagle API host')
      .setDesc('The host for your running eagle instance.')
      .addText((text) =>
        text
          .setPlaceholder('Localhost')
          .setValue(this.plugin.settings.eagleHost)
          .onChange((value) => {
            this.plugin.settings.eagleHost = value
            void this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('Eagle API port')
      .setDesc('The port for your running eagle instance.')
      .addText((text) =>
        text
          .setPlaceholder('41595')
          .setValue(this.plugin.settings.eaglePort.toString())
          .onChange((value) => {
            this.plugin.settings.eaglePort = value ? Number.parseInt(value) : 41595
            void this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Verify that eagle is reachable with the current host and port.')
      .addButton((btn) => {
        btn.setButtonText('Test connection').onClick(async () => {
          btn.setDisabled(true)
          btn.setButtonText('Testing…')
          const connected = await this.plugin.eagleUploader.isConnected()
          this.updateConnectionBadge(statusBadge, connected)
          if (connected) {
            this.plugin.notices.show('connection_ok')
          } else {
            this.plugin.notices.show('connection_fail')
          }
          btn.setDisabled(false)
          btn.setButtonText('Test connection')
        })
      })

    // ── Upload ───────────────────────────────────────────────────────────────
    new Setting(containerEl).setHeading().setName('Upload')

    const folderSetting = new Setting(containerEl)
      .setName('Eagle folder name')
      .setDesc(
        'The folder name in eagle where images will be saved. Leave empty to save to the default folder.',
      )

    folderSetting.addText((text) =>
      text
        .setPlaceholder('Obsidian')
        .setValue(this.plugin.settings.eagleFolderName)
        .onChange((value) => {
          this.plugin.settings.eagleFolderName = value
          void this.plugin.saveSettings()
          this.updatePreviewDesc()
        }),
    )

    new Setting(containerEl)
      .setName('Item name template')
      .setDesc(
        'Name given to each uploaded item in Eagle. Available tokens: {originalName} (filename without extension), {noteName} (active note), {date} (YYYY-MM-DD), {uuid} (short random ID). Falls back to {originalName} if empty.',
      )
      .addText((text) =>
        text
          .setPlaceholder('{uuid}_{noteName}')
          .setValue(this.plugin.settings.uploadItemNameTemplate)
          .onChange((value) => {
            this.plugin.settings.uploadItemNameTemplate = value
            void this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('Deduplicate uploads')
      .setDesc('Skip uploading images that already exist in eagle (matched by file hash).')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deduplicateUploads)
          .onChange(async (value) => {
            this.plugin.settings.deduplicateUploads = value
            await this.plugin.saveSettings()
          }),
      )

    // Fetch Eagle folders once; used by Upload dropdown + Folder Mapping rows
    const eagleFoldersPromise = this.fetchEagleFolders(statusBadge)

    void eagleFoldersPromise.then((folders) => {
      if (folders.length > 0) {
        this.upgradeToFolderDropdown(folderSetting, folders)
      }
    })

    // ── Cache ────────────────────────────────────────────────────────────────
    new Setting(containerEl).setHeading().setName('Cache')

    let cacheTextComponent: TextComponent

    new Setting(containerEl)
      .setName('Cache folder')
      .setDesc(
        "Images are cached here (supports subfolders: '80. References/07. Eagle'). After renaming, confirm to move existing images.",
      )
      .addText((text) => {
        cacheTextComponent = text
        text
          .setPlaceholder('Eagle-cache')
          .setValue(this.plugin.settings.cacheFolderName)
          .onChange((value) => {
            this.plugin.settings.cacheFolderName = value.trim() || 'eagle-cache'
            void this.plugin.saveSettings()
          })
      })
      .addButton((btn) => {
        btn.setButtonText('Browse').onClick(() => {
          new VaultFolderSuggestModal(this.app, (folder: TFolder) => {
            this.plugin.settings.cacheFolderName = resolveVaultFolderPath(folder) || 'eagle-cache'
            void this.plugin.saveSettings()
            cacheTextComponent.setValue(this.plugin.settings.cacheFolderName)
          }).open()
        })
      })

    // ── Cache health ─────────────────────────────────────────────────────────
    const healthSetting = new Setting(containerEl)
      .setName('Cache status')
      .setDesc('Loading...')
      .addButton((btn) =>
        btn.setButtonText('Refresh').onClick(async () => {
          btn.setDisabled(true)
          await refreshCacheStats()
          btn.setDisabled(false)
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Open folder').onClick(() => {
          const adapter = this.app.vault.adapter as { getBasePath?: () => string }
          const basePath = typeof adapter.getBasePath === 'function' ? adapter.getBasePath() : ''
          if (!basePath) return
          const folderPath = `${basePath}/${this.plugin.settings.cacheFolderName}`
          // eslint-disable-next-line @typescript-eslint/no-require-imports -- electron must be loaded via require() in Obsidian's Node context; types not installed
          const { shell } = require('electron') as { shell: { openPath: (path: string) => Promise<string> } }
          void shell.openPath(folderPath)
        }),
      )

    const refreshCacheStats = async () => {
      const stats = await this.plugin.cacheManager.getCacheStats()
      healthSetting.setDesc(`${stats.fileCount} files, ${formatBytes(stats.totalSizeBytes)}`)
    }

    void refreshCacheStats()

    // ── Folder Mapping ───────────────────────────────────────────────────────
    this.renderFolderMappingsSection(containerEl, eagleFoldersPromise)

    // ── Destination Preview ──────────────────────────────────────────────────
    this.renderDestinationPreview(containerEl)

    // ── Search ───────────────────────────────────────────────────────────────
    new Setting(containerEl).setHeading().setName('Search')

    new Setting(containerEl)
      .setName('Search debounce delay')
      .setDesc('How long to wait after typing before triggering a search (ms).')
      .addSlider((slider) =>
        slider
          .setLimits(100, 1000, 50)
          .setValue(this.plugin.settings.searchDebounceMs)
          .onChange((value) => {
            this.plugin.settings.searchDebounceMs = value
            void this.plugin.saveSettings()
          }),
      )

    // ── Debug ─────────────────────────────────────────────────────────────────
    new Setting(containerEl).setHeading().setName('Debug')

    new Setting(containerEl)
      .setName('Search diagnostics')
      .setDesc('Log search/thumbnail resolution details to the dev console.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugSearchDiagnostics)
          .onChange((value) => {
            this.plugin.settings.debugSearchDiagnostics = value
            void this.plugin.saveSettings()
          }),
      )
  }

  private updateConnectionBadge(badge: HTMLElement, connected: boolean): void {
    badge.removeClass('is-connected', 'is-disconnected')
    if (connected) {
      badge.addClass('is-connected')
      badge.setText('● connected')
    } else {
      badge.addClass('is-disconnected')
      badge.setText('● disconnected')
    }
  }

  private async fetchEagleFolders(badge?: HTMLElement): Promise<EagleFolderList> {
    try {
      const folders = await this.plugin.eagleUploader.listFolders()
      if (badge) this.updateConnectionBadge(badge, true)
      return folders
    } catch (err) {
      if (badge) this.updateConnectionBadge(badge, false)
      if (!(err instanceof Error && err.message.includes('connect'))) {
        this.log.error('unexpected error while loading folder list', err)
      }
      return []
    }
  }

  private upgradeToFolderDropdown(folderSetting: Setting, folders: EagleFolderList): void {
    if (!folderSetting.settingEl.isConnected) return
    folderSetting.controlEl.empty()
    folderSetting.addDropdown((dropdown) => {
      dropdown.addOption('', '— default folder —')
      for (const folder of folders) {
        dropdown.addOption(folder.path, folder.path)
      }
      const currentValue = this.plugin.settings.eagleFolderName
      const exists = folders.some((f) => f.path === currentValue)
      if (currentValue && !exists) {
        dropdown.addOption(currentValue, currentValue)
      }
      dropdown.setValue(currentValue)
      dropdown.onChange((value) => {
        this.plugin.settings.eagleFolderName = value
        void this.plugin.saveSettings()
        this.updatePreviewDesc()
      })
    })
  }

  private renderFolderMappingsSection(
    containerEl: HTMLElement,
    eagleFoldersPromise: Promise<EagleFolderList>,
  ): void {
    new Setting(containerEl).setHeading().setName('Folder mapping (Obsidian → eagle)')
    containerEl.createEl('p', {
      cls: 'eagle-folder-mapping-description',
      text: 'Route uploads by active note folder. Longest matching folder rule is applied.',
    })

    const listContainer = containerEl.createDiv({ cls: 'eagle-folder-mapping-list' })

    const renderRows = () => {
      listContainer.empty()

      if (this.plugin.settings.folderMappings.length === 0) {
        listContainer.createEl('p', {
          cls: 'eagle-folder-mapping-empty',
          text: 'No mappings yet. Add one to route specific Obsidian folders to eagle folders.',
        })
        return
      }

      this.plugin.settings.folderMappings.forEach((mapping, index) => {
        this.renderFolderMappingRow(listContainer, mapping, index, renderRows, eagleFoldersPromise)
      })
    }

    renderRows()

    const actionsContainer = containerEl.createDiv({ cls: 'eagle-folder-mapping-actions' })
    new ButtonComponent(actionsContainer)
      .setButtonText('Add mapping')
      .setCta()
      .onClick(() => {
        this.plugin.settings.folderMappings.push({ obsidianFolder: '', eagleFolder: '' })
        void this.plugin.saveSettings()
        renderRows()
        this.updatePreviewDesc()
      })
  }

  private renderFolderMappingRow(
    listContainer: HTMLElement,
    mapping: ObsidianEagleFolderMapping,
    index: number,
    onRemoved: () => void,
    eagleFoldersPromise: Promise<EagleFolderList>,
  ): void {
    const row = listContainer.createDiv({ cls: 'eagle-folder-mapping-row' })

    // ── Obsidian folder: text + Browse ──────────────────────────────────────
    const obsidianInput = new TextComponent(row)
      .setPlaceholder('Obsidian folder (e.g. Projects/design)')
      .setValue(mapping.obsidianFolder)
      .onChange((newValue) => {
        const m = this.plugin.settings.folderMappings[index]
        if (!m) return
        m.obsidianFolder = newValue
        void this.plugin.saveSettings()
        this.updatePreviewDesc()
      })
    obsidianInput.inputEl.addClass('eagle-folder-mapping-input')

    new ButtonComponent(row)
      .setButtonText('Browse')
      .setTooltip('Pick vault folder')
      .onClick(() => {
        new VaultFolderSuggestModal(this.app, (folder: TFolder) => {
          const m = this.plugin.settings.folderMappings[index]
          if (!m) return
          m.obsidianFolder = resolveVaultFolderPath(folder)
          obsidianInput.setValue(m.obsidianFolder)
          void this.plugin.saveSettings()
          this.updatePreviewDesc()
        }).open()
      })

    // ── Eagle folder: container holds text input, upgraded to dropdown when Eagle resolves ──
    const eagleControlDiv = row.createDiv({ cls: 'eagle-folder-control' })

    const eagleInput = new TextComponent(eagleControlDiv)
      .setPlaceholder('Eagle folder (e.g. Design)')
      .setValue(mapping.eagleFolder)
      .onChange((newValue) => {
        const m = this.plugin.settings.folderMappings[index]
        if (!m) return
        m.eagleFolder = newValue
        void this.plugin.saveSettings()
        this.updatePreviewDesc()
      })
    eagleInput.inputEl.addClass('eagle-folder-mapping-input')

    void eagleFoldersPromise.then((folders) => {
      if (!row.isConnected || folders.length === 0) return

      const m = this.plugin.settings.folderMappings[index]
      if (!m) return

      eagleControlDiv.empty()
      const dropdown = new DropdownComponent(eagleControlDiv)
      dropdown.selectEl.addClass('eagle-folder-mapping-input')

      dropdown.addOption('', '— pick eagle folder —')
      for (const f of folders) {
        dropdown.addOption(f.path, f.path)
      }

      const currentValue = m.eagleFolder
      if (currentValue && !folders.some((f) => f.path === currentValue)) {
        dropdown.addOption(currentValue, currentValue)
      }

      dropdown.setValue(currentValue)
      dropdown.onChange((value) => {
        const cur = this.plugin.settings.folderMappings[index]
        if (!cur) return
        cur.eagleFolder = value
        void this.plugin.saveSettings()
        this.updatePreviewDesc()
      })
    })

    // ── Remove button ────────────────────────────────────────────────────────
    new ButtonComponent(row)
      .setIcon('trash')
      .setTooltip('Remove mapping')
      .onClick(() => {
        this.plugin.settings.folderMappings.splice(index, 1)
        void this.plugin.saveSettings()
        onRemoved()
        this.updatePreviewDesc()
      })
  }

  private renderDestinationPreview(containerEl: HTMLElement): void {
    if (this.leafChangeRef) {
      this.app.workspace.offref(this.leafChangeRef)
      this.leafChangeRef = null
    }

    new Setting(containerEl).setHeading().setName('Destination preview')

    const setting = new Setting(containerEl)
      .setName('Current upload destination')
      .setDesc('Open a note to see where uploads from that note would land.')

    this.previewDescEl = setting.descEl

    this.updatePreviewDesc()

    this.leafChangeRef = this.app.workspace.on('active-leaf-change', () => {
      this.updatePreviewDesc()
    })
  }

  private updatePreviewDesc(): void {
    if (!this.previewDescEl) return

    const activeFile = this.app.workspace.getActiveFile()
    if (!activeFile) {
      this.previewDescEl.setText('Open a note to see the preview.')
      return
    }

    const { settings } = this.plugin
    const { noteFolderPath, matchedEagleFolder, matchedObsidianRule } = resolveDestinationPreview(
      activeFile.path,
      settings.folderMappings,
    )

    const notePath = noteFolderPath || '(vault root)'
    this.previewDescEl.empty()

    if (matchedEagleFolder && matchedObsidianRule) {
      this.previewDescEl.createSpan({ text: `Note folder: ${notePath}` })
      this.previewDescEl.createEl('br')
      this.previewDescEl.createSpan({ text: `Eagle folder: ${matchedEagleFolder}` })
      this.previewDescEl.createEl('br')
      this.previewDescEl.createSpan({ text: `Matched rule: ${matchedObsidianRule} → ${matchedEagleFolder}` })
      return
    }

    const fallback = settings.eagleFolderName.trim()
    this.previewDescEl.createSpan({ text: `Note folder: ${notePath}` })
    this.previewDescEl.createEl('br')
    this.previewDescEl.createSpan({ text: `Eagle folder: ${fallback || '(Eagle default folder)'}` })
    this.previewDescEl.createEl('br')
    this.previewDescEl.createSpan({ text: 'Matched rule: default folder' })
  }

  override hide() {
    if (this.leafChangeRef) {
      this.app.workspace.offref(this.leafChangeRef)
      this.leafChangeRef = null
    }
    this.previewDescEl = null

    const before = this.plugin.settings.folderMappings.length
    this.plugin.settings.folderMappings = sanitizeFolderMappings(
      this.plugin.settings.folderMappings,
    )
    const removed = before - this.plugin.settings.folderMappings.length
    if (removed > 0) {
      new Notice(`Eagle: removed ${removed} incomplete folder mapping(s)`)
    }
    void this.plugin.saveSettings()

    const newFolder = this.plugin.settings.cacheFolderName
    if (this.originalCacheFolderName && newFolder !== this.originalCacheFolderName) {
      new RenameCacheModal(
        this.plugin.app,
        this.originalCacheFolderName,
        newFolder,
        () => void this.plugin.renameCache(this.originalCacheFolderName, newFolder),
      ).open()
      this.originalCacheFolderName = newFolder
    }
  }
}
