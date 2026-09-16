/** Serialize lifetime operations per window while allowing independent windows. */
export interface ManagedDesktopWindow {
  show(): void
  dispose(): Promise<void>
}

interface Entry<T> {
  opening: Promise<T>
  closing?: Promise<void> | undefined
  controller: AbortController
}

class WindowStopError extends Error {}

export class DesktopWindowRegistry<T extends ManagedDesktopWindow> {
  private readonly entries = new Map<string, Entry<T>>()
  private stopping = false

  async open(id: string, create: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error('Desktop is shutting down')
    const existing = this.entries.get(id)
    if (existing?.closing) { await existing.closing; return this.open(id, create) }
    if (existing) { const window = await existing.opening; window.show(); return window }
    return this.createEntry(id, create)
  }

  /** Reserve the successor before releasing the old window, so another open cannot bypass maintenance. */
  async restart(id: string, create: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error('Desktop is shutting down')
    const previous = this.entries.get(id)
    if (!previous) return this.open(id, create)
    const stopped = this.close(id)
    return this.createEntry(id, async signal => {
      try { await stopped }
      catch (error) {
        // Retain ownership of a window whose teardown failed; a later close must retry it.
        if (this.entries.get(id)?.controller.signal === signal) this.entries.set(id, previous)
        throw new WindowStopError(error instanceof Error ? error.message : String(error), {cause: error})
      }
      signal.throwIfAborted()
      return create(signal)
    })
  }

  private async createEntry(id: string, create: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const entry: Entry<T> = { controller, opening: Promise.resolve().then(() => create(controller.signal)) }
    this.entries.set(id, entry)
    try { return await entry.opening }
    catch (error) { if (this.entries.get(id) === entry) this.entries.delete(id); throw error }
  }

  close(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) return Promise.resolve()
    if (entry.closing) return entry.closing
    entry.controller.abort()
    entry.closing = (async () => {
      let window: T
      try { window = await entry.opening }
      catch (error) {
        // A failed boot has no window; a failed restart can still own its predecessor.
        if (error instanceof WindowStopError) throw error
        return
      }
      await window.dispose()
      if (this.entries.get(id) === entry) this.entries.delete(id)
    })().catch(error => { entry.closing = undefined; throw error })
    return entry.closing
  }

  async stop(): Promise<void> {
    this.stopping = true
    const results = await Promise.allSettled([...this.entries.keys()].map(id => this.close(id)))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) { this.stopping = false; throw new AggregateError(failures, 'Some windows did not stop') }
  }
}
