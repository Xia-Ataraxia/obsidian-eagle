import type { PluginNotices } from '../ui/plugin-notices'

/** One persistent notice for every upload in flight; Cancel aborts them all. */
export class UploadProgress {
  private readonly active = new Set<AbortController>()
  private done = 0

  constructor(private readonly notices: () => Pick<PluginNotices, 'show' | 'remove'>) {}

  start(): AbortController {
    const controller = new AbortController()
    this.active.add(controller)
    this.render()
    return controller
  }

  finish(controller: AbortController): void {
    if (!this.active.delete(controller)) return
    this.done += 1
    this.render()
  }

  private cancelAll(): void {
    const cancelled = [...this.active]
    this.active.clear()
    this.done = 0
    for (const controller of cancelled) controller.abort()
  }

  private render(): void {
    if (this.active.size === 0) {
      this.done = 0
      this.notices().remove('uploading')
      return
    }
    const total = this.done + this.active.size
    const images = total === 1 ? 'image' : `${this.done + 1} of ${total} images`
    this.notices().show('uploading', { images }, {
      timeout: 0,
      progress: { done: this.done, total },
      button: { text: 'Cancel', callback: () => this.cancelAll() },
    })
  }
}
