export interface CanvasNodeSize {
  width: number
  height: number
}

const MAX_WIDTH = 400
const MAX_HEIGHT = 500
const MIN_WIDTH = 160
const MIN_HEIGHT = 40
const FALLBACK: CanvasNodeSize = { width: MAX_WIDTH, height: 300 }

/** Fits an image into a canvas node, never upscaling past 1x (except to MIN_WIDTH), keeping its aspect ratio. */
export function canvasNodeSizeForImage(imageWidth: number, imageHeight: number): CanvasNodeSize {
  if (!(imageWidth > 0) || !(imageHeight > 0) || !Number.isFinite(imageWidth + imageHeight)) return FALLBACK
  const scale = Math.min(1, MAX_WIDTH / imageWidth, MAX_HEIGHT / imageHeight)
  let width = Math.round(imageWidth * scale)
  if (width < MIN_WIDTH && (MIN_WIDTH * imageHeight) / imageWidth <= MAX_HEIGHT) width = MIN_WIDTH
  const height = Math.round((width * imageHeight) / imageWidth)
  return { width, height: Math.max(MIN_HEIGHT, height) }
}
