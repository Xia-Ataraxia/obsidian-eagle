/** `1 link`, `2 links` — English-only, regular plurals. */
export function countLabel(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`
}
