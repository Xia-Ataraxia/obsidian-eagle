export type EagleApiStatus = 'success' | 'error' | (string & {})

export interface EagleFolderListNodePayload {
  id?: unknown
  name?: unknown
  children?: unknown
}

export interface EagleApiStringDataResponse {
  status?: EagleApiStatus
  message?: string
  data?: string
}

export interface EagleFolderListResponse {
  status?: EagleApiStatus
  message?: string
  data?: EagleFolderListNodePayload[]
}

export interface EagleRawItemCandidate {
  id?: string
  name?: string
  ext?: string
  tags?: string | string[]
  annotation?: string
  isDeleted?: boolean
  filePath?: string
  thumbnail?: string
  thumb?: string
  thumbnailPath?: string
  preview?: string
  previewPath?: string
}

export interface EagleSearchItemsPayload {
  items?: EagleRawItemCandidate[]
  data?: EagleRawItemCandidate[]
}

export interface EagleSearchItemsResponse {
  status?: EagleApiStatus
  message?: string
  data?: EagleRawItemCandidate[] | EagleSearchItemsPayload
}

export interface EagleAddFromPathRequest {
  path: string
  name: string
  annotation: string
  folderId?: string
}

export interface EagleItemInfoPayload {
  name?: string
  ext?: string
  isDeleted?: boolean
}

export interface EagleItemInfoResponse {
  status: EagleApiStatus
  data?: EagleItemInfoPayload
}

export interface EagleLibraryInfoPayload {
  path?: string
}

export interface EagleLibraryInfoData {
  library?: EagleLibraryInfoPayload
}

export interface EagleLibraryInfoResponse {
  status: EagleApiStatus
  data?: EagleLibraryInfoData
}

export interface EagleCreateFolderRequest {
  folderName: string
  parent?: string
}

export interface EagleCreateFolderPayload {
  id?: string
}

export interface EagleCreateFolderResponse {
  status?: EagleApiStatus
  message?: string
  data?: EagleCreateFolderPayload
}
