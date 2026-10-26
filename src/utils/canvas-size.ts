export interface CanvasNodeSize {
  width: number
  height: number
}

const MAX_WIDTH = 400
const MAX_HEIGHT = 500
const MIN_SIDE = 80
const FALLBACK: CanvasNodeSize = { width: MAX_WIDTH, height: 300 }

/** Fits an image into a canvas node bounded by MAX_WIDTH x MAX_HEIGHT, keeping its aspect ratio. */
export function canvasNodeSizeForImage(imageWidth: number, imageHeight: number): CanvasNodeSize {
  if (!(imageWidth > 0) || !(imageHeight > 0) || !Number.isFinite(imageWidth + imageHeight)) return FALLBACK
  const scale = Math.min(MAX_WIDTH / imageWidth, MAX_HEIGHT / imageHeight)
  return {
    width: Math.max(MIN_SIDE, Math.round(imageWidth * scale)),
    height: Math.max(MIN_SIDE, Math.round(imageHeight * scale)),
  }
}
