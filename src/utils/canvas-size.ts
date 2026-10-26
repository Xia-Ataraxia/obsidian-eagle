export interface CanvasNodeSize {
  width: number
  height: number
}

const MAX_WIDTH = 400
const MAX_HEIGHT = 500
const MIN_HEIGHT = 40
const FALLBACK: CanvasNodeSize = { width: MAX_WIDTH, height: 300 }

/** Fits an image into a canvas node, never upscaling past 1x, keeping its aspect ratio. */
export function canvasNodeSizeForImage(imageWidth: number, imageHeight: number): CanvasNodeSize {
  if (!(imageWidth > 0) || !(imageHeight > 0) || !Number.isFinite(imageWidth + imageHeight)) return FALLBACK
  const scale = Math.min(1, MAX_WIDTH / imageWidth, MAX_HEIGHT / imageHeight)
  const width = Math.round(imageWidth * scale)
  const height = Math.round((width * imageHeight) / imageWidth)
  return { width, height: Math.max(MIN_HEIGHT, height) }
}
