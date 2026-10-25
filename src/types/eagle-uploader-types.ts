export interface EagleFolderWithPath {
  id: string
  name: string
  /** Slash-separated full path from the library root (e.g. "Resources/Obsidian"). Equal to `name` for root-level folders. No leading or trailing slash. */
  path: string
}

export interface EagleItemSearchOptions {
  keyword: string
  limit?: number
  orderBy?: string
  offset?: number
}

export interface EagleItemSearchResult {
  id: string
  name: string
  ext?: string
  tags?: string[]
  annotation?: string
  isDeleted?: boolean
  filePath?: string
  thumbnail?: string
}

export interface EagleUploadResult {
  itemId: string
  fileUrl: string
  ext: string
}

export interface EagleUploadOptions {
  folderName?: string
  signal?: AbortSignal
  displayName?: string
}

export interface EagleSearchPickerUploader {
  searchItems(options: EagleItemSearchOptions): Promise<EagleItemSearchResult[]>
  resolveSearchThumbnailUrl(rawThumbnail: string): string
  getThumbnailFileUrl(itemId: string): Promise<string>
}
