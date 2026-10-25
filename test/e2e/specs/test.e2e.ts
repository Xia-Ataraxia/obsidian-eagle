/* global describe, before, context, it, expect -- wdio runtime globals */
import ObsidianApp from './pageobjects/obsidian-app.page'
import MockingUtils from './utils/mocking'

describe('Electron Testing', () => {
  before(async () => {
    const settings = await ObsidianApp.openSettings()
    await settings.switchToEagleSettingsTab()
    await settings.configureEagleHost('localhost')
    await settings.closeSettings()
  })

  context('blank note', () => {
    it('uploads clipboard image on PASTE shortcut', async () => {
      await ObsidianApp.createNewNote()

      await MockingUtils.mockUploadedImageUrl('https://example.com/eagle-image.png')

      await ObsidianApp.loadSampleImageToClipboard()
      await ObsidianApp.pasteFromClipboard()
      await ObsidianApp.confirmUpload()

      const noteContent = await ObsidianApp.getTextFromOpenedNote()
      await expect(noteContent).toBe('![](https://example.com/eagle-image.png)\n')
    })
  })

  context('Note with existing local image', () => {
    it('upload the image', async () => {
      await ObsidianApp.putExampleImageToVault('example-local-image.png')
      await ObsidianApp.createNewNoteWithContent('![[example-local-image.png]]')
      await MockingUtils.mockUploadedImageUrl('https://example.com/eagle-image.png')

      const somewhereWithinMarkdownImage = { line: 0, ch: 5 }
      await ObsidianApp.setCursorPositionInActiveNote(somewhereWithinMarkdownImage)

      await ObsidianApp.uploadToEagleUsingCommandPalette()

      const noteContent = await ObsidianApp.getTextFromOpenedNote()
      const expectedContent = [
        '<!--![[example-local-image.png]]-->',
        '![](https://example.com/eagle-image.png)',
        '',
      ].join('\n')
      await expect(noteContent).toBe(expectedContent)
    })
  })

  context('Note with multiple identical references of existing local image', () => {
    it('upload the image', async () => {
      await ObsidianApp.putExampleImageToVault('example-local-image.png')
      const initialNoteContent = [
        '![[example-local-image.png]]',
        'some plain text',
        '![[example-local-image.png]]',
      ].join('\n')
      await ObsidianApp.createNewNoteWithContent(initialNoteContent)
      await MockingUtils.mockUploadedImageUrl('https://example.com/eagle-image.png')

      const somewhereWithinFirstLocalMarkdownImage = { line: 0, ch: 5 }
      await ObsidianApp.setCursorPositionInActiveNote(somewhereWithinFirstLocalMarkdownImage)
      await ObsidianApp.uploadToEagleUsingCommandPalette()
      await ObsidianApp.confirmReplacingAllLinks()

      const noteContent = await ObsidianApp.getTextFromOpenedNote()
      const expectedContent = [
        '<!--![[example-local-image.png]]-->',
        '![](https://example.com/eagle-image.png)',
        '',
        'some plain text',
        '![](https://example.com/eagle-image.png)',
      ].join('\n')
      await expect(noteContent).toBe(expectedContent)
    })
  })

  context('blank canvas', () => {
    it('uploads clipboard image on PASTE shortcut', async () => {
      await MockingUtils.mockUploadedImageUrl('https://example.com/eagle-image.png')
      await ObsidianApp.createNewEmptyCanvas()

      await ObsidianApp.loadSampleImageToClipboard()
      await ObsidianApp.pasteFromClipboard()
      await ObsidianApp.confirmUpload()

      const canvasCard = await ObsidianApp.findAndSwitchToCanvasCard()
      const canvasCardText = await canvasCard.getText()
      await expect(canvasCardText).toBe('![](https://example.com/eagle-image.png)')
    })
  })
})
