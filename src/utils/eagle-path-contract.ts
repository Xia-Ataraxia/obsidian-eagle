const FALLBACK_DISPLAY_NAME = 'image'
const FALLBACK_ITEM_ID = 'item'
const FALLBACK_CACHE_FOLDER = 'eagle-cache'
const FALLBACK_EXTENSION = 'jpg'

const SAFE_IMAGE_EXTENSIONS = new Set([
  'avif',
  'bmp',
  'gif',
  'heic',
  'heif',
  'ico',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'tif',
  'tiff',
  'webp',
])

function shortStableHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(0, 6)
}

function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code > 31 && code !== 127
    })
    .join('')
}

function normalizeUnsafeLinkSyntax(value: string): string {
  return value
    .replaceAll('[[', '-')
    .replaceAll(']]', '-')
    .replaceAll('|', '-')
}

function collapseSafeSegment(value: string): string {
  return value
    .replace(/[\\/]+/g, '-')
    .replace(/^\.+$/, '')
    .replace(/(^|-)\.\.(-|$)/g, '$1$2')
    .replace(/[<>:"?*#^[\]]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim()
    .replace(/^[.\- ]+|[.\- ]+$/g, '')
}

function sanitizeSegment(value: string, fallback: string, addHashWhenChanged: boolean): string {
  const raw = String(value ?? '')
  const withoutControls = stripControlCharacters(raw.normalize('NFC'))
  const withoutLinkSyntax = normalizeUnsafeLinkSyntax(withoutControls)
  const safe = collapseSafeSegment(withoutLinkSyntax)
  if (!safe) return fallback
  if (addHashWhenChanged && safe !== raw) return `${safe}-${shortStableHash(raw)}`
  return safe
}

export function safeDisplayName(name: string | undefined): string {
  return sanitizeSegment(name ?? '', FALLBACK_DISPLAY_NAME, false)
}

export function safeItemId(itemId: string): string {
  return sanitizeSegment(itemId, FALLBACK_ITEM_ID, true)
}

export function safeImageExtension(extension: string | undefined): string {
  const normalized = String(extension ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\.+/, '')
  if (!/^[a-z0-9]+$/.test(normalized)) return FALLBACK_EXTENSION
  return SAFE_IMAGE_EXTENSIONS.has(normalized) ? normalized : FALLBACK_EXTENSION
}

export function safeCacheFolderSegment(segment: string): string {
  return sanitizeSegment(segment, FALLBACK_CACHE_FOLDER, false)
}

export function safeCacheFolderPath(path: string | undefined): string {
  const safeParts = String(path ?? '')
    .replace(/\\+/g, '/')
    .split('/')
    .filter((part) => part.trim() && !/^\.+$/.test(part.trim()))
    .map((part) => safeCacheFolderSegment(part))
    .filter(Boolean)

  return safeParts.length > 0 ? safeParts.join('/') : FALLBACK_CACHE_FOLDER
}

export function safePathSegment(segment: string): string {
  return sanitizeSegment(segment, FALLBACK_DISPLAY_NAME, true)
}

export function safeWikilinkText(text: string | undefined): string {
  return sanitizeSegment(text ?? '', FALLBACK_DISPLAY_NAME, false)
}

export function cacheFileNameFor(itemId: string, ext: string, displayName?: string): string {
  const safeId = safeItemId(itemId)
  const safeExt = safeImageExtension(ext)
  const safeName = displayName ? `${safeDisplayName(displayName)}_${safeId}` : safeId
  return `${safeName}.${safeExt}`
}

export function cachePathFor(cacheFolder: string, itemId: string, ext: string, displayName?: string): string {
  return `${safeCacheFolderPath(cacheFolder)}/${cacheFileNameFor(itemId, ext, displayName)}`
}

export function wikilinkForCacheItem(cacheFolder: string, itemId: string, ext: string, displayName?: string, alias = ''): string {
  const linkText = displayName === undefined ? undefined : safeWikilinkText(displayName)
  return `![[${cachePathFor(cacheFolder, itemId, ext, linkText)}${alias}]]`
}

export function dedupePathSegments(segments: string[]): string[] {
  const counts = new Map<string, number>()
  return segments.map((segment) => {
    const safe = safePathSegment(segment)
    const count = counts.get(safe) ?? 0
    counts.set(safe, count + 1)
    return count === 0 ? safe : `${safe}-${count + 1}`
  })
}
