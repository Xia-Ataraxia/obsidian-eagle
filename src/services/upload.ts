import {
  Editor,
  EditorPosition,
  MarkdownView,
  ReferenceCache,
  TFile,
} from 'obsidian'

import type EaglePlugin from '../main'

import EagleApiError, { EagleUnreachableError } from '../domain/EagleApiError'
import { resolveMappedEagleFolder } from '../domain/folder-mapping'
import { replaceFirstOccurrence } from '../ui/editor'
import { fileUrlToOsPath } from '../ui/file-url'
import InfoModal from '../ui/InfoModal'
import { normalizeImageForUpload, removeReferenceIfPresent } from '../ui/misc'
import { filesAndLinksStatsFrom, getAllCachedReferencesForFile, replaceAllLocalReferencesWithRemoteOne } from '../ui/obsidian-vault'
import UpdateLinksConfirmationModal from '../ui/UpdateLinksConfirmationModal'
import EagleHashStore from '../ui/EagleHashStore'
import { allFilesAreImages } from '../utils/FileList'
import { wikilinkForCacheItem } from '../utils/eagle-path-contract'
import { extractFileExtension } from '../utils/image-format'
import { resolveItemName } from '../utils/item-naming'
import { countLabel } from '../utils/plural'
import { generatePseudoRandomId } from '../utils/pseudo-random'
import { uploadPlaceholderFor } from '../utils/upload-placeholder'

export interface LocalImageInEditor {
  image: {
    file: TFile
    start: EditorPosition
    end: EditorPosition
  }
  editor: Editor
  noteFile: TFile
}

interface NoteTarget {
  view: MarkdownView
  file: TFile
}

export class UploadService {
  constructor(private readonly plugin: EaglePlugin) {}

  // Items whose cache file this service is still writing; cache sync leaves them alone meanwhile.
  private readonly inFlightItemIds = new Set<string>()

  isUploading(itemId: string): boolean {
    return this.inFlightItemIds.has(itemId)
  }

  private async whileInFlight<T>(itemId: string, write: () => Promise<T>): Promise<T> {
    this.inFlightItemIds.add(itemId)
    try {
      return await write()
    } finally {
      this.inFlightItemIds.delete(itemId)
    }
  }

  handleImageFiles(files: FileList, e: Event): void {
    if (!allFilesAreImages(files)) return

    e.preventDefault()
    for (const file of files) {
      void this.uploadFileAndEmbedEagleImage(file).catch((err) => {
        this.plugin.log.error('Failed to upload image', err)
      })
    }
  }

  async doUploadLocalImage(imageInEditor: LocalImageInEditor) {
    const remoteMarkdownImage = await this.uploadLocalImageFromEditor(
      imageInEditor.editor,
      imageInEditor.image.file,
      imageInEditor.image.start,
      imageInEditor.image.end,
    )
    if (!remoteMarkdownImage) return

    this.proposeToReplaceOtherLocalLinksIfAny(imageInEditor.image.file, remoteMarkdownImage, {
      path: imageInEditor.noteFile.path,
      startPosition: imageInEditor.image.start,
    })
  }

  private proposeToReplaceOtherLocalLinksIfAny(
    originalLocalFile: TFile,
    remoteMarkdownImage: string,
    originalReference: { path: string; startPosition: EditorPosition },
  ) {
    const referencesByNotes = this.getAllCachedReferencesForFile(originalLocalFile)
    this.removeReferenceToOriginalNoteIfPresent(referencesByNotes, originalReference)

    if (Object.keys(referencesByNotes).length > 0) {
      this.showLinksUpdateDialog(originalLocalFile, remoteMarkdownImage, referencesByNotes)
    }
  }

  private getAllCachedReferencesForFile(file: TFile): Record<string, ReferenceCache[]> {
    return getAllCachedReferencesForFile(this.plugin.app.metadataCache, file)
  }

  private removeReferenceToOriginalNoteIfPresent = (
    referencesByNote: Record<string, ReferenceCache[]>,
    originalNoteRef: { path: string; startPosition: EditorPosition },
  ) => removeReferenceIfPresent(referencesByNote, originalNoteRef)

