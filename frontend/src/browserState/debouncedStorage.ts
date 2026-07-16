export class DebouncedStorageWriter<T> {
  private pending: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private lastWritten: string | undefined

  constructor(
    private readonly storage: Storage,
    private readonly key: string,
    private readonly delay = 120,
  ) {}

  schedule(value: T) {
    this.pending = JSON.stringify(value)
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delay)
  }

  flush() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const pending = this.pending
    this.pending = undefined
    if (pending === undefined || pending === this.lastWritten) return
    this.storage.setItem(this.key, pending)
    this.lastWritten = pending
  }

  dispose() {
    this.flush()
  }
}
