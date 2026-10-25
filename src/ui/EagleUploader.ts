import { tmpdir } from 'os'

import { App, requestUrl } from 'obsidian'

import type { NodeDataAdapter, NodeErrnoException } from '../types/obsidian'

import EagleApiError from '../domain/EagleApiError'
import { EaglePluginSettings } from '../domain/settings'
import { PluginLogger } from '../utils/plugin-logger'
import { safeDisplayName, safeImageExtension } from '../utils/eagle-path-contract'
import { extractFileExtension } from '../utils/image-format'
import { generatePseudoRandomId } from '../utils/pseudo-random'
import {
  EagleAddFromPathRequest,
  EagleApiStringDataResponse,
  EagleCreateFolderRequest,
  EagleCreateFolderResponse,
  EagleFolderListNodePayload,
  EagleFolderListResponse,
  EagleItemInfoResponse,
  EagleLibraryInfoResponse,
  EagleRawItemCandidate,
  EagleSearchItemsPayload,
  EagleSearchItemsResponse,
} from './eagle-api-payloads'
import type {
  EagleFolderWithPath,
  EagleItemSearchOptions,
  EagleItemSearchResult,
  EagleUploadOptions,
  EagleUploadResult,
} from './eagle-uploader-types'
import { normalizeEagleApiPathToFileUrl, resolveEagleThumbnailUrl } from './file-url'

export type {
  EagleFolderWithPath,
  EagleItemSearchOptions,
  EagleItemSearchResult,
  EagleSearchPickerUploader,
  EagleUploadOptions,
  EagleUploadResult,
} from './eagle-uploader-types'

const EAGLE_API_ENDPOINTS = {
  ADD_FROM_PATH: '/api/item/addFromPath',
  THUMBNAIL: '/api/item/thumbnail',
  FOLDER_LIST: '/api/folder/list',
  FOLDER_CREATE: '/api/folder/create',
  ITEM_LIST: '/api/item/list',
  ITEM_INFO: '/api/item/info',
  LIBRARY_INFO: '/api/library/info',
} as const

const EAGLE_PROCESSING_DELAY_MS = 300
const EAGLE_URL_PROTOCOL = 'eagle://item/'
const CONNECTION_ERROR_HINT =
  'Cannot connect to Eagle. Make sure Eagle is running and API host/port are correct.'

interface EagleFolderTreeNode {
  id: string
  name: string
  children?: EagleFolderTreeNode[]
}

export default class EagleUploader {
  private readonly log = new PluginLogger('Eagle')
  private readonly app: App
  private readonly settings: EaglePluginSettings
  private folderIdCache: Map<string, string> = new Map<string, string>()
  private folderIdInFlight: Map<string, Promise<string>> = new Map<string, Promise<string>>()
  private readonly fileUrlCache = new Map<string, string>()
  private readonly fileUrlInFlight = new Map<string, Promise<string>>()

  constructor(app: App, settings: EaglePluginSettings) {
    this.app = app
    this.settings = settings
  }

  private async requestJson(url: string, method: 'GET' | 'POST', body?: string, signal?: AbortSignal): Promise<unknown> {
    try {
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError')

      const headers = method === 'POST'
        ? { 'Content-Type': 'application/json' }
        : undefined

      const resp = await requestUrl({
        url,
        method,
        headers,
        body,
        throw: false,
      })

      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError')

      if (resp.status < 200 || resp.status >= 300) {
        const responseMessage = this.extractResponseMessage(resp.json)
          || this.extractTextMessage(resp)
          || `${resp.status} Unknown Error`
        throw new EagleApiError(responseMessage)
      }

      return resp.json
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      if (error instanceof EagleApiError) {
        throw error
      }

      const message = this.normalizeRequestError(error)
      throw new EagleApiError(`${CONNECTION_ERROR_HINT} ${message}`)
    }
  }

  private extractTextMessage(resp: { text?: unknown }): string {
    if (typeof resp.text === 'string' && resp.text.trim()) {
      return resp.text.trim()
    }
    return ''
  }

  private extractResponseMessage(payload: unknown): string {
    if (!payload || typeof payload !== 'object') return ''
    if ('message' in payload && typeof payload.message === 'string' && payload.message.trim()) {
      return payload.message.trim()
    }
    return ''
  }

