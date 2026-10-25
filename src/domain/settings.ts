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
}

export function settingsFromSavedData(raw: unknown): EaglePluginSettings {
  const { [HASH_STORE_KEY]: _hashStore, ...saved } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return { ...DEFAULT_SETTINGS, ...(saved as Partial<EaglePluginSettings>) }
}
