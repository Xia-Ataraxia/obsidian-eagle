interface DataFileHost {
  loadData(): Promise<unknown>
  saveData(data: unknown): Promise<void>
}

/** Single owner of data.json: every write is load-merge-save on one queue, so concurrent owners never clobber each other. */
export class SerializedDataFile {
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly host: DataFileHost) {}

  /** `patch` runs when its turn comes, so it always writes the freshest in-memory state. */
  merge(patch: () => Record<string, unknown>): Promise<void> {
    const run = this.tail.then(async () => {
      const existing = (await this.host.loadData()) as Record<string, unknown> | null
      await this.host.saveData({ ...existing, ...patch() })
    })
    this.tail = run.catch(() => undefined)
    return run
  }
}
