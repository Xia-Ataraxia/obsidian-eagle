import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '../src/domain/settings'
import EagleUploader from '../src/ui/EagleUploader'
import { __resetRequestUrlMock, __setRequestUrlMock } from './mocks/obsidian'

function successResponse(data: unknown) {
  return {
    status: 200,
    statusText: 'OK',
    json: {
      status: 'success',
      data,
    },
    text: '',
  }
}

function createUploaderForTest(): EagleUploader {
  return new EagleUploader({} as any, DEFAULT_SETTINGS)
}

describe(EagleUploader.name, () => {
  beforeEach(() => {
    __resetRequestUrlMock()
  })

  it('does not duplicate folder creation for concurrent same-name requests', async () => {
    let createCalls = 0
    let requestCalls = 0

    __setRequestUrlMock(async ({ url }: { url: string }) => {
      requestCalls += 1

      if (url.endsWith('/api/folder/list')) {
        await new Promise((resolve) => window.setTimeout(resolve, 10))
        return successResponse([])
      }

      if (url.endsWith('/api/folder/create')) {
        createCalls += 1
        await new Promise((resolve) => window.setTimeout(resolve, 20))
        return successResponse({ id: 'folder-1' })
      }

      throw new Error(`Unexpected request URL: ${url}`)
    })

    const uploader = createUploaderForTest()
    const [first, second, third] = await Promise.all([
      uploader.ensureFolderExists('Obsidian'),
      uploader.ensureFolderExists('Obsidian'),
      uploader.ensureFolderExists('Obsidian'),
    ])

    expect(first).toBe('folder-1')
    expect(second).toBe('folder-1')
    expect(third).toBe('folder-1')
    expect(createCalls).toBe(1)
    expect(requestCalls).toBe(2)
  })

  it('prefers upload option folderName over default setting', async () => {
    vi.useFakeTimers()

    const uploader = createUploaderForTest()
    const uploaderInternals = uploader as unknown as {
      saveToTempFile: (image: File) => Promise<string>
      ensureFolderExists: (name: string, signal?: AbortSignal) => Promise<string>
      addToEagle: (filePath: string, folderId: string | undefined, signal?: AbortSignal, displayName?: string) => Promise<string>
      getFileUrlForItemId: (itemId: string, signal?: AbortSignal) => Promise<string>
    }

    const saveSpy = vi.spyOn(uploaderInternals, 'saveToTempFile').mockResolvedValue('/tmp/test.png')
    const ensureSpy = vi.spyOn(uploaderInternals, 'ensureFolderExists').mockResolvedValue('mapped-folder-id')
    const addSpy = vi.spyOn(uploaderInternals, 'addToEagle').mockResolvedValue('item-1')
    const fileUrlSpy = vi
      .spyOn(uploaderInternals, 'getFileUrlForItemId')
      .mockResolvedValue('file:///Users/me/test.png')

    const uploadPromise = uploader.upload(new File([], 'test.png'), { folderName: 'Mapped Folder' })
    await vi.advanceTimersByTimeAsync(300)
    const result = await uploadPromise

    expect(saveSpy).toHaveBeenCalledOnce()
    expect(ensureSpy).toHaveBeenCalledWith('Mapped Folder', undefined)
    expect(addSpy).toHaveBeenCalledWith('/tmp/test.png', 'mapped-folder-id', undefined, undefined)
    expect(fileUrlSpy).toHaveBeenCalledWith('item-1', undefined)
    expect(result).toEqual({
      itemId: 'item-1',
      fileUrl: 'file:///Users/me/test.png',
      ext: 'png',
    })

    vi.useRealTimers()
  })
})
