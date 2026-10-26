import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, HASH_STORE_KEY, settingsForPersist, settingsFromSavedData } from '../src/domain/settings'

describe(settingsFromSavedData, () => {
  it('keeps the hash store out of settings so saving settings cannot overwrite it', () => {
    const settings = settingsFromSavedData({ eaglePort: 1234, [HASH_STORE_KEY]: { version: 1, entries: {} } })
    expect(settings.eaglePort).toBe(1234)
    expect(HASH_STORE_KEY in settings).toBe(false)
  })

  it('falls back to defaults for missing or empty data', () => {
    expect(settingsFromSavedData(null)).toEqual(DEFAULT_SETTINGS)
    expect(settingsFromSavedData({}).cacheFolderName).toBe('eagle-cache')
  })
})

describe(settingsForPersist, () => {
  it('drops incomplete mapping rows from the saved copy without touching live settings', () => {
    const live = {
      ...DEFAULT_SETTINGS,
      folderMappings: [
        { obsidianFolder: '', eagleFolder: '' },
        { obsidianFolder: 'Projects', eagleFolder: 'Design' },
      ],
    }
    const saved = settingsForPersist(live)
    expect(saved.folderMappings).toEqual([{ obsidianFolder: 'Projects', eagleFolder: 'Design' }])
    expect(live.folderMappings).toHaveLength(2)
  })
})
