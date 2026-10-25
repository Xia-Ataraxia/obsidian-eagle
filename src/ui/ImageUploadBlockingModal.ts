import { ButtonComponent, Modal } from 'obsidian'

export default class ImageUploadBlockingModal extends Modal {
  isOpen = false
  onCancel?: () => void
  private declare buttonsDiv: HTMLElement

  override onOpen(): void {
    this.titleEl.setText('Eagle plugin')
    this.modalEl.addClass('eagle-upload-modal')
    this.contentEl.createEl('p', { text: 'Uploading image...' })
    this.contentEl.createDiv({ cls: 'eagle-upload-progress' })

    this.buttonsDiv = this.modalEl.createDiv('modal-button-container')

    new ButtonComponent(this.buttonsDiv)
      .setButtonText('Cancel')
      .setCta()
      .onClick(() => {
        this.onCancel?.()
        this.close()
      })
    this.isOpen = true
  }

  showError(message: string): void {
    if (!this.isOpen) return
    this.contentEl.empty()
    this.contentEl.createEl('p', { text: message, cls: 'eagle-upload-error' })
    this.modalEl.addClass('is-error')
    this.buttonsDiv.empty()
    new ButtonComponent(this.buttonsDiv)
      .setButtonText('Close')
      .onClick(() => this.close())
  }

  override onClose(): void {
    this.isOpen = false
  }
}
