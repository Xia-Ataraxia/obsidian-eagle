import { describe, expect, it } from 'vitest'

import { canvasNodeSizeForImage } from '../src/utils/canvas-size'

describe('canvasNodeSizeForImage', () => {
  it('keeps the aspect ratio of a landscape image', () => {
    expect(canvasNodeSizeForImage(1600, 800)).toEqual({ width: 400, height: 200 })
  })
  it('caps tall images by height', () => {
    expect(canvasNodeSizeForImage(1000, 4000)).toEqual({ width: 125, height: 500 })
  })
  it('never upscales past natural size', () => {
    expect(canvasNodeSizeForImage(300, 200)).toEqual({ width: 300, height: 200 })
    expect(canvasNodeSizeForImage(64, 48)).toEqual({ width: 64, height: 48 })
  })
  it('enforces a minimum height', () => {
    expect(canvasNodeSizeForImage(4000, 100).height).toBe(40)
  })
  it('falls back on invalid dimensions', () => {
    expect(canvasNodeSizeForImage(0, 10)).toEqual({ width: 400, height: 300 })
    expect(canvasNodeSizeForImage(NaN, 10)).toEqual({ width: 400, height: 300 })
  })
})
