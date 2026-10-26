import { App, ButtonComponent, Modal, TextComponent, setIcon } from 'obsidian'

import EagleApiError, { EagleUnreachableError } from '../domain/EagleApiError'
import { searchErrorStatus } from '../domain/search-error'
import { UPLOAD_ANNOTATION } from '../utils/item-naming'
import { countLabel } from '../utils/plural'
import { parseSearchQuery } from '../utils/search-query'
import { nextThumbnailRetry } from '../utils/thumbnail-retry'
import { PluginLogger } from '../utils/plugin-logger'
import type { EagleItemSearchResult, EagleSearchPickerUploader } from '../types/eagle-uploader-types'
import { fileUrlToDisplayUrl } from './file-url'

const SEARCH_RESULT_LIMIT = 100
const RECENT_LIMIT = 30
const SKELETON_ROWS = 2
const THUMBNAIL_CONCURRENCY = 6

type PickerStatus = 'idle' | 'loading' | 'error' | 'info'

export default class EagleSearchPickerModal extends Modal {
  private readonly log = new PluginLogger('Eagle', () => this.debugSearchDiagnostics)
  private readonly uploader: EagleSearchPickerUploader
  private readonly onChoose: (item: EagleItemSearchResult) => void
  private readonly debugSearchDiagnostics: boolean
  private readonly debounceMs: number

  private declare keywordInput: TextComponent
  private declare statusEl: HTMLElement
  private declare gridEl: HTMLElement
  private results: EagleItemSearchResult[] = []
  private readonly thumbFallbackMap = new Map<string, { wrapper: HTMLElement; ext?: string }>()
  private readonly thumbFailures = new Map<string, number>()
  private activeSearchToken = 0
  private debounceTimer: number | null = null
  private isThumbnailFallbackLoading = false
  private statusKind: PickerStatus = 'idle'

  constructor(
    app: App,
    uploader: EagleSearchPickerUploader,
    onChoose: (item: EagleItemSearchResult) => void,
    debugSearchDiagnostics: boolean,
    debounceMs = 300,
  ) {
    super(app)
    this.uploader = uploader
    this.onChoose = onChoose
    this.debugSearchDiagnostics = debugSearchDiagnostics
    this.debounceMs = debounceMs
    this.setTitle('Search Eagle library')
  }

