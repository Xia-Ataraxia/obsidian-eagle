import { ButtonComponent, Modal } from 'obsidian'

export default class ImageUploadBlockingModal extends Modal {
  isOpen = false
  onCancel?: () => void
  private declare buttonsDiv: HTMLElement

  override onOpen(): void {
    this.titleEl.setText('Eagle plugin')
    this.contentEl.setText('Uploading image...')

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
    this.contentEl.setText(message)
    this.buttonsDiv.empty()
    new ButtonComponent(this.buttonsDiv)
      .setButtonText('Close')
      .onClick(() => this.close())
  }

  override onClose(): void {
    this.isOpen = false
  }
}
