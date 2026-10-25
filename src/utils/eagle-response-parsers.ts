import EagleApiError from '../domain/EagleApiError'
import type {
  EagleApiStringDataResponse,
  EagleCreateFolderResponse,
  EagleFolderListNodePayload,
  EagleFolderListResponse,
  EagleItemInfoResponse,
  EagleLibraryInfoResponse,
  EagleRawItemCandidate,
  EagleSearchItemsPayload,
  EagleSearchItemsResponse,
} from '../types/eagle-api-payloads'
import type { EagleFolderWithPath } from '../types/eagle-uploader-types'

export interface EagleFolderTreeNode {
  id: string
  name: string
  children?: EagleFolderTreeNode[]
}

export function extractTextMessage(resp: { text?: unknown }): string {
  if (typeof resp.text === 'string' && resp.text.trim()) {
    return resp.text.trim()
  }
  return ''
}

export function extractResponseMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  if ('message' in payload && typeof payload.message === 'string' && payload.message.trim()) {
    return payload.message.trim()
  }
  return ''
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

export function parseStringDataResponse(payload: unknown): EagleApiStringDataResponse {
  if (!isObjectRecord(payload)) {
    return {}
  }

  const status = payload['status']
  const message = payload['message']
  const data = payload['data']

  return {
    status: typeof status === 'string' ? status : undefined,
    message: typeof message === 'string' ? message : undefined,
    data: typeof data === 'string' ? data : undefined,
  }
}

export function parseItemInfoResponse(payload: unknown): EagleItemInfoResponse {
  if (!isObjectRecord(payload)) {
    return { status: 'error' }
  }

  const rawData = payload['data']
  const data = isObjectRecord(rawData)
    ? {
        name: typeof rawData['name'] === 'string' ? rawData['name'] : undefined,
        ext: typeof rawData['ext'] === 'string' ? rawData['ext'] : undefined,
        isDeleted: typeof rawData['isDeleted'] === 'boolean' ? rawData['isDeleted'] : undefined,
      }
    : undefined

  return {
    status: typeof payload['status'] === 'string' ? payload['status'] : 'error',
    data,
  }
}

export function parseLibraryInfoResponse(payload: unknown): EagleLibraryInfoResponse {
  if (!isObjectRecord(payload)) {
    return { status: 'error' }
  }

  const rawData = payload['data']
  const library = isObjectRecord(rawData) && isObjectRecord(rawData['library'])
    ? {
        path: typeof rawData['library']['path'] === 'string' ? rawData['library']['path'] : undefined,
      }
    : undefined

  return {
    status: typeof payload['status'] === 'string' ? payload['status'] : 'error',
    data: library ? { library } : undefined,
  }
}

export function parseCreateFolderResponse(payload: unknown): EagleCreateFolderResponse {
  if (!isObjectRecord(payload)) {
    return {}
  }

  const rawData = payload['data']

  return {
    status: typeof payload['status'] === 'string' ? payload['status'] : undefined,
    message: typeof payload['message'] === 'string' ? payload['message'] : undefined,
    data: isObjectRecord(rawData) && typeof rawData['id'] === 'string'
      ? { id: rawData['id'] }
      : undefined,
  }
}

export function parseFolderListNode(folder: unknown): EagleFolderTreeNode {
  if (!isObjectRecord(folder)) {
    throw new EagleApiError('Eagle API returned invalid folder list payload')
  }

  const id = folder['id']
  const name = folder['name']
  const children = folder['children']

  if (typeof id !== 'string' || typeof name !== 'string') {
    throw new EagleApiError('Eagle API returned invalid folder payload')
  }

  return {
    id,
    name,
    children: Array.isArray(children)
      ? parseFolderList(children)
      : undefined,
  }
}

export function parseFolderListResponse(payload: unknown): EagleFolderListResponse {
  if (!isObjectRecord(payload)) {
    return {}
  }

  const data = payload['data']

  return {
    status: typeof payload['status'] === 'string' ? payload['status'] : undefined,
    message: typeof payload['message'] === 'string' ? payload['message'] : undefined,
    data: Array.isArray(data)
      ? data.map((node): EagleFolderListNodePayload =>
          isObjectRecord(node)
            ? {
                id: node['id'],
                name: node['name'],
                children: node['children'],
              }
            : {},
        )
      : undefined,
  }
}