  override onOpen(): void {
    this.modalEl.addClass('eagle-picker-modal')
    const { contentEl } = this
    contentEl.empty()
    contentEl.addClass('eagle-picker')

    this.keywordInput = new TextComponent(contentEl)
      .setPlaceholder('Search by title or annotation, add a #tag')
      .setValue('')
    this.keywordInput.inputEl.addClass('eagle-picker-search')
    this.keywordInput.inputEl.addEventListener('input', () => {
      this.scheduleSearch(false)
    })
    this.keywordInput.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        this.scheduleSearch(true)
      }
    })

    this.statusEl = contentEl.createEl('p', { cls: 'eagle-picker-status' })

    this.gridEl = contentEl.createDiv({ cls: 'eagle-picker-grid' })
    this.gridEl.addEventListener('keydown', (e: KeyboardEvent) => {
      this.handleGridArrowNav(e)
    })

    this.keywordInput.inputEl.focus()
    void this.runSearch()
  }

  override onClose(): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    this.activeSearchToken += 1
    this.isThumbnailFallbackLoading = false
    this.resetThumbnailFallbacks()
    this.contentEl.empty()
  }

  private debugLog(message: string, data?: Record<string, unknown>): void {
    this.log.debug(message, data)
  }

  private setStatus(text: string, status: PickerStatus): void {
    this.statusKind = status
    this.statusEl.setText(text)
    this.statusEl.removeClass(
      'eagle-picker-status-idle',
      'eagle-picker-status-loading',
      'eagle-picker-status-error',
      'eagle-picker-status-info',
    )
    this.statusEl.addClass(`eagle-picker-status-${status}`)
  }

  private scheduleSearch(immediate: boolean): void {
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }

    if (immediate) {
      void this.runSearch()
      return
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null
      void this.runSearch()
    }, this.debounceMs)
  }

  private async runSearch(): Promise<void> {
    const query = this.keywordInput.getValue().trim()
    const { keyword, tags } = parseSearchQuery(query)
    const recent = !keyword && tags.length === 0
    const limit = recent ? RECENT_LIMIT : SEARCH_RESULT_LIMIT
    const token = ++this.activeSearchToken
    this.setStatus(recent ? 'Loading recent images…' : 'Searching…', 'loading')
    this.debugLog('search:start', { keyword, tags, limit, token })

    this.gridEl.empty()
    const skeletons = this.columnCount() * SKELETON_ROWS
    for (let i = 0; i < skeletons; i++) {
      this.gridEl.createDiv({ cls: 'eagle-skeleton-card' })
    }

    try {
      const results = await this.uploader.searchItems({ keyword, tags, limit, orderBy: 'time' })

      if (!this.isTokenActive(token)) {
        this.debugLog('search:stale', { token, keyword })
        return
      }

      this.results = results
      this.resetThumbnailFallbacks()
      this.debugLog('search:done', {
        token,
        keyword,
        count: results.length,
      })
      if (recent) {
        this.setStatus(results.length ? 'Recent images. Type to search.' : 'Your Eagle library is empty.', 'idle')
      } else if (results.length === 0) {
        this.setStatus(`No results for "${query}".`, 'info')
      } else {
        this.setStatus(`Found ${countLabel(results.length, 'result')}. Select one to insert.`, 'info')
      }
      this.renderGrid(token)
    } catch (error) {
      if (!this.isTokenActive(token)) {
        return
      }

       
      const message = error instanceof Error ? error.message : String(error)
      this.debugLog('search:error', { token, keyword, message })
      if (error instanceof EagleUnreachableError) {
        this.log.error('search: Eagle unreachable', error.detail)
      } else if (!(error instanceof EagleApiError)) {
        this.log.error('unexpected search error', error)
      }
      this.results = []
      this.resetThumbnailFallbacks()
      this.setStatus(searchErrorStatus(error), 'error')
      this.renderGrid()
    }
  }

  private isTokenActive(token: number): boolean {
    return token === this.activeSearchToken && this.containerEl.isConnected
  }

  private inferThumbnailUrlType(rawThumbnail: string, resolvedUrl: string): 'api' | 'http' | 'file' | 'unknown' {
    const raw = rawThumbnail.trim().toLowerCase()
    if (raw.startsWith('api/') || raw.startsWith('/api/')) {
      return 'api'
    }

    const resolved = resolvedUrl.trim().toLowerCase()
    if (resolved.startsWith('file://')) {
      return 'file'
    }
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) {
      return 'http'
    }

    return 'unknown'
  }

  private renderGrid(token?: number): void {
    this.gridEl.empty()

    if (this.results.length === 0) {
      const emptyState = this.gridEl.createDiv({ cls: 'eagle-picker-empty-state' })
      // The status line already explains a failed search and an empty library.
      if (this.statusKind === 'info') {
        emptyState.createEl('p', {
          text: 'Try fewer words, or a different #tag.',
          cls: 'eagle-picker-empty-hint',
        })
      }
      const actions = emptyState.createDiv({ cls: 'modal-button-container' })
      if (this.statusKind === 'error') {
        new ButtonComponent(actions)
          .setButtonText('Retry search')
          .setCta()
          .onClick(() => {
            void this.runSearch()
          })
      }
      if (this.keywordInput.getValue().trim()) {
        new ButtonComponent(actions)
          .setButtonText('Clear query')
          .onClick(() => {
            this.keywordInput.setValue('')
            this.keywordInput.inputEl.focus()
            void this.runSearch()
          })
      }
      return
    }

    for (const item of this.results) {
      this.renderCard(item, token ?? this.activeSearchToken)
    }
  }

  private columnCount(): number {
    return Math.max(1, getComputedStyle(this.gridEl).gridTemplateColumns.split(' ').length)
  }

  private handleGridArrowNav(e: KeyboardEvent): void {
    const cols = this.columnCount()
    let delta: number
    switch (e.key) {
      case 'ArrowRight': delta = 1; break
      case 'ArrowLeft': delta = -1; break
      case 'ArrowDown': delta = cols; break
      case 'ArrowUp': delta = -cols; break
      default: return
    }

    const cards = Array.from(this.gridEl.querySelectorAll<HTMLElement>('.eagle-picker-item'))
    const idx = cards.indexOf(document.activeElement as HTMLElement)
    if (idx === -1) return

    const next = cards[idx + delta]
    if (!next) return

    e.preventDefault()
    next.focus()
  }

  private renderCard(item: EagleItemSearchResult, token: number): void {
    const card = this.gridEl.createDiv({
      cls: 'eagle-picker-item',
      attr: { role: 'button', tabindex: '0' },
    })

    const thumbWrapper = card.createDiv({ cls: ['eagle-picker-thumb', 'is-loading'] })
    if (item.thumbnail) {
      const resolvedUrl = this.uploader.resolveSearchThumbnailUrl(item.thumbnail)
      this.debugLog('thumbnail:metadata', {
        token,
        itemId: item.id,
        raw: item.thumbnail,
        resolved: resolvedUrl,
        urlType: this.inferThumbnailUrlType(item.thumbnail, resolvedUrl),
      })

      const img = thumbWrapper.createEl('img', {
        cls: 'eagle-picker-img',
        attr: { src: fileUrlToDisplayUrl(resolvedUrl), loading: 'lazy', alt: item.name || item.id },
      })
      img.addEventListener('load', () => {
        img.addClass('is-loaded')
        thumbWrapper.removeClass('is-loading')
      })
      img.addEventListener('error', () => {
        this.debugLog('thumbnail:metadata:error', {
          token,
          itemId: item.id,
          resolved: resolvedUrl,
        })
        this.enqueueThumbnailFallback(item, thumbWrapper)
        void this.loadThumbnails(token)
      })
      this.appendExtBadge(thumbWrapper, item.ext)
    } else {
      this.enqueueThumbnailFallback(item, thumbWrapper)
      void this.loadThumbnails(token)
    }

    card.createSpan({
      cls: 'eagle-picker-name',
      text: item.name || item.id,
    })

    // Tags
    if (item.tags?.length) {
      card.createSpan({
        cls: 'eagle-picker-tags',
        text: item.tags.slice(0, 3).join(', ') + (item.tags.length > 3 ? ' \u2026' : ''),
      })
    }

    // Annotation (truncated)
    if (item.annotation && item.annotation !== UPLOAD_ANNOTATION) {
      card.createSpan({
        cls: 'eagle-picker-annotation',
        text: item.annotation.length > 40 ? item.annotation.slice(0, 40) + '\u2026' : item.annotation,
      })
    }

    const choose = () => {
      this.close()
      this.onChoose(item)
    }

    card.addEventListener('click', choose)
    card.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        choose()
      }
    })
  }

  private appendExtBadge(thumbWrapper: HTMLElement, ext?: string): void {
    if (ext) {
      thumbWrapper.createSpan({
        cls: 'eagle-picker-ext-badge',
        text: ext.toUpperCase(),
      })
    }
  }

  private showImageMissing(thumbWrapper: HTMLElement, ext?: string): void {
    thumbWrapper.removeClass('is-loading')
    thumbWrapper.addClass('is-missing')
    thumbWrapper.setAttr('aria-label', 'No preview')
    thumbWrapper.empty()
    setIcon(thumbWrapper.createSpan({ cls: 'eagle-picker-missing' }), 'image-off')
    this.appendExtBadge(thumbWrapper, ext)
  }

  private enqueueThumbnailFallback(item: EagleItemSearchResult, thumbWrapper: HTMLElement): void {
    thumbWrapper.empty()
    thumbWrapper.createSpan({
      cls: 'eagle-picker-no-thumb',
      text: item.ext?.toUpperCase() ?? '?',
    })
    this.thumbFallbackMap.set(item.id, { wrapper: thumbWrapper, ext: item.ext })
  }

  private registerThumbnailFailure(itemId: string): void {
    const failures = (this.thumbFailures.get(itemId) ?? 0) + 1
    this.thumbFailures.set(itemId, failures)
    if (!nextThumbnailRetry(failures).giveUp) return
    const entry = this.thumbFallbackMap.get(itemId)
    this.thumbFallbackMap.delete(itemId)
    if (entry) this.showImageMissing(entry.wrapper, entry.ext)
  }

  private pendingRetryDelay(items: EagleItemSearchResult[]): number {
    let delay = 0
    for (const item of items) {
      const failures = this.thumbFailures.get(item.id)
      if (failures && this.thumbFallbackMap.has(item.id)) delay = Math.max(delay, nextThumbnailRetry(failures).delayMs)
    }
    return delay
  }

  private resetThumbnailFallbacks(): void {
    this.thumbFallbackMap.clear()
    this.thumbFailures.clear()
  }

  private async loadThumbnails(token: number): Promise<void> {
    if (this.isThumbnailFallbackLoading) {
      return
    }

    this.isThumbnailFallbackLoading = true
    try {
      while (this.isTokenActive(token)) {
        const pending = this.results.filter((item) => this.thumbFallbackMap.has(item.id))
        if (pending.length === 0) {
          return
        }

        let cursor = 0
        const worker = async () => {
          while (cursor < pending.length) {
            const currentIndex = cursor
            cursor += 1
            const item = pending[currentIndex]
            if (!item || !this.isTokenActive(token)) {
              return
            }

            try {
              const thumbnailUrl = await this.uploader.getThumbnailFileUrl(item.id)
              if (!this.isTokenActive(token)) {
                return
              }

              const entry = this.thumbFallbackMap.get(item.id)
              if (!entry) {
                continue
              }

              const { wrapper: thumbWrapper, ext } = entry
              thumbWrapper.empty()
              const fallbackImg = thumbWrapper.createEl('img', {
                cls: 'eagle-picker-img',
                attr: { src: fileUrlToDisplayUrl(thumbnailUrl), loading: 'lazy', alt: item.name || item.id },
              })
              fallbackImg.addEventListener('load', () => {
                fallbackImg.addClass('is-loaded')
                thumbWrapper.removeClass('is-loading')
              })
              fallbackImg.addEventListener('error', () => this.showImageMissing(thumbWrapper, ext))
              this.appendExtBadge(thumbWrapper, ext)
              this.thumbFallbackMap.delete(item.id)
              this.thumbFailures.delete(item.id)
              this.debugLog('thumbnail:fallback:ok', {
                token,
                itemId: item.id,
                resolved: thumbnailUrl,
                urlType: this.inferThumbnailUrlType('', thumbnailUrl),
              })
            } catch (error) {
               
              const message = error instanceof Error ? error.message : String(error)
              this.debugLog('thumbnail:fallback:error', { token, itemId: item.id, message })
              if (!(error instanceof EagleApiError)) {
                this.log.error('unexpected thumbnail load failure', error)
              }
              this.registerThumbnailFailure(item.id)
            }
          }
        }

        const workerCount = Math.min(THUMBNAIL_CONCURRENCY, pending.length)
        await Promise.all(Array.from({ length: workerCount }, worker))
        const retryDelay = this.pendingRetryDelay(pending)
        if (retryDelay > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelay))
      }
    } finally {
      this.isThumbnailFallbackLoading = false
    }
  }
}
