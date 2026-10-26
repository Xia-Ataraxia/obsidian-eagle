import {
  ClickableToken,
  Editor,
  EditorPosition,
  MarkdownFileInfo,
  parseLinktext,
  TFile,
} from 'obsidian'

import { isKnownImageExtension } from '../utils/image-format'

function localEmbeddedImageExpectedBoundaries(
  from: ClickableToken,
): [EditorPosition, EditorPosition] {
  return [
    { ...from.start, ch: from.start.ch - 3 },
    { ...from.end, ch: from.end.ch + 2 },
  ]
}

export const findLocalFileUnderCursor = (editor: Editor, ctx: MarkdownFileInfo) => {
  const clickable = editor.getClickableTokenAt(editor.getCursor())

  if (!clickable) return null
  if (clickable.type !== 'internal-link') return null

  const [localImageExpectedStart, localImageExpectedEnd] =
    localEmbeddedImageExpectedBoundaries(clickable)

  const clickablePrefix = editor.getRange(localImageExpectedStart, clickable.start)
  const clickableSuffix = editor.getRange(clickable.end, localImageExpectedEnd)
  if (clickablePrefix !== '![[' || clickableSuffix !== ']]') return null

  if (!ctx.file) return null

  const lt = parseLinktext(clickable.text)
  const linkedFile = ctx.app.metadataCache.getFirstLinkpathDest(lt.path, ctx.file.path)
  if (!linkedFile) return null

  const file = ctx.app.vault.getAbstractFileByPath(linkedFile.path)
  if (!(file instanceof TFile)) return null
  if (!isKnownImageExtension(file.extension)) return null

  if (!file.extension) return null

  return {
    file,
    start: localImageExpectedStart,
    end: localImageExpectedEnd,
  }
}

export const replaceFirstOccurrence = (editor: Editor, target: string, replacement: string) => {
  const at = editor.getValue().indexOf(target)
  if (at === -1) return
  editor.replaceRange(replacement, editor.offsetToPos(at), editor.offsetToPos(at + target.length))
}
