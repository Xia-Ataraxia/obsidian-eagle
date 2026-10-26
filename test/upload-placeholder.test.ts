import { describe, expect, it } from 'vitest'
import { generatePseudoRandomId } from '../src/utils/pseudo-random'
import { UPLOAD_PLACEHOLDER_PATTERN, uploadPlaceholderFor } from '../src/utils/upload-placeholder'

describe('upload placeholder', () => {
  it('matches every generated placeholder and nothing else', () => {
    const a = uploadPlaceholderFor(generatePseudoRandomId())
    const b = uploadPlaceholderFor(generatePseudoRandomId())
    const text = `before ${a}\n![real](img.png) ${b} ![Uploading to Eagle...x](y)`
    expect([...text.matchAll(UPLOAD_PLACEHOLDER_PATTERN)].map((m) => m[0])).toEqual([a, b])
  })
})
