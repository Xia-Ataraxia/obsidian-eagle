import { Canvas } from 'obsidian'

import type EaglePlugin from '../main'

import { buildPasteEventCopy } from '../utils/events'
import { allFilesAreImages } from '../utils/FileList'
import ImageUploadBlockingModal from './ImageUploadBlockingModal'

export function createEagleCanvasPasteHandler(
  plugin: EaglePlugin,
  originalPasteHandler: (e: ClipboardEvent) => Promise<void>,
) {
  return function (this: { canvas: Canvas }, e: ClipboardEvent) {
    return eagleCanvasPaste.call(this, plugin, originalPasteHandler, e)
  }
}

async function eagleCanvasPaste(
  this: { canvas: Canvas },
  plugin: EaglePlugin,
  originalPasteHandler: (e: ClipboardEvent) => Promise<void>,
  e: ClipboardEvent,
) {
  const files = e.clipboardData?.files
  if (!files || !allFilesAreImages(files) || files.length != 1) {
    await originalPasteHandler.call(this, e)
    return
  }

  const canvas: Canvas = this.canvas

  try {
    await uploadImageOnCanvas(canvas, plugin, buildPasteEventCopy(e, files))
  } catch {
    await originalPasteHandler.call(this, e)
  }
}

async function uploadImageOnCanvas(
  canvas: Canvas,
  plugin: EaglePlugin,
  e: ClipboardEvent,
): Promise<void> {
  const file = e.clipboardData?.files[0]
  if (!file) return

  const modal = new ImageUploadBlockingModal(plugin.app)
  modal.open()

  const controller = new AbortController()
  modal.onCancel = () => {
    controller.abort()
  }

  const folderName = plugin.resolveTargetEagleFolderForActiveFile()

  try {
    const { fileUrl, itemId } = await plugin.eagleUploader.upload(file, { folderName, signal: controller.signal })

    if (!modal.isOpen) return

    modal.close()
    pasteRemoteImageToCanvas(canvas, itemId, fileUrl)
  } catch (err: unknown) {
    modal.close()
    if (err instanceof DOMException && err.name === 'AbortError') {
      return
    }
    throw err
  }
}

function pasteRemoteImageToCanvas(canvas: Canvas, itemId: string, imageUrl: string) {
  canvas.createTextNode({
    pos: canvas.posCenter(),
    position: 'center',
    text: `![eagle:${itemId}](${imageUrl})`,
  })
}
