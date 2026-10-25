/* global require -- Obsidian runs in Electron's Node context; require() is available at runtime */
import {
  App,
  DropdownComponent,
  Notice,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TextComponent,
  TFolder,
} from 'obsidian'

import type EaglePlugin from '../main'

import { resolveDestinationPreview, sanitizeFolderMappings } from '../domain/folder-mapping'
import { ObsidianEagleFolderMapping } from '../domain/settings'
import { PluginLogger } from '../utils/plugin-logger'
import { EagleFolderWithPath } from './EagleUploader'
import EagleCacheManager from './EagleCacheManager'
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
  private originalCacheFolderName: string
  private previewDescEl: HTMLElement | null = null
  private statusBadge: HTMLElement | null = null
  private foldersPromise: Promise<EagleFolderList> | null = null

  constructor(app: App, plugin: EaglePlugin) {
    super(app, plugin)
    this.plugin = plugin
    this.originalCacheFolderName = plugin.settings.cacheFolderName
  }

  override getControlValue(key: string): unknown {
    return this.plugin.settings[key]
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    this.plugin.settings[key] = value
    await this.plugin.saveSettings()
    if (key === 'eagleFolderName') this.updatePreviewDesc()
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: 'group',
        heading: 'Connection',
        items: [
          { name: 'Eagle API host', desc: 'The host for your running Eagle instance.', control: { type: 'text', key: 'eagleHost', placeholder: 'Localhost' } },
          { name: 'Eagle API port', desc: 'The port for your running Eagle instance.', control: { type: 'number', key: 'eaglePort', placeholder: '41595', min: 1, max: 65535, defaultValue: 41595 } },
          { name: 'Test connection', desc: 'Verify that eagle is reachable with the current host and port.', render: (setting) => this.renderConnectionTest(setting) },
        ],
      },
      {
        type: 'group',
        heading: 'Upload',
        items: [
          { name: 'Eagle folder name', desc: 'The folder name in eagle where images will be saved. Leave empty to save to the default folder.', render: (setting) => this.renderEagleFolderName(setting) },
          { name: 'Item name template', desc: 'Name given to each uploaded item in Eagle. Available tokens: {originalName} (filename without extension), {noteName} (active note), {date} (YYYY-MM-DD), {uuid} (short random ID). Falls back to {originalName} if empty.', control: { type: 'text', key: 'uploadItemNameTemplate', placeholder: '{uuid}_{noteName}' } },
          { name: 'Deduplicate uploads', desc: 'Skip uploading images that already exist in eagle (matched by file hash).', control: { type: 'toggle', key: 'deduplicateUploads' } },
        ],
      },
      {
        type: 'group',
        heading: 'Cache',
        items: [
          { name: 'Cache folder', desc: "Images are cached here (supports subfolders: '80. References/07. Eagle'). After renaming, confirm to move existing images.", render: (setting) => this.renderCacheFolder(setting) },
          { name: 'Cache status', desc: 'Loading...', render: (setting) => this.renderCacheStatus(setting) },
        ],
      },
      {
        type: 'list',
        heading: 'Folder mapping (Obsidian → eagle)',
        emptyState: 'No mappings yet. Add one to route specific Obsidian folders to eagle folders.',
        addItem: {
          name: 'Add mapping',
          action: () => {
            this.plugin.settings.folderMappings.push({ obsidianFolder: '', eagleFolder: '' })
            this.update()
          },
        },
        onDelete: (index) => {
          this.plugin.settings.folderMappings.splice(index, 1)
          this.update()
        },
        items: this.plugin.settings.folderMappings.map((mapping) => ({
          name: 'Folder mapping',
          render: (setting: Setting) => this.renderFolderMappingRow(setting, mapping),
        })),
      },
      {
        type: 'group',
        heading: 'Destination preview',
        items: [
          { name: 'Current upload destination', desc: 'Open a note to see where uploads from that note would land.', render: (setting) => this.renderDestinationPreview(setting) },
        ],
      },
      {
        type: 'group',
        heading: 'Search',
        items: [
          { name: 'Search debounce delay', desc: 'How long to wait after typing before triggering a search (ms).', control: { type: 'slider', key: 'searchDebounceMs', min: 100, max: 1000, step: 50 } },
        ],
      },
      {
        type: 'group',
        heading: 'Debug',
        items: [
          { name: 'Search diagnostics', desc: 'Log search/thumbnail resolution details to the dev console.', control: { type: 'toggle', key: 'debugSearchDiagnostics' } },
        ],
      },
    ]
  }

  private renderConnectionTest(setting: Setting): void {
    this.statusBadge = setting.controlEl.createSpan({ cls: 'eagle-connection-status', text: '○ checking…' })
    void this.eagleFolders()
    setting.addButton((btn) => {
      btn.setButtonText('Test connection').onClick(async () => {
        btn.setDisabled(true)
        btn.setButtonText('Testing…')
        const connected = await this.plugin.eagleUploader.isConnected()
        this.updateConnectionBadge(connected)
        this.plugin.notices.show(connected ? 'connection_ok' : 'connection_fail')
        btn.setDisabled(false)
        btn.setButtonText('Test connection')
      })
    })
  }

  private renderEagleFolderName(setting: Setting): void {
    setting.addText((text) =>
      text
        .setPlaceholder('Obsidian')
        .setValue(this.plugin.settings.eagleFolderName)
        .onChange((value) => void this.setControlValue('eagleFolderName', value)),
    )
    void this.eagleFolders().then((folders) => {
      if (folders.length === 0 || !setting.settingEl.isConnected) return
      setting.clear()
      setting.addDropdown((dropdown) => {
        const current = this.plugin.settings.eagleFolderName
        this.fillEagleFolderOptions(dropdown, folders, current, '— default folder —')
        dropdown.onChange((value) => void this.setControlValue('eagleFolderName', value))
      })
    })
  }

  private fillEagleFolderOptions(
    dropdown: DropdownComponent,
    folders: EagleFolderList,
    current: string,
    emptyLabel: string,
  ): void {
    dropdown.addOption('', emptyLabel)
    for (const folder of folders) dropdown.addOption(folder.path, folder.path)
    if (current && !folders.some((f) => f.path === current)) dropdown.addOption(current, current)
    dropdown.setValue(current)
  }

  private renderCacheFolder(setting: Setting): void {
    let input: TextComponent
    setting
      .addText((text) => {
        input = text
        text
          .setPlaceholder('Eagle-cache')
          .setValue(this.plugin.settings.cacheFolderName)
          .onChange((value) => void this.setControlValue('cacheFolderName', value.trim() || 'eagle-cache'))
      })
      .addButton((btn) => {
        btn.setButtonText('Browse').onClick(() => {
          new VaultFolderSuggestModal(this.app, (folder: TFolder) => {
            const path = resolveVaultFolderPath(folder) || 'eagle-cache'
            void this.setControlValue('cacheFolderName', path)
            input.setValue(path)
          }).open()
        })
      })
  }

  private renderCacheStatus(setting: Setting): void {
    const refresh = async () => {
      const stats = await this.plugin.cacheManager.getCacheStats()
      setting.setDesc(`${stats.fileCount} files, ${formatBytes(stats.totalSizeBytes)}`)
    }
    setting
      .addButton((btn) =>
        btn.setButtonText('Refresh').onClick(async () => {
          btn.setDisabled(true)
          await refresh()
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
    void refresh()
  }

  private renderFolderMappingRow(setting: Setting, mapping: ObsidianEagleFolderMapping): void {
    let obsidianInput: TextComponent
    setting
      .addText((text) => {
        obsidianInput = text
        text
          .setPlaceholder('Obsidian folder (e.g. Projects/design)')
          .setValue(mapping.obsidianFolder)
          .onChange((value) => {
            mapping.obsidianFolder = value
            this.updatePreviewDesc()
          })
      })
      .addButton((btn) =>
        btn
          .setButtonText('Browse')
          .setTooltip('Pick vault folder')
          .onClick(() => {
            new VaultFolderSuggestModal(this.app, (folder: TFolder) => {
              mapping.obsidianFolder = resolveVaultFolderPath(folder)
              obsidianInput.setValue(mapping.obsidianFolder)
              this.updatePreviewDesc()
            }).open()
          }),
      )
    setting.addText((text) =>
      text
        .setPlaceholder('Eagle folder (e.g. Design)')
        .setValue(mapping.eagleFolder)
        .onChange((value) => {
          mapping.eagleFolder = value
          this.updatePreviewDesc()
        }),
    )
    const eagleControl = setting.controlEl.lastElementChild
    void this.eagleFolders().then((folders) => {
      if (folders.length === 0 || !setting.settingEl.isConnected) return
      eagleControl?.remove()
      setting.addDropdown((dropdown) => {
        this.fillEagleFolderOptions(dropdown, folders, mapping.eagleFolder, '— pick eagle folder —')
        dropdown.onChange((value) => {
          mapping.eagleFolder = value
          this.updatePreviewDesc()
        })
      })
    })
  }

  private renderDestinationPreview(setting: Setting): () => void {
    this.previewDescEl = setting.descEl
    this.updatePreviewDesc()
    const ref = this.app.workspace.on('active-leaf-change', () => this.updatePreviewDesc())
    return () => {
      this.app.workspace.offref(ref)
      this.previewDescEl = null
    }
  }

  private eagleFolders(): Promise<EagleFolderList> {
    this.foldersPromise ??= this.fetchEagleFolders()
    return this.foldersPromise
  }

  private updateConnectionBadge(connected: boolean): void {
    const badge = this.statusBadge
    if (!badge) return
    badge.removeClass('is-connected', 'is-disconnected')
    if (connected) {
      badge.addClass('is-connected')
      badge.setText('● connected')
    } else {
      badge.addClass('is-disconnected')
      badge.setText('● disconnected')
    }
  }

  private async fetchEagleFolders(): Promise<EagleFolderList> {
    try {
      const folders = await this.plugin.eagleUploader.listFolders()
      this.updateConnectionBadge(true)
      return folders
    } catch (err) {
      this.updateConnectionBadge(false)
      if (!(err instanceof Error && err.message.includes('connect'))) {
        this.log.error('unexpected error while loading folder list', err)
      }
      return []
    }
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
    this.foldersPromise = null
    this.statusBadge = null

    const before = this.plugin.settings.folderMappings.length
    this.plugin.settings.folderMappings = sanitizeFolderMappings(
      this.plugin.settings.folderMappings,
    )
    const removed = before - this.plugin.settings.folderMappings.length
    if (removed > 0) {
      new Notice(`Eagle: removed ${removed} incomplete folder mapping(s)`)
    }
    void this.plugin.saveSettings()

    const oldFolder = this.originalCacheFolderName
    const newFolder = this.plugin.settings.cacheFolderName
    if (oldFolder && newFolder !== oldFolder) {
      new RenameCacheModal(
        this.plugin.app,
        oldFolder,
        newFolder,
        () => void this.plugin.renameCache(oldFolder, newFolder),
        () => { this.plugin.cacheManager = new EagleCacheManager(this.plugin.app, newFolder) },
      ).open()
    }
    this.originalCacheFolderName = newFolder
  }
}