  private isObjectRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
  }

  private parseStringDataResponse(payload: unknown): EagleApiStringDataResponse {
    if (!this.isObjectRecord(payload)) {
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

  private parseItemInfoResponse(payload: unknown): EagleItemInfoResponse {
    if (!this.isObjectRecord(payload)) {
      return { status: 'error' }
    }

    const rawData = payload['data']
    const data = this.isObjectRecord(rawData)
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

  private parseLibraryInfoResponse(payload: unknown): EagleLibraryInfoResponse {
    if (!this.isObjectRecord(payload)) {
      return { status: 'error' }
    }

    const rawData = payload['data']
    const library = this.isObjectRecord(rawData) && this.isObjectRecord(rawData['library'])
      ? {
          path: typeof rawData['library']['path'] === 'string' ? rawData['library']['path'] : undefined,
        }
      : undefined

    return {
      status: typeof payload['status'] === 'string' ? payload['status'] : 'error',
      data: library ? { library } : undefined,
    }
  }

  private parseCreateFolderResponse(payload: unknown): EagleCreateFolderResponse {
    if (!this.isObjectRecord(payload)) {
      return {}
    }

    const rawData = payload['data']

    return {
      status: typeof payload['status'] === 'string' ? payload['status'] : undefined,
      message: typeof payload['message'] === 'string' ? payload['message'] : undefined,
      data: this.isObjectRecord(rawData) && typeof rawData['id'] === 'string'
        ? { id: rawData['id'] }
        : undefined,
    }
  }

  private parseFolderListNode(folder: unknown): EagleFolderTreeNode {
    if (!this.isObjectRecord(folder)) {
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
        ? this.parseFolderList(children)
        : undefined,
    }
  }

  private parseFolderListResponse(payload: unknown): EagleFolderListResponse {
    if (!this.isObjectRecord(payload)) {
      return {}
    }

    const data = payload['data']

    return {
      status: typeof payload['status'] === 'string' ? payload['status'] : undefined,
      message: typeof payload['message'] === 'string' ? payload['message'] : undefined,
      data: Array.isArray(data)
        ? data.map((node): EagleFolderListNodePayload =>
            this.isObjectRecord(node)
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

  private parseSearchItemCandidate(payload: unknown): EagleRawItemCandidate | null {
    if (!this.isObjectRecord(payload)) {
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

  private parseSearchItemsPayload(payload: unknown): EagleSearchItemsPayload | undefined {
    if (!this.isObjectRecord(payload)) {
      return undefined
    }

    const items = Array.isArray(payload['items'])
      ? payload['items']
          .map((item) => this.parseSearchItemCandidate(item))
          .filter((item): item is EagleRawItemCandidate => item !== null)
      : undefined

    const data = Array.isArray(payload['data'])
      ? payload['data']
          .map((item) => this.parseSearchItemCandidate(item))
          .filter((item): item is EagleRawItemCandidate => item !== null)
      : undefined

    return {
      items,
      data,
    }
  }

  private parseSearchItemsResponse(payload: unknown): EagleSearchItemsResponse {
    if (!this.isObjectRecord(payload)) {
      return {}
    }

    const rawData = payload['data']
    const data = Array.isArray(rawData)
      ? rawData
          .map((item) => this.parseSearchItemCandidate(item))
          .filter((item): item is EagleRawItemCandidate => item !== null)
      : this.parseSearchItemsPayload(rawData)

    return {
      status: typeof payload['status'] === 'string' ? payload['status'] : undefined,
      message: typeof payload['message'] === 'string' ? payload['message'] : undefined,
      data,
    }
  }

  private normalizeRequestError(error: unknown): string {
    let rawMessage = ''
    if (error instanceof Error) {
      rawMessage = error.message
    } else if (typeof error === 'string') {
      rawMessage = error
    }
    return rawMessage ? `(${rawMessage})` : ''
  }

  async upload(image: File, options?: EagleUploadOptions): Promise<EagleUploadResult> {
    const signal = options?.signal
    const tempFilePath = await this.saveToTempFile(image)

    try {
      const targetFolderName = options?.folderName?.trim() || this.settings.eagleFolderName.trim()

      let folderId: string | undefined
      if (targetFolderName) {
        folderId = await this.ensureFolderExists(targetFolderName, signal)
      }

      const itemId = await this.addToEagle(tempFilePath, folderId, signal, options?.displayName)

      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError')

      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          window.clearTimeout(timer)
          reject(new DOMException('Upload cancelled', 'AbortError'))
        }
        const timer = window.setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, EAGLE_PROCESSING_DELAY_MS)
        signal?.addEventListener('abort', onAbort, { once: true })
      })

      const fileUrl = await this.getFileUrlForItemId(itemId, signal)
      const extFromUrl = fileUrl.startsWith('file://') ? extractFileExtension(fileUrl) : ''
      const ext = safeImageExtension(extFromUrl || extractFileExtension(image.name))
      return { itemId, fileUrl, ext }
    } finally {
      const fs = (this.app.vault?.adapter as unknown as NodeDataAdapter)?.fs
      if (fs?.unlink) {
        fs.unlink(tempFilePath, (err: NodeErrnoException | null) => {
          if (err && err.code !== 'ENOENT') {
            this.log.warn('failed to delete temp file', { tempFilePath, code: err.code, message: err.message })
          }
        })
      }
    }
  }

  private async saveToTempFile(image: File): Promise<string> {
    const tempFileName = `eagle-temp-${generatePseudoRandomId()}.${safeImageExtension(extractFileExtension(image.name))}`
    const adapter = this.app.vault.adapter as unknown as NodeDataAdapter
    const osTempDir = tmpdir()
    const tempFilePath = adapter.path.join(osTempDir, tempFileName)
    const arrayBuffer = await image.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    return new Promise((resolve, reject) => {
      adapter.fs.writeFile(tempFilePath, buffer, (err: NodeErrnoException | null) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
          return
        }
        resolve(tempFilePath)
      })
    })
  }

  private async addToEagle(filePath: string, folderId: string | undefined, signal?: AbortSignal, displayName?: string): Promise<string> {
    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.ADD_FROM_PATH}`

    const nameFromPath = filePath.split('/').pop() || 'image'
    const body: EagleAddFromPathRequest = {
      path: filePath,
      name: safeDisplayName(displayName || nameFromPath),
      annotation: 'Added via Obsidian Eagle Plugin',
    }

    if (folderId) {
      body.folderId = folderId
    }

    const data = this.parseStringDataResponse(await this.requestJson(url, 'POST', JSON.stringify(body), signal))

    if (data?.status !== 'success') {
      const errorMsg = data?.message || 'Unknown error'
      throw new EagleApiError(errorMsg)
    }

    if (typeof data?.data !== 'string') {
      throw new EagleApiError('Eagle API returned invalid upload response')
    }

    return data.data
  }

  /**
   * Resolve a renderable file:// URL for an Eagle item.
   *
   * Search results already contain `filePath`; use it directly to avoid an
   * extra thumbnail API call.  Falls back to the thumbnail API only when
   * `filePath` is absent (e.g. for update-paths flow where only the itemId is
   * known).
   */
  async resolveFileUrl(item: EagleItemSearchResult): Promise<string> {
    if (item.filePath) {
      return normalizeEagleApiPathToFileUrl(item.filePath)
    }
    return this.getFileUrlForItemId(item.id)
  }

  resolveSearchThumbnailUrl(rawThumbnail: string): string {
    const { eagleHost, eaglePort } = this.settings
    return resolveEagleThumbnailUrl(rawThumbnail, eagleHost, eaglePort)
  }

  async getFileUrlForItemId(itemId: string, signal?: AbortSignal): Promise<string> {
    const cached = this.fileUrlCache.get(itemId)
    if (cached) return cached

    const inFlight = this.fileUrlInFlight.get(itemId)
    if (inFlight !== undefined) return inFlight

    const promise = this.fetchFileUrlForItemId(itemId, signal)
      .then((url) => {
        if (url.startsWith('file://')) {
          this.fileUrlCache.set(itemId, url)
        }
        return url
      })
      .finally(() => {
        this.fileUrlInFlight.delete(itemId)
      })

    this.fileUrlInFlight.set(itemId, promise)
    return promise
  }

  // Use item info to get exact name + extension.
  // The thumbnail endpoint always returns .png thumbnails regardless of the original
  // file format, so deriving the original path from the thumbnail path gives the wrong
  // extension for non-PNG originals (e.g. .jpg files would resolve as .png).
  private async fetchFileUrlForItemId(itemId: string, signal?: AbortSignal): Promise<string> {
    const { eagleHost, eaglePort } = this.settings
    const infoUrl = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.ITEM_INFO}?id=${itemId}`
    const infoData = this.parseItemInfoResponse(await this.requestJson(infoUrl, 'GET', undefined, signal))

    if (infoData?.status !== 'success') {
      this.log.warn('item/info returned non-success', { itemId, status: infoData?.status })
    } else if (!infoData.data?.name || !infoData.data?.ext) {
      this.log.warn('item/info response missing name/ext', { itemId })
    } else {
      const { name, ext } = infoData.data
      const libraryRoot = await this.getLibraryRootPath(signal)
      if (!libraryRoot) {
        this.log.warn('cannot resolve library root — falling back to eagle:// URL', { itemId })
      } else {
        const filePath = `${libraryRoot}/images/${itemId}.info/${name}.${ext}`
        return normalizeEagleApiPathToFileUrl(filePath)
      }
    }

    return `${EAGLE_URL_PROTOCOL}${itemId}`
  }

  async getLibraryRootPath(signal?: AbortSignal): Promise<string | null> {
    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.LIBRARY_INFO}`
    const data = this.parseLibraryInfoResponse(await this.requestJson(url, 'GET', undefined, signal))
    return data?.data?.library?.path ?? null
  }

  /**
   * Returns a file:// URL pointing to the Eagle-generated thumbnail image.
   * Used for displaying preview images in the picker modal without extra processing.
   */
  async getThumbnailFileUrl(itemId: string): Promise<string> {
    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.THUMBNAIL}?id=${itemId}`

    const data = this.parseStringDataResponse(await this.requestJson(url, 'GET'))

    if (data?.status === 'success' && typeof data?.data === 'string') {
      return normalizeEagleApiPathToFileUrl(data.data)
    }

    throw new EagleApiError(`Cannot load thumbnail for item ${itemId}`)
  }

  private async listFoldersRaw(signal?: AbortSignal): Promise<EagleFolderTreeNode[]> {
    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.FOLDER_LIST}`

    const data = this.parseFolderListResponse(await this.requestJson(url, 'GET', undefined, signal))

    if (data?.status === 'success' && Array.isArray(data?.data)) {
      return this.parseFolderList(data.data)
    }

    throw new EagleApiError('Failed to list folders')
  }

  private parseFolderList(raw: ReadonlyArray<unknown>): EagleFolderTreeNode[] {
    return raw.map((folder) => this.parseFolderListNode(folder))
  }

  private flattenFolderTree(folders: EagleFolderTreeNode[], parentPath = ''): EagleFolderWithPath[] {
    const result: EagleFolderWithPath[] = []
    for (const folder of folders) {
      const path = parentPath ? `${parentPath}/${folder.name}` : folder.name
      result.push({ id: folder.id, name: folder.name, path })
      if (folder.children?.length) {
        result.push(...this.flattenFolderTree(folder.children, path))
      }
    }
    return result
  }

  async createFolder(name: string, signal?: AbortSignal, parentId?: string): Promise<string> {
    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.FOLDER_CREATE}`

    const body: EagleCreateFolderRequest = { folderName: name }
    if (parentId) body.parent = parentId

    const data = this.parseCreateFolderResponse(await this.requestJson(url, 'POST', JSON.stringify(body), signal))

    if (data?.status === 'success' && typeof data.data?.id === 'string') {
      return data.data.id
    }

    throw new EagleApiError('Failed to create folder')
  }

  async ensureFolderExists(name: string, signal?: AbortSignal): Promise<string> {
    const cached = this.folderIdCache.get(name)
    if (cached !== undefined) return cached

    const inFlight = this.folderIdInFlight.get(name)
    if (inFlight !== undefined) return inFlight

    const resolvePromise = this.resolveFolderId(name, signal)
      .then((folderId) => {
        this.folderIdCache.set(name, folderId)
        return folderId
      })
      .finally(() => {
        this.folderIdInFlight.delete(name)
      })

    this.folderIdInFlight.set(name, resolvePromise)
    return resolvePromise
  }

  private async resolveFolderId(name: string, signal?: AbortSignal): Promise<string> {
    const rawFolders = await this.listFoldersRaw(signal)
    const flat = this.flattenFolderTree(rawFolders)

    // Match strategy:
    // 1. Full path — slash-separated input like "Resources/Obsidian" maps to a truly nested folder.
    // 2. Root name — simple input like "Obsidian" maps to a top-level folder (no parent).
    // Falls through to create missing folder(s).
    const byPath = flat.find((f) => f.path === name)
    if (byPath) return byPath.id

    const byName = flat.find((f) => f.name === name && !f.path.includes('/'))
    if (byName) return byName.id

    if (!name.includes('/')) {
      return this.createFolder(name, signal)
    }

    // Recursively create nested folder structure (e.g. "Resources/Obsidian")
    return this.createNestedFolders(name, flat, signal)
  }

  private async createNestedFolders(
    path: string,
    flat: EagleFolderWithPath[],
    signal?: AbortSignal,
  ): Promise<string> {
    const segments = path.split('/')
    let lastId = ''
    let parentId: string | undefined
    let currentPath = ''

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment
      const existing = flat.find((f) => f.path === currentPath)
      if (existing) {
        lastId = existing.id
        parentId = existing.id
      } else {
        lastId = await this.createFolder(segment, signal, parentId)
        parentId = lastId
        flat.push({ id: lastId, name: segment, path: currentPath })
      }
    }

    return lastId
  }

  async listFolders(): Promise<EagleFolderWithPath[]> {
    const rawFolders = await this.listFoldersRaw()
    return this.flattenFolderTree(rawFolders)
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.getLibraryRootPath()
      return true
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- String() is intentional fallback for unknown catch value
      this.log.debug('isConnected check failed', { err: String(err) })
      return false
    }
  }

  /**
   * Returns the display name of the Eagle item, or `null` if it cannot be resolved
   * (Eagle unreachable, item missing, or name field absent).
   */
  async getItemName(itemId: string): Promise<string | null> {
    try {
      const { eagleHost, eaglePort } = this.settings
      const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.ITEM_INFO}?id=${itemId}`
      const data = this.parseItemInfoResponse(await this.requestJson(url, 'GET'))
      return (data.status === 'success' && data.data?.name) ? data.data.name : null
    } catch {
      return null
    }
  }

  /**
   * Returns `true` if the item exists and is not deleted, `false` if confirmed absent,
   * or `null` if the check failed (Eagle unreachable, network error, server error).
   * Callers must NOT evict cached files when this returns `null`.
   */
  async itemExists(itemId: string): Promise<boolean | null> {
    try {
      const { eagleHost, eaglePort } = this.settings
      const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.ITEM_INFO}?id=${itemId}`
      const data = this.parseItemInfoResponse(await this.requestJson(url, 'GET'))
      return data.status === 'success' && !data.data?.isDeleted
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string -- String() is intentional fallback for unknown catch value
      this.log.debug('itemExists check failed — treating as uncertain', { itemId, err: String(err) })
      return null
    }
  }

  private firstNonEmptyStringValue(
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

  private extractThumbnailCandidate(candidate: EagleRawItemCandidate): string | undefined {
    return this.firstNonEmptyStringValue(candidate, [
      'thumbnail',
      'thumb',
      'thumbnailPath',
      'preview',
      'previewPath',
    ])
  }

  private isSearchItemsPayload(value: unknown): value is EagleSearchItemsPayload {
    return this.isObjectRecord(value)
  }

  private extractSearchItemsData(data: EagleSearchItemsResponse['data']): EagleRawItemCandidate[] {
    if (Array.isArray(data)) {
      return data
    }

    if (this.isSearchItemsPayload(data)) {
      if (Array.isArray(data.items)) {
        return data.items
      }

      if (Array.isArray(data.data)) {
        return data.data
      }
    }

    return []
  }

  async searchItems({
    keyword,
    limit = 200,
    orderBy,
    offset = 0,
  }: EagleItemSearchOptions): Promise<EagleItemSearchResult[]> {
    const trimmedKeyword = keyword.trim()
    if (!trimmedKeyword) return []

    const params = new URLSearchParams({
      keyword: trimmedKeyword,
      offset: String(offset),
    })

    params.set('limit', String(limit))

    if (orderBy) {
      params.set('orderBy', orderBy)
    }

    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.ITEM_LIST}?${params.toString()}`

    const data = this.parseSearchItemsResponse(await this.requestJson(url, 'GET'))
    if (data?.status !== 'success') {
      const errorMsg = data?.message || 'Failed to search Eagle items'
      throw new EagleApiError(errorMsg)
    }

    const rawItems = this.extractSearchItemsData(data.data)

    return rawItems
      .map((candidate) => {
        if (!candidate.id) {
          return null
        }

        let tags: string[] | undefined
        if (Array.isArray(candidate.tags)) {
          tags = candidate.tags.filter((tag): tag is string => typeof tag === 'string')
        } else if (typeof candidate.tags === 'string') {
          tags = candidate.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
        }

        return {
          id: candidate.id,
          name: candidate.name || candidate.id,
          ext: candidate.ext,
          tags,
          annotation: candidate.annotation,
          isDeleted: candidate.isDeleted,
          filePath: candidate.filePath,
          thumbnail: this.extractThumbnailCandidate(candidate),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }
}
