const HEIC_SIGNATURE_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm'])
const HEIF_SIGNATURE_BRANDS = new Set(['mif1', 'msf1'])
const AVIF_SIGNATURE_BRANDS = new Set(['avif'])

const RENDERABLE_IMAGE_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'bmp', 'webp', 'svg'])

const KNOWN_IMAGE_EXTENSIONS = new Set([
  'gif',
  'heic',
  'heif',
  'avif',
  'ico',
  'jpg',
  'jpeg',
  'png',
  'bmp',
  'tif',
  'tiff',
  'svg',
  'webp',
])

export type ImageFormatDetectionSource = 'signature' | 'mime' | 'extension' | 'fallback'

export interface ImageFormatInfo {
  extension: string
  mimeType: string
  source: ImageFormatDetectionSource
  renderable: boolean
  recognized: boolean
}

const BYTE_TO_TEXT_DECODER = new TextDecoder('ascii')

function readText(bytes: Uint8Array, start: number, length: number) {
  if (start + length > bytes.length) return ''

  return BYTE_TO_TEXT_DECODER.decode(bytes.slice(start, start + length))
}

function normalizeExtension(extension: string) {
  return extension.toLowerCase().trim()
}

function detectBySignature(bytes: Uint8Array): { extension: string; mimeType: string } | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' }
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { extension: 'png', mimeType: 'image/png' }
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x39 || bytes[4] === 0x37) &&
    bytes[5] === 0x61
  ) {
    return { extension: 'gif', mimeType: 'image/gif' }
  }

  if (
    bytes.length >= 12 &&
    readText(bytes, 0, 4) === 'RIFF' &&
    readText(bytes, 8, 4) === 'WEBP'
  ) {
    return { extension: 'webp', mimeType: 'image/webp' }
  }

  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { extension: 'bmp', mimeType: 'image/bmp' }
  }

  if (bytes.length >= 12 && readText(bytes, 4, 4) === 'ftyp') {
    const brand = readText(bytes, 8, 4).toLowerCase()

    if (HEIC_SIGNATURE_BRANDS.has(brand)) {
      return { extension: 'heic', mimeType: 'image/heic' }
    }
    if (HEIF_SIGNATURE_BRANDS.has(brand)) {
      return { extension: 'heif', mimeType: 'image/heif' }
    }
    if (AVIF_SIGNATURE_BRANDS.has(brand)) {
      return { extension: 'avif', mimeType: 'image/avif' }
    }
  }

  return null
}

function normalizeMimeType(mimeType: string) {
  return (mimeType || '').trim().toLowerCase().split(';')[0] ?? ''
}

function detectByMimeType(mimeType: string) {
  const normalizedMime = normalizeMimeType(mimeType)

  switch (normalizedMime) {
    case 'image/jpeg':
      return { extension: 'jpg', mimeType: normalizedMime }
    case 'image/png':
      return { extension: 'png', mimeType: normalizedMime }
    case 'image/gif':
      return { extension: 'gif', mimeType: normalizedMime }
    case 'image/bmp':
      return { extension: 'bmp', mimeType: normalizedMime }
    case 'image/webp':
      return { extension: 'webp', mimeType: normalizedMime }
    case 'image/svg+xml':
      return { extension: 'svg', mimeType: normalizedMime }
    case 'image/heic':
      return { extension: 'heic', mimeType: normalizedMime }
    case 'image/heif':
      return { extension: 'heif', mimeType: normalizedMime }
    case 'image/avif':
      return { extension: 'avif', mimeType: normalizedMime }
    default:
      return null
  }
}

function detectByExtension(fileName: string) {
  const extension = extractFileExtension(fileName)
  if (!extension) return null
  if (!KNOWN_IMAGE_EXTENSIONS.has(extension)) return null

  return { extension, mimeType: mimeTypeForImageExtension(extension) }
}

function mimeTypeForImageExtension(extension: string) {
  const normalized = normalizeExtension(extension)
  switch (normalized) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'bmp':
      return 'image/bmp'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'heic':
      return 'image/heic'
    case 'heif':
      return 'image/heif'
    case 'avif':
      return 'image/avif'
    case 'ico':
      return 'image/x-icon'
    case 'tif':
    case 'tiff':
      return 'image/tiff'
    default:
      return ''
  }
}

export function extractFileExtension(fileName: string) {
  const normalized = fileName.trim().toLowerCase()
  const lastDot = normalized.lastIndexOf('.')

  if (lastDot === -1 || lastDot === normalized.length - 1) {
    return ''
  }

  return normalized.slice(lastDot + 1)
}

export function isRenderableImageExtension(extension: string) {
  return RENDERABLE_IMAGE_EXTENSIONS.has(normalizeExtension(extension))
}

export function isKnownImageExtension(extension: string) {
  return KNOWN_IMAGE_EXTENSIONS.has(normalizeExtension(extension))
}

export function isLikelyImageFile(file: { type?: string; name: string }) {
  const mime = normalizeMimeType(file.type || '')
  if (mime.startsWith('image/')) return true

  return isKnownImageExtension(extractFileExtension(file.name))
}

export function replaceFileExtension(fileName: string, extension: string) {
  const normalizedName = fileName.trim()
  const lastDot = normalizedName.lastIndexOf('.')
  const hasDot = lastDot !== -1 && lastDot !== normalizedName.length - 1
  const normalizedExtension = normalizeExtension(extension)

  if (!hasDot) {
    if (!normalizedExtension) return normalizedName
    return `${normalizedName}.${normalizedExtension}`
  }

  if (!normalizedExtension) {
    return normalizedName
  }

  return `${normalizedName.slice(0, lastDot + 1)}${normalizedExtension}`
}

export function detectImageFormat(
  arrayBuffer: ArrayBuffer | Uint8Array,
  fileName = '',
  mimeType = '',
): ImageFormatInfo {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer)

  const fromSignature = detectBySignature(bytes)
  if (fromSignature) {
    return {
      extension: fromSignature.extension,
      mimeType: fromSignature.mimeType,
      source: 'signature',
      renderable: isRenderableImageExtension(fromSignature.extension),
      recognized: true,
    }
  }

  const fromMimeType = detectByMimeType(mimeType)
  if (fromMimeType) {
    return {
      extension: fromMimeType.extension,
      mimeType: fromMimeType.mimeType,
      source: 'mime',
      renderable: isRenderableImageExtension(fromMimeType.extension),
      recognized: true,
    }
  }

  const fromExtension = detectByExtension(fileName)
  if (fromExtension) {
    return {
      extension: fromExtension.extension,
      mimeType: fromExtension.mimeType,
      source: 'extension',
      renderable: isRenderableImageExtension(fromExtension.extension),
      recognized: true,
    }
  }

  return {
    extension: '',
    mimeType: '',
    source: 'fallback',
    renderable: false,
    recognized: false,
  }
}
