import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { setIcon } from 'obsidian'
import { UPLOAD_PLACEHOLDER_PATTERN } from '../utils/upload-placeholder'

class UploadChipWidget extends WidgetType {
  override eq() {
    return true
  }

  override toDOM() {
    const chip = createSpan({ cls: 'eagle-upload-chip', attr: { role: 'status', 'aria-label': 'Uploading image to Eagle' } })
    setIcon(chip.createSpan({ cls: 'eagle-upload-chip-icon' }), 'image-up')
    chip.createSpan({ text: 'Uploading…' })
    return chip
  }
}

const chip = Decoration.replace({ widget: new UploadChipWidget() })

function buildChips(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to)
    for (const match of text.matchAll(UPLOAD_PLACEHOLDER_PATTERN)) {
      const start = from + match.index
      builder.add(start, start + match[0].length, chip)
    }
  }
  return builder.finish()
}

/** Renders in-flight upload placeholders as a chip instead of raw markdown with its id. */
export const uploadPlaceholderExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildChips(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = buildChips(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)
