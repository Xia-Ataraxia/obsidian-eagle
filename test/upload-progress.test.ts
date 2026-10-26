import { describe, expect, it, vi } from 'vitest'

import { UploadProgress } from '../src/services/upload-progress'

type Show = (id: string, params: { images: string }, opts: { progress: { done: number; total: number }; button: { callback: () => void } }) => void

function setup() {
  const show = vi.fn<Show>()
  const remove = vi.fn()
  const progress = new UploadProgress(() => ({ show, remove }) as never)
  return { show, remove, progress, last: () => show.mock.lastCall! }
}

describe('upload progress notice', () => {
  it('counts queued uploads and clears once all finish', () => {
    const { remove, progress, last } = setup()
    const a = progress.start()
    expect(last()[1].images).toBe('image')
    const b = progress.start()
    expect(last()[1].images).toBe('1 of 2 images')
    progress.finish(a)
    expect(last()[1].images).toBe('2 of 2 images')
    expect(last()[2].progress).toEqual({ done: 1, total: 2 })
    progress.finish(b)
    expect(remove).toHaveBeenCalledWith('uploading')
  })

  it('Cancel aborts every upload and late finishes do not revive the notice', () => {
    const { show, progress, last } = setup()
    const a = progress.start()
    const b = progress.start()
    last()[2].button.callback()
    expect(a.signal.aborted && b.signal.aborted).toBe(true)
    const shown = show.mock.calls.length
    progress.finish(a)
    progress.finish(b)
    expect(show.mock.calls.length).toBe(shown)
  })
})