  private showLinksUpdateDialog(
    localFile: TFile,
    remoteMarkdownImage: string,
    otherReferencesByNote: Record<string, ReferenceCache[]>,
  ) {
    const stats = filesAndLinksStatsFrom(otherReferencesByNote)
    const dialogBox = new UpdateLinksConfirmationModal(this.plugin.app, localFile.path, stats)
    dialogBox.onDoNotUpdateClick(() => dialogBox.close())
    dialogBox.onDoUpdateClick(() => {
      dialogBox.disableButtons()
      dialogBox.setContent('Working...')
      replaceAllLocalReferencesWithRemoteOne(
        this.plugin.app.vault,
        otherReferencesByNote,
        remoteMarkdownImage,
      )
        .catch((e) => {
          new InfoModal(
            this.plugin.app,
            'Error',
            'Unexpected error occurred, check Developer Tools console for details',
          ).open()
          this.plugin.log.error('Something bad happened during links update', e)
        })
        .finally(() => dialogBox.close())
      this.plugin.notices.show('links_updated', { links: countLabel(stats.linksCount, 'link'), files: countLabel(stats.filesCount, 'file') })
    })
    dialogBox.open()
  }

  private async uploadLocalImageFromEditor(
    editor: Editor,
    file: TFile,
    start: EditorPosition,
    end: EditorPosition,
  ) {
    const target = this.activeTarget()
    if (!target) return
    const link = editor.getRange(start, end)
    const arrayBuffer = await this.plugin.app.vault.readBinary(file)
    const fileToUpload = new File([arrayBuffer], file.name)
    const remoteMarkdownImage = await this.uploadFileAndEmbedEagleImage(fileToUpload, target, end, false)
    if (remoteMarkdownImage) {
      await this.replaceInNote(target, `${link}\n${remoteMarkdownImage}`, `<!--${link}-->\n${remoteMarkdownImage}`)
    }
    return remoteMarkdownImage
  }

  /** Never blocks the editor: a placeholder marks the spot while the shared progress notice offers Cancel. */
  async uploadFileAndEmbedEagleImage(file: File, target = this.activeTarget(), atPos?: EditorPosition, saveLocallyOnFailure = true) {
    if (!target) {
      this.plugin.notices.show('no_active_editor')
      return
    }
    const progressText = uploadPlaceholderFor(generatePseudoRandomId())
    // A placeholder after an existing link starts on its own line; a pasted one takes the cursor's place.
    const placeholder = atPos ? `\n${progressText}` : `${progressText}\n`
    if (atPos) target.view.editor.replaceRange(placeholder, atPos, atPos)
    else target.view.editor.replaceSelection(placeholder)

    const progress = this.plugin.uploadProgress
    const controller = progress.start()
    const removePlaceholder = () => this.replaceInNote(target, placeholder, '')
    controller.signal.addEventListener('abort', () => void removePlaceholder(), { once: true })

    try {
      const markdownImage = await this.uploadToEagle(file, target, controller.signal)
      await this.replaceInNote(target, progressText, markdownImage)
      return markdownImage
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      // Pasted/dropped images exist nowhere else; keep them in the vault rather than losing them.
      if (saveLocallyOnFailure) {
        const localLink = await this.saveAsLocalAttachment(file, target.file.path).catch((saveErr) => {
          this.plugin.log.error('Local fallback save failed', saveErr)
          return null
        })
        if (localLink) {
          this.plugin.log.warn('Eagle upload failed, saved locally', { err: e instanceof EagleUnreachableError ? e.detail : e instanceof Error ? e.message : String(e) })
          await this.replaceInNote(target, progressText, localLink)
          this.plugin.notices.show('saved_locally')
          return
        }
      }
      this.plugin.log.error('Eagle upload failed', e)
      await removePlaceholder()
      this.plugin.notices.show('upload_failed', {
        reason: e instanceof EagleUnreachableError ? 'Make sure Eagle is open, then try again.' : 'Check the developer console for details.',
      })
      return
    } finally {
      progress.finish(controller)
    }
  }

