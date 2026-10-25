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
import ImageUploadBlockingModal from '../ui/ImageUploadBlockingModal'
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

export interface LocalImageInEditor {
  image: {
    file: TFile
    start: EditorPosition
    end: EditorPosition
  }
  editor: Editor
  noteFile: TFile
}

export class UploadService {
  constructor(private readonly plugin: EaglePlugin) {}

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
    const arrayBuffer = await this.plugin.app.vault.readBinary(file)
    const fileToUpload = new File([arrayBuffer], file.name)
    editor.replaceRange('\n', end, end)
    const remoteMarkdownImage = await this.uploadFileAndEmbedEagleImage(fileToUpload, {
      ch: 0,
      line: end.line + 1,
    }, false)
    if (remoteMarkdownImage) {
      editor.replaceRange(`<!--${editor.getRange(start, end)}-->`, start, end)
    }
    return remoteMarkdownImage
  }

  async uploadFileAndEmbedEagleImage(file: File, atPos?: EditorPosition, saveLocallyOnFailure = true) {
    if (!this.activeEditor) {
      this.plugin.notices.show('no_active_editor')
      return
    }
    const pasteId = generatePseudoRandomId()
    this.insertTemporaryText(pasteId, atPos)

    const modal = new ImageUploadBlockingModal(this.plugin.app)
    modal.open()
    const controller = new AbortController()
    modal.onCancel = () => {
      controller.abort()
    }

    let markdownImage = ''
    try {
      const folderName = this.resolveTargetEagleFolderForActiveFile()
      const normalizedFile = await normalizeImageForUpload(file)
      const originalName = file.name.replace(/\.[^.]+$/, '')
      const noteName = this.plugin.app.workspace.getActiveFile()?.basename ?? ''
      const displayName = resolveItemName(this.plugin.settings.uploadItemNameTemplate, { originalName, noteName })

      // Deduplication: compute hash and library path once, reuse for lookup + storage
      let dedupHash: string | null = null
      let dedupLibraryPath: string | null = null

      if (this.plugin.settings.deduplicateUploads) {
        const buffer = await normalizedFile.arrayBuffer()
        dedupHash = await EagleHashStore.computeHash(buffer)
        dedupLibraryPath = await this.plugin.eagleUploader.getLibraryRootPath(controller.signal) ?? null
        if (dedupLibraryPath) {
          const existing = this.plugin.hashStore.lookup(dedupHash, dedupLibraryPath)
          if (existing) {
            const reused = await this.reuseExistingItem(dedupHash, existing, controller.signal)
            if (reused) {
              markdownImage = reused
              this.embedMarkDownImage(pasteId, markdownImage)
              modal.close()
              return markdownImage
            }
          }
        }
      }

      const { itemId, fileUrl, ext } = await this.plugin.eagleUploader.upload(normalizedFile, { folderName, signal: controller.signal, displayName })

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

      markdownImage = this.markdownImageFor(itemId, ext, displayName)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        modal.close()
        this.handleFailedUpload(pasteId, ' upload cancelled ')
        return markdownImage
      }
      // Pasted/dropped images exist nowhere else; keep them in the vault rather than losing them.
      if (saveLocallyOnFailure) {
        const localLink = await this.saveAsLocalAttachment(file).catch((saveErr) => {
          this.plugin.log.error('Local fallback save failed', saveErr)
          return null
        })
        if (localLink) {
          this.plugin.log.warn('Eagle upload failed, saved locally', { err: e instanceof EagleUnreachableError ? e.detail : e instanceof Error ? e.message : String(e) })
          modal.close()
          this.embedMarkDownImage(pasteId, localLink)
          this.plugin.notices.show('saved_locally')
          return markdownImage
        }
      }
      if (e instanceof EagleApiError) {
        this.plugin.log.error('Eagle upload failed', e)
        modal.showError(`Upload failed: ${e.message}`)
        this.handleFailedUpload(pasteId, `Eagle upload failed, API returned an error: ${e.message}`)
      } else {
        this.plugin.log.error('Failed upload request', e)
        modal.showError('Upload failed — check the developer console for details.')
        this.handleFailedUpload(pasteId, '⚠️Eagle upload failed, check dev console')
      }
      return markdownImage
    }

    modal.close()
    this.embedMarkDownImage(pasteId, markdownImage)
    return markdownImage
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
    await this.plugin.cacheManager.cacheFromOsPath(itemId, ext, fileUrlToOsPath(fileUrl), displayName).catch((e: unknown) => {
      this.plugin.log.warn('cache write failed — image may appear broken', { err: e instanceof Error ? e.message : String(e) })
    })
    return this.markdownImageFor(itemId, ext, displayName)
  }

  async saveAsLocalAttachment(file: File): Promise<string> {
    const { fileManager, vault, workspace } = this.plugin.app
    const sourcePath = workspace.getActiveFile()?.path ?? ''
    const path = await fileManager.getAvailablePathForAttachment(file.name || 'Pasted image.png', sourcePath)
    const saved = await vault.createBinary(path, await file.arrayBuffer())
    return `!${fileManager.generateMarkdownLink(saved, sourcePath)}`
  }

  private insertTemporaryText(pasteId: string, atPos?: EditorPosition) {
    const progressText = UploadService.progressTextFor(pasteId)
    const replacement = `${progressText}\n`
    const editor = this.activeEditor
    if (!editor) return
    if (atPos) {
      editor.replaceRange(replacement, atPos, atPos)
    } else {
      editor.replaceSelection(replacement)
    }
  }

  private static progressTextFor(id: string) {
    return `![Uploading to Eagle...${id}]()`
  }

  markdownImageFor(itemId: string, ext: string, displayName?: string) {
    return wikilinkForCacheItem(this.plugin.cacheManager.cacheFolder, itemId, ext, displayName)
  }

  private embedMarkDownImage(pasteId: string, markdownImage: string) {
    const progressText = UploadService.progressTextFor(pasteId)
    const editor = this.activeEditor
    if (!editor) return
    replaceFirstOccurrence(editor, progressText, markdownImage)
  }

  private handleFailedUpload(pasteId: string, message: string) {
    const progressText = UploadService.progressTextFor(pasteId)
    const editor = this.activeEditor
    if (!editor) return
    replaceFirstOccurrence(editor, progressText, `<!--${message}-->`)
  }

  private get activeEditor(): Editor | null {
    const mdView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView)
    return mdView?.editor ?? null
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
