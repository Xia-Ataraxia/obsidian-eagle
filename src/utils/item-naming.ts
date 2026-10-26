import { generatePseudoRandomId } from './pseudo-random'

/** Stamped on every upload; the picker hides it since it would repeat on every card. */
export const UPLOAD_ANNOTATION = 'Added via Obsidian Eagle Plugin'

export interface ItemNameContext {
  originalName: string
  noteName: string
}

function currentDateString(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Resolve the Eagle item name from a template string.
 *
 * Supported tokens:
 *   {originalName} — original filename without extension
 *   {noteName}     — active note basename
 *   {date}         — YYYY-MM-DD (today)
 *   {uuid}         — short random ID (5 chars)
 *
 * Falls back to the original name when the resolved string is empty.
 */
export function resolveItemName(template: string, context: ItemNameContext): string {
  const uuid = generatePseudoRandomId()
  const resolved = template
    .replaceAll('{originalName}', context.originalName)
    .replaceAll('{noteName}', context.noteName)
    .replaceAll('{date}', currentDateString())
    .replaceAll('{uuid}', uuid)
    .trim()

  return resolved || context.originalName
}
