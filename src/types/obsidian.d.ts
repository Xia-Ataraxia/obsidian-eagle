import 'obsidian'

/* global TextFileView, EditorPosition, Point, TFile -- Obsidian internal types not exported from the obsidian module but present at runtime */

/** Minimal subset of Node.js ErrnoException used by the desktop adapter callbacks. */
export interface NodeErrnoException extends Error {
  code?: string
}

/** Shape of the internal Node.js fs/path fields exposed by Obsidian's desktop adapter. */
export interface NodeAdapterFs {
  readFile(path: string, callback: (err: NodeErrnoException | null, buffer: Buffer) => void): void
  writeFile(path: string, data: Buffer, callback: (err: NodeErrnoException | null) => void): void
  unlink(path: string, callback: (err: NodeErrnoException | null) => void): void
}

export interface NodeAdapterPath {
  join(...parts: string[]): string
}

export interface NodeDataAdapter {
  fs: NodeAdapterFs
  path: NodeAdapterPath
}

declare module 'obsidian' {
  interface MarkdownSubView {
    clipboardManager: ClipboardManager
  }

  interface CanvasView extends TextFileView {
    handlePaste: (e: ClipboardEvent) => Promise<void>
  }

  interface Editor {
    getClickableTokenAt(position: EditorPosition): ClickableToken | null
  }

  interface ClickableToken {
    displayText: string
    text: string
    type: string
    start: EditorPosition
    end: EditorPosition
  }

  interface Canvas {
    posCenter(): Point
    createTextNode(n: NewTextNode): unknown
    createFileNode(n: NewFileNode): unknown
  }

  interface NewTextNode {
    pos: Point
    size?: { width: number; height: number }
    position: string
    text: string
  }

  interface NewFileNode {
    pos: Point
    size?: { width: number; height: number }
    position: string
    file: TFile
  }

  interface ClipboardManager {
    handlePaste(e: ClipboardEvent): void
    handleDrop(e: DragEvent): void
  }
}
