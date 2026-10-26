import { sanitizeFolderMappings } from './folder-mapping'

export interface ObsidianEagleFolderMapping {
  obsidianFolder: string
  eagleFolder: string
}

export interface EaglePluginSettings {
  [key: string]: unknown
  eagleHost: string
  eaglePort: number
  eagleFolderName: string
  folderMappings: ObsidianEagleFolderMapping[]
  debugSearchDiagnostics: boolean
  cacheFolderName: string
  deduplicateUploads: boolean
  searchDebounceMs: number
  uploadItemNameTemplate: string
  /** Set once the legacy `{itemId}.{ext}` filename migration was attempted, so startup stops rescanning the vault for it. */
  legacyCacheNamesMigrated: boolean
  plugin_notices?: { muted: Record<string, boolean> }
}

/** data.json key owned by EagleHashStore; never part of settings. */
export const HASH_STORE_KEY = 'eagle-hash-store'

export const DEFAULT_SETTINGS: EaglePluginSettings = {
  eagleHost: 'localhost',
  eaglePort: 41595,
  eagleFolderName: '',
  folderMappings: [],
  debugSearchDiagnostics: false,
  cacheFolderName: 'eagle-cache',
  deduplicateUploads: true,
  searchDebounceMs: 300,
  uploadItemNameTemplate: '{uuid}_{noteName}',
  legacyCacheNamesMigrated: false,
}

export function settingsFromSavedData(raw: unknown): EaglePluginSettings {
  const { [HASH_STORE_KEY]: _hashStore, ...saved } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { ...DEFAULT_SETTINGS, ...(saved as Partial<EaglePluginSettings>) }
}

/** Persisted copy; the live settings keep in-progress (incomplete) mapping rows that the settings UI still edits. */
export function settingsForPersist(settings: EaglePluginSettings): EaglePluginSettings {
  return { ...settings, folderMappings: sanitizeFolderMappings(settings.folderMappings ?? []) }
}
