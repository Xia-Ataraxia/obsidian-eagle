import { describe, expect, it } from 'vitest'

import { canvasNodeSizeForImage } from '../src/utils/canvas-size'

describe('canvasNodeSizeForImage', () => {
  it('keeps the aspect ratio of a landscape image', () => {
    expect(canvasNodeSizeForImage(1600, 800)).toEqual({ width: 400, height: 200 })
  })
  it('caps tall images by height', () => {
    expect(canvasNodeSizeForImage(1000, 4000)).toEqual({ width: 125, height: 500 })
  })
  it('upscales small images to the max bound', () => {
    expect(canvasNodeSizeForImage(40, 20)).toEqual({ width: 400, height: 200 })
  })
  it('enforces a minimum side', () => {
    expect(canvasNodeSizeForImage(4000, 100).height).toBe(80)
  })
  it('falls back on invalid dimensions', () => {
    expect(canvasNodeSizeForImage(0, 10)).toEqual({ width: 400, height: 300 })
    expect(canvasNodeSizeForImage(NaN, 10)).toEqual({ width: 400, height: 300 })
  })
})
