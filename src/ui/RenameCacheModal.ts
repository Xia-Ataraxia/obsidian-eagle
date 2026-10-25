import { App, ButtonComponent, Modal } from 'obsidian'

export default class RenameCacheModal extends Modal {
  constructor(
    app: App,
    private readonly oldFolder: string,
    private readonly newFolder: string,
    private readonly onConfirm: () => void,
    private readonly onSkip: () => void,
    private readonly onDismiss: () => void,
  ) {
    super(app)
  }

  private choice: 'move' | 'skip' | null = null

  override onOpen() {
    const { contentEl } = this

    this.setTitle('Rename cache folder?')

    contentEl.createEl('p', {
      text: `Cache folder changed from '${this.oldFolder}' to '${this.newFolder}'.`,
    })
    contentEl.createEl('p', {
      text: 'Move existing cached files and update all wikilinks in your vault?',
    })
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: `If you skip, new images use '${this.newFolder}' and existing files stay in '${this.oldFolder}'.`,
    })

    const buttonsDiv = this.modalEl.createDiv('modal-button-container')

    new ButtonComponent(buttonsDiv)
      .setButtonText('Move & update')
      .setCta()
      .onClick(() => {
        this.choice = 'move'
        this.close()
        this.onConfirm()
      })

    new ButtonComponent(buttonsDiv).setButtonText('Skip').onClick(() => {
      this.choice = 'skip'
      this.close()
    })
  }

  override onClose() {
    this.contentEl.empty()
    // Skip keeps the new folder for new images; Esc and click-outside cancel the rename.
    if (this.choice === 'skip') this.onSkip()
    else if (this.choice === null) this.onDismiss()
  }
}