export function parseSearchItemCandidate(payload: unknown): EagleRawItemCandidate | null {
  if (!isObjectRecord(payload)) {
    return null
  }

  const tags = payload['tags']

  return {
    id: typeof payload['id'] === 'string' ? payload['id'] : undefined,
    name: typeof payload['name'] === 'string' ? payload['name'] : undefined,
    ext: typeof payload['ext'] === 'string' ? payload['ext'] : undefined,
    tags: Array.isArray(tags)
      ? tags.filter((tag): tag is string => typeof tag === 'string')
      : typeof tags === 'string'
        ? tags
        : undefined,
    annotation: typeof payload['annotation'] === 'string' ? payload['annotation'] : undefined,
    isDeleted: typeof payload['isDeleted'] === 'boolean' ? payload['isDeleted'] : undefined,
    filePath: typeof payload['filePath'] === 'string' ? payload['filePath'] : undefined,
    thumbnail: typeof payload['thumbnail'] === 'string' ? payload['thumbnail'] : undefined,
    thumb: typeof payload['thumb'] === 'string' ? payload['thumb'] : undefined,
    thumbnailPath: typeof payload['thumbnailPath'] === 'string' ? payload['thumbnailPath'] : undefined,
    preview: typeof payload['preview'] === 'string' ? payload['preview'] : undefined,
    previewPath: typeof payload['previewPath'] === 'string' ? payload['previewPath'] : undefined,
  }
}

export function parseSearchItemsPayload(payload: unknown): EagleSearchItemsPayload | undefined {
  if (!isObjectRecord(payload)) {
    return undefined
  }

  const items = Array.isArray(payload['items'])
    ? payload['items']
        .map((item) => parseSearchItemCandidate(item))
        .filter((item): item is EagleRawItemCandidate => item !== null)
    : undefined

  const data = Array.isArray(payload['data'])
    ? payload['data']
        .map((item) => parseSearchItemCandidate(item))
        .filter((item): item is EagleRawItemCandidate => item !== null)
    : undefined

  return {
    items,
    data,
  }
}

export function parseSearchItemsResponse(payload: unknown): EagleSearchItemsResponse {
  if (!isObjectRecord(payload)) {
    return {}
  }

  const rawData = payload['data']
  const data = Array.isArray(rawData)
    ? rawData
        .map((item) => parseSearchItemCandidate(item))
        .filter((item): item is EagleRawItemCandidate => item !== null)
    : parseSearchItemsPayload(rawData)

  return {
    status: typeof payload['status'] === 'string' ? payload['status'] : undefined,
    message: typeof payload['message'] === 'string' ? payload['message'] : undefined,
    data,
  }
}

export function normalizeRequestError(error: unknown): string {
  let rawMessage = ''
  if (error instanceof Error) {
    rawMessage = error.message
  } else if (typeof error === 'string') {
    rawMessage = error
  }
  return rawMessage ? `(${rawMessage})` : ''
}

export function parseFolderList(raw: ReadonlyArray<unknown>): EagleFolderTreeNode[] {
  return raw.map((folder) => parseFolderListNode(folder))
}

export function flattenFolderTree(folders: EagleFolderTreeNode[], parentPath = ''): EagleFolderWithPath[] {
  const result: EagleFolderWithPath[] = []
  for (const folder of folders) {
    const path = parentPath ? `${parentPath}/${folder.name}` : folder.name
    result.push({ id: folder.id, name: folder.name, path })
    if (folder.children?.length) {
      result.push(...flattenFolderTree(folder.children, path))
    }
  }
  return result
}

export function firstNonEmptyStringValue(
  candidate: EagleRawItemCandidate,
  keys: ReadonlyArray<keyof EagleRawItemCandidate>,
): string | undefined {
  for (const key of keys) {
    const value = candidate[key]
    if (typeof value === 'string' && value.trim()) {
      return value
    }
  }
  return undefined
}

export function extractThumbnailCandidate(candidate: EagleRawItemCandidate): string | undefined {
  return firstNonEmptyStringValue(candidate, [
    'thumbnail',
    'thumb',
    'thumbnailPath',
    'preview',
    'previewPath',
  ])
}

export function isSearchItemsPayload(value: unknown): value is EagleSearchItemsPayload {
  return isObjectRecord(value)
}

export function extractSearchItemsData(data: EagleSearchItemsResponse['data']): EagleRawItemCandidate[] {
  if (Array.isArray(data)) {
    return data
  }

  if (isSearchItemsPayload(data)) {
    if (Array.isArray(data.items)) {
      return data.items
    }

    if (Array.isArray(data.data)) {
      return data.data
    }
  }

  return []
}
