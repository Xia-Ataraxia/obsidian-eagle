import { MetadataCache, ReferenceCache, TFile, Vault } from 'obsidian'

import { applyTextReplacements, type TextReplacement } from '../utils/markdown-image'

function matchesFile(linkTarget: string, file: TFile): boolean {
  return linkTarget === file.path || linkTarget === file.name
}

export function getAllCachedReferencesForFile(
  metadataCache: MetadataCache,
  file: TFile,
): Record<string, ReferenceCache[]> {
  const allLinks = metadataCache.resolvedLinks

  const notesWithLinks: string[] = []
  for (const [notePath, noteLinks] of Object.entries(allLinks)) {
    for (const linkTarget of Object.keys(noteLinks)) {
      if (matchesFile(linkTarget, file)) notesWithLinks.push(notePath)
    }
  }

  const linksByNote: Record<string, ReferenceCache[]> = {}
  for (const notePath of notesWithLinks) {
    const embeds = metadataCache.getCache(notePath)?.embeds
    if (!embeds) continue
    const matching = embeds.filter((l) => matchesFile(l.link, file))
    if (matching.length > 0) linksByNote[notePath] = matching
  }

  return linksByNote
}

export function filesAndLinksStatsFrom(
  referencesByNote: Record<string, ReferenceCache[]>,
): { filesCount: number; linksCount: number } {
  const linksCount = Object.values(referencesByNote).reduce((count, refs) => count + refs.length, 0)
  return { filesCount: Object.keys(referencesByNote).length, linksCount }
}

export async function replaceAllLocalReferencesWithRemoteOne(
  vault: Vault,
  allFileReferencesByNotes: Record<string, ReferenceCache[]>,
  remoteMarkdownImage: string,
) {
  for (const [notePath, refs] of Object.entries(allFileReferencesByNotes)) {
    const noteFile = vault.getFileByPath(notePath)
    if (!noteFile) continue
    const refsStartOffsetsSortedDescending = refs
      .map((ref) => ({
        start: ref.position.start.offset,
        end: ref.position.end.offset,
      }))
      .sort((ref1, ref2) => ref2.start - ref1.start)

    await vault.process(noteFile, (noteContent) => {
      let updatedContent = noteContent
      refsStartOffsetsSortedDescending.forEach((refPos) => {
        updatedContent =
          updatedContent.substring(0, refPos.start) +
          remoteMarkdownImage +
          updatedContent.substring(refPos.end)
      })
      return updatedContent
    })
  }
}

/**
 * Rewrites a note atomically via `Vault.process`: replacements are computed from the
 * content being written, so edits made while the rewrite runs are never overwritten.
 * Returns how many replacements were applied.
 */
export async function rewriteNote(
  vault: Vault,
  file: TFile,
  replacementsFor: (content: string) => TextReplacement[],
): Promise<number> {
  let applied = 0
  await vault.process(file, (content) => {
    const replacements = replacementsFor(content)
    applied = replacements.length
    return applied === 0 ? content : applyTextReplacements(content, replacements)
  })
  return applied
}
