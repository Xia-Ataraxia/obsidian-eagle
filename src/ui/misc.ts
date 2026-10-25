import { EditorPosition, ReferenceCache } from 'obsidian'

import { PluginLogger } from '../utils/plugin-logger'
import {
  detectImageFormat,
  isRenderableImageExtension,
  replaceFileExtension,
} from '../utils/image-format'

const log = new PluginLogger('Eagle')

function passesInstanceofCheck(image: File): boolean {
  return image instanceof File
}

function normalizeImageForBrowser(image: File): File {
  if (passesInstanceofCheck(image)) {
    return image
  }

  return new File([image], image.name, {
    type: image.type,
    lastModified: image.lastModified,
  })
}

function ensureTypeAndExtensionMatch(
  image: File,
  detected: ReturnType<typeof detectImageFormat>,
): File {
  const hasType = Boolean(detected.mimeType)
  const hasExtension = Boolean(detected.extension)
  const shouldChangeType = hasType && image.type !== detected.mimeType

  if (!hasExtension) {
    return shouldChangeType
      ? new File([image], image.name, {
          type: detected.mimeType,
          lastModified: image.lastModified,
        })
      : image
  }

  const nextName = replaceFileExtension(image.name, detected.extension)
  const shouldChangeName = nextName !== image.name

  if (!shouldChangeType && !shouldChangeName) {
    return image
  }

  return new File([image], nextName, {
    type: hasType ? detected.mimeType : image.type,
    lastModified: image.lastModified,
  })
}

export async function normalizeImageForUpload(image: File): Promise<File> {
  const normalized = normalizeImageForBrowser(image)
  const detected = detectImageFormat(await normalized.arrayBuffer(), normalized.name, normalized.type)

  if (detected.recognized && isRenderableImageExtension(detected.extension)) {
    return ensureTypeAndExtensionMatch(normalized, detected)
  }

  // Eagle handles native formats (HEIC, TIFF, etc.) natively — no conversion needed.
  // Log unrecognized formats so upload failures are easier to trace.
  if (!detected.recognized) {
    log.warn('image format not recognized, passing to Eagle as-is', {
      name: image.name,
      type: image.type,
    })
  }
  return normalized
}

function removeReferenceIfPresent(
  referencesByNote: Record<string, ReferenceCache[]>,
  referenceToRemove: { path: string; startPosition: EditorPosition },
) {
  if (!Object.keys(referencesByNote).includes(referenceToRemove.path)) return

  const refsFromOriginalNote = referencesByNote[referenceToRemove.path]
  if (!refsFromOriginalNote) return
  const originalRefStart = referenceToRemove.startPosition
  const refForExclusion = refsFromOriginalNote.find(
    (r) =>
      r.position.start.line === originalRefStart.line &&
      r.position.start.col === originalRefStart.ch,
  )
  if (refForExclusion) {
    refsFromOriginalNote.remove(refForExclusion)
    if (refsFromOriginalNote.length === 0) {
      delete referencesByNote[referenceToRemove.path]
    }
  }
}

export { removeReferenceIfPresent }
