import { Canvas, Point } from 'obsidian'

import type EaglePlugin from '../main'

import { buildPasteEventCopy } from '../utils/events'
import { canvasNodeSizeForImage } from '../utils/canvas-size'
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
    const size = await imageNodeSize(file)
    canvas.createTextNode({ pos: nextPastePos(canvas), size, position: 'center', text: `![eagle:${itemId}](${fileUrl})` })
  } catch (err: unknown) {
    modal.close()
    if (err instanceof DOMException && err.name === 'AbortError') {
      return
    }
    // The clipboard is empty once this handler has awaited, so the original handler cannot recover the image; keep it in the vault.
    plugin.log.warn('Eagle upload failed on canvas, saving locally', { err: err instanceof Error ? err.message : String(err) })
    const saved = await plugin.saveImageLocally(file)
    canvas.createFileNode({ pos: nextPastePos(canvas), size: await imageNodeSize(file), position: 'center', file: saved })
    plugin.notices.show('saved_locally')
  }
}

async function imageNodeSize(file: File) {
  try {
    const bitmap = await createImageBitmap(file)
    const size = canvasNodeSizeForImage(bitmap.width, bitmap.height)
    bitmap.close()
    return size
  } catch {
    return canvasNodeSizeForImage(0, 0)
  }
}

const CASCADE_STEP = 28
const lastPaste = new WeakMap<Canvas, { center: Point; pos: Point }>()

/** Repeated pastes at the same viewport center cascade diagonally instead of stacking. */
function nextPastePos(canvas: Canvas): Point {
  const center = canvas.posCenter()
  const last = lastPaste.get(canvas)
  const sameView = last && last.center.x === center.x && last.center.y === center.y
  const pos = sameView ? { x: last.pos.x + CASCADE_STEP, y: last.pos.y + CASCADE_STEP } : center
  lastPaste.set(canvas, { center, pos })
  return pos
}
