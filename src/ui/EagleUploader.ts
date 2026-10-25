import { tmpdir } from 'os'

import { App, requestUrl } from 'obsidian'

import type { NodeDataAdapter, NodeErrnoException } from '../types/obsidian'

import EagleApiError from '../domain/EagleApiError'
import { EaglePluginSettings } from '../domain/settings'
import { type EagleFolderTreeNode, extractResponseMessage, extractSearchItemsData, extractTextMessage, extractThumbnailCandidate, flattenFolderTree, normalizeRequestError, parseCreateFolderResponse, parseFolderList, parseFolderListResponse, parseItemInfoResponse, parseLibraryInfoResponse, parseSearchItemsResponse, parseStringDataResponse } from '../utils/eagle-response-parsers'
import { PluginLogger } from '../utils/plugin-logger'
import { safeDisplayName, safeImageExtension } from '../utils/eagle-path-contract'
import { extractFileExtension } from '../utils/image-format'
import { generatePseudoRandomId } from '../utils/pseudo-random'
import type { EagleAddFromPathRequest, EagleCreateFolderRequest } from '../types/eagle-api-payloads'
import type {
  EagleFolderWithPath,
  EagleItemSearchOptions,
  EagleItemSearchResult,
  EagleUploadOptions,
  EagleUploadResult,
} from '../types/eagle-uploader-types'
import { normalizeEagleApiPathToFileUrl, resolveEagleThumbnailUrl } from './file-url'

export type {
  EagleFolderWithPath,
  EagleItemSearchOptions,
  EagleItemSearchResult,
  EagleSearchPickerUploader,
  EagleUploadOptions,
  EagleUploadResult,
} from '../types/eagle-uploader-types'

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
        const responseMessage = extractResponseMessage(resp.json)
          || extractTextMessage(resp)
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

      const message = normalizeRequestError(error)
      throw new EagleApiError(`${CONNECTION_ERROR_HINT} ${message}`)
    }
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

    const data = parseStringDataResponse(await this.requestJson(url, 'POST', JSON.stringify(body), signal))

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
    const infoData = parseItemInfoResponse(await this.requestJson(infoUrl, 'GET', undefined, signal))

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
    const data = parseLibraryInfoResponse(await this.requestJson(url, 'GET', undefined, signal))
    return data?.data?.library?.path ?? null
  }

  /**
   * Returns a file:// URL pointing to the Eagle-generated thumbnail image.
   * Used for displaying preview images in the picker modal without extra processing.
   */
  async getThumbnailFileUrl(itemId: string): Promise<string> {
    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.THUMBNAIL}?id=${itemId}`

    const data = parseStringDataResponse(await this.requestJson(url, 'GET'))

    if (data?.status === 'success' && typeof data?.data === 'string') {
      return normalizeEagleApiPathToFileUrl(data.data)
    }

    throw new EagleApiError(`Cannot load thumbnail for item ${itemId}`)
  }

  private async listFoldersRaw(signal?: AbortSignal): Promise<EagleFolderTreeNode[]> {
    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.FOLDER_LIST}`

    const data = parseFolderListResponse(await this.requestJson(url, 'GET', undefined, signal))

    if (data?.status === 'success' && Array.isArray(data?.data)) {
      return parseFolderList(data.data)
    }

    throw new EagleApiError('Failed to list folders')
  }

  async createFolder(name: string, signal?: AbortSignal, parentId?: string): Promise<string> {
    const { eagleHost, eaglePort } = this.settings
    const url = `http://${eagleHost}:${eaglePort}${EAGLE_API_ENDPOINTS.FOLDER_CREATE}`

    const body: EagleCreateFolderRequest = { folderName: name }
    if (parentId) body.parent = parentId

    const data = parseCreateFolderResponse(await this.requestJson(url, 'POST', JSON.stringify(body), signal))

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
    const flat = flattenFolderTree(rawFolders)

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
    return flattenFolderTree(rawFolders)
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.getLibraryRootPath()
      return true
    } catch (err) {
       
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
      const data = parseItemInfoResponse(await this.requestJson(url, 'GET'))
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
      const data = parseItemInfoResponse(await this.requestJson(url, 'GET'))
      return data.status === 'success' && !data.data?.isDeleted
    } catch (err) {
       
      this.log.debug('itemExists check failed — treating as uncertain', { itemId, err: String(err) })
      return null
    }
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

    const data = parseSearchItemsResponse(await this.requestJson(url, 'GET'))
    if (data?.status !== 'success') {
      const errorMsg = data?.message || 'Failed to search Eagle items'
      throw new EagleApiError(errorMsg)
    }

    const rawItems = extractSearchItemsData(data.data)

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
          thumbnail: extractThumbnailCandidate(candidate),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }
}
