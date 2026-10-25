import { describe, expect, it, vi } from 'vitest'

import type { EagleItemSearchResult } from '../src/ui/eagle-uploader-types'

type ElementListener = (event?: { key?: string; isComposing?: boolean; preventDefault?: () => void }) => void

class FakeElement {
  readonly children: FakeElement[] = []
  readonly classes = new Set<string>()
  readonly attrs: Record<string, string> = {}
  readonly listeners = new Map<string, ElementListener[]>()
  text = ''
  value = ''
  isConnected = true

  constructor(readonly tagName = 'div') {}

  addClass(...classNames: string[]): this {
    classNames.forEach((className) => this.classes.add(className))
    return this
  }

  removeClass(...classNames: string[]): this {
    classNames.forEach((className) => this.classes.delete(className))
    return this
  }

  hasClass(className: string): boolean {
    return this.classes.has(className)
  }

  empty(): void {
    this.children.length = 0
  }

  setText(text: string): void {
    this.text = text
  }

  createEl(
    tagName: string,
    options?: { cls?: string; text?: string; attr?: Record<string, string> },
  ): FakeElement {
    const child = new FakeElement(tagName)
    if (options?.cls) {
      options.cls
        .split(' ')
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((className) => child.classes.add(className))
    }
    if (options?.text) {
      child.text = options.text
    }
    if (options?.attr) {
      Object.entries(options.attr).forEach(([key, value]) => {
        child.attrs[key] = value
      })
    }

    this.children.push(child)
    return child
  }

  createDiv(options?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createEl('div', options)
  }

  createSpan(options?: { cls?: string; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createEl('span', options)
  }

  addEventListener(eventName: string, listener: ElementListener): void {
    const list = this.listeners.get(eventName)
    if (list) {
      list.push(listener)
      return
    }
    this.listeners.set(eventName, [listener])
  }

  dispatch(eventName: string, event: { key?: string; isComposing?: boolean } = {}): void {
    const listeners = this.listeners.get(eventName) ?? []
    const eventWithPreventDefault = {
      ...event,
      preventDefault: () => {
        // no-op
      },
    }
    listeners.forEach((listener) => listener(eventWithPreventDefault))
  }

  focus(): void {
    // no-op
  }
}

class App {}

class Modal {
  readonly modalEl = new FakeElement('div')
  readonly contentEl = new FakeElement('div')
  readonly containerEl = new FakeElement('div')
  isOpen = false

  constructor(readonly app: App) {}

  setTitle(): void {
    // no-op
  }

  open(): void {
    this.isOpen = true
    this.containerEl.isConnected = true
    this.onOpen()
  }

  close(): void {
    this.isOpen = false
    this.containerEl.isConnected = false
    this.onClose()
  }

  onOpen(): void {
    // no-op
  }

  onClose(): void {
    // no-op
  }
}

class TextComponent {
  readonly inputEl: FakeElement
  private value = ''

  constructor(containerEl: FakeElement) {
    this.inputEl = containerEl.createEl('input')
  }

  setPlaceholder(placeholder: string): this {
    this.inputEl.attrs['placeholder'] = placeholder
    return this
  }

  setValue(value: string): this {
    this.value = value
    this.inputEl.value = value
    return this
  }

  getValue(): string {
    return this.value
  }
}

vi.mock('obsidian', () => ({
  App,
  Modal,
  TextComponent,
  Platform: { resourcePathPrefix: 'app://local/' },
}))

describe('EagleSearchPickerModal', () => {
  it('does not auto choose when search returns a single result', async () => {
    const { default: EagleSearchPickerModal } = await import('../src/ui/EagleSearchPickerModal')

    const onlyItem: EagleItemSearchResult = {
      id: 'item-1',
      name: 'Wisdom',
      ext: 'png',
      thumbnail: '/api/item/thumbnail?id=item-1',
    }

    const searchItems = vi.fn().mockResolvedValue([onlyItem])
    const resolveSearchThumbnailUrl = vi
      .fn()
      .mockReturnValue('http://localhost:41595/api/item/thumbnail?id=item-1')
    const getThumbnailFileUrl = vi.fn()
    const onChoose = vi.fn()

    const modal = new EagleSearchPickerModal(
      new App() as import('obsidian').App,
      {
        searchItems,
        resolveSearchThumbnailUrl,
        getThumbnailFileUrl,
      },
      onChoose,
      false,
    )

    modal.open()
    const modalInternals = modal as unknown as {
      keywordInput: TextComponent
      runSearch: () => Promise<void>
      gridEl: FakeElement
    }

    modalInternals.keywordInput.setValue('wisdom')
    await modalInternals.runSearch()

    expect(searchItems).toHaveBeenCalledWith({
      keyword: 'wisdom',
      limit: 100,
      orderBy: 'time',
    })
    expect(onChoose).not.toHaveBeenCalled()

    const cards = modalInternals.gridEl.children.filter((child) =>
      child.hasClass('eagle-picker-item'),
    )
    expect(cards).toHaveLength(1)
    expect(getThumbnailFileUrl).not.toHaveBeenCalled()

    cards[0].dispatch('click')
    expect(onChoose).toHaveBeenCalledOnce()
    expect(onChoose).toHaveBeenCalledWith(onlyItem)
  })
})