  private async uploadToEagle(file: File, target: NoteTarget, signal: AbortSignal): Promise<string> {
    const folderName = this.resolveTargetEagleFolderForActiveFile()
    const normalizedFile = await normalizeImageForUpload(file)
    const originalName = file.name.replace(/\.[^.]+$/, '')
    const displayName = resolveItemName(this.plugin.settings.uploadItemNameTemplate, { originalName, noteName: target.file.basename })

    // Deduplication: compute hash and library path once, reuse for lookup + storage
    let dedupHash: string | null = null
    let dedupLibraryPath: string | null = null

    if (this.plugin.settings.deduplicateUploads) {
      const buffer = await normalizedFile.arrayBuffer()
      dedupHash = await EagleHashStore.computeHash(buffer)
      dedupLibraryPath = await this.plugin.eagleUploader.getLibraryRootPath(signal) ?? null
      if (dedupLibraryPath) {
        const existing = this.plugin.hashStore.lookup(dedupHash, dedupLibraryPath)
        if (existing) {
          const reused = await this.reuseExistingItem(dedupHash, existing, signal)
          if (reused) return reused
        }
      }
    }

    const { itemId, fileUrl, ext } = await this.plugin.eagleUploader.upload(normalizedFile, { folderName, signal, displayName })
    return this.whileInFlight(itemId, async () => {
      if (fileUrl.startsWith('file://')) {
        await this.plugin.cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName).catch((e: unknown) => {
          this.plugin.log.warn('cache write failed — image may appear broken', { err: e instanceof Error ? e.message : String(e) })
        })
      }

      // Store hash for future deduplication (reuse pre-computed values)
      if (dedupHash && dedupLibraryPath) {
        this.plugin.hashStore.store(dedupHash, itemId, displayName, dedupLibraryPath)
        await this.plugin.hashStore.save(this.plugin).catch((e: unknown) => {
          this.plugin.log.warn('failed to store upload hash', { err: e instanceof Error ? e.message : String(e) })
        })
      }

      return this.markdownImageFor(itemId, ext, displayName)
    })
  }

  /** Returns the embed for a previously uploaded item, or null when Eagle no longer has it (hash evicted, caller re-uploads). */
  private async reuseExistingItem(hash: string, existing: { itemId: string; displayName: string }, signal: AbortSignal): Promise<string | null> {
    const { itemId, displayName } = existing
    let fileUrl: string
    try {
      fileUrl = await this.plugin.eagleUploader.getFileUrlForItemId(itemId, signal)
    } catch (e) {
      // Eagle answered with an error for this id: the item is gone. Connectivity and abort errors still propagate.
      if (!(e instanceof EagleApiError) || e instanceof EagleUnreachableError) throw e
      fileUrl = ''
    }
    if (!fileUrl.startsWith('file://')) {
      this.plugin.hashStore.evict(hash)
      await this.plugin.hashStore.save(this.plugin)
      return null
    }
    this.plugin.notices.show('duplicate_detected')
    const ext = extractFileExtension(fileUrl) || 'jpg'
    return this.whileInFlight(itemId, async () => {
      await this.plugin.cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName).catch((e: unknown) => {
        this.plugin.log.warn('cache write failed — image may appear broken', { err: e instanceof Error ? e.message : String(e) })
      })
      return this.markdownImageFor(itemId, ext, displayName)
    })
  }

  async saveAsLocalAttachment(file: File, sourcePath = this.activeSourcePath()): Promise<string> {
    const saved = await this.saveAttachmentFile(file, sourcePath)
    return `!${this.plugin.app.fileManager.generateMarkdownLink(saved, sourcePath)}`
  }

  async saveAttachmentFile(file: File, sourcePath = this.activeSourcePath()): Promise<TFile> {
    const { fileManager, vault } = this.plugin.app
    const path = await fileManager.getAvailablePathForAttachment(file.name || 'Pasted image.png', sourcePath)
    return vault.createBinary(path, await file.arrayBuffer())
  }

  private activeSourcePath(): string {
    return this.plugin.app.workspace.getActiveFile()?.path ?? ''
  }

  markdownImageFor(itemId: string, ext: string, displayName?: string) {
    return wikilinkForCacheItem(this.plugin.cacheManager.cacheFolder, itemId, ext, displayName)
  }

  private activeTarget(): NoteTarget | null {
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)
    return view?.file ? { view, file: view.file } : null
  }

  /** Edits the note the upload started in, even after the user moved on to another one. */
  private async replaceInNote(target: NoteTarget, search: string, replacement: string): Promise<void> {
    const { view, file } = target
    if (view.file === file) {
      replaceFirstOccurrence(view.editor, search, replacement)
      return
    }
    await this.plugin.app.vault.process(file, (text) => text.replace(search, () => replacement))
  }

  resolveTargetEagleFolderForActiveFile(): string | undefined {
    const activeFilePath = this.plugin.app.workspace.getActiveFile()?.path ?? null
    const mappedFolderName = resolveMappedEagleFolder(activeFilePath, this.plugin.settings.folderMappings)
    if (mappedFolderName) {
      return mappedFolderName
    }

    const fallbackFolderName = this.plugin.settings.eagleFolderName.trim()
    return fallbackFolderName || undefined
  }
}
