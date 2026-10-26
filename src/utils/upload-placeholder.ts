/** The id keeps concurrent placeholders unique in the note; the editor hides it behind a chip. */
export const uploadPlaceholderFor = (id: string) => `![Uploading to Eagle...${id}]()`

export const UPLOAD_PLACEHOLDER_PATTERN = /!\[Uploading to Eagle\.\.\.[a-z0-9]+\]\(\)/g
