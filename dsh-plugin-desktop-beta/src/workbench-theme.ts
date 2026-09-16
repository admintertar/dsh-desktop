/** The Workbench owns one preference; individual project Homes remain independent. */
import {readFileSync} from 'node:fs'
import {writeFileAtomic} from '@deepseek-ai/dsh-atomic-write'
import type {DesktopSharedTheme, DesktopThemeSource} from './runtime.ts'

export function assertDesktopThemeSource(value: unknown): asserts value is DesktopThemeSource {
  if (value !== 'light' && value !== 'dark' && value !== 'system') throw new TypeError('Invalid shared theme preference')
}

/** Serialize choices and bootstrap handshakes, so an old Profile cannot reset newer shared state. */
export class WorkbenchTheme implements DesktopSharedTheme {
  private preference?: DesktopThemeSource
  private tail: Promise<unknown> = Promise.resolve()
  private readonly clients = new Set<(source: DesktopThemeSource) => Promise<void>>()

  constructor(private readonly path: string, private readonly applyNative: (source: DesktopThemeSource) => void) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (value?.version !== 1) throw new Error('Invalid shared theme state')
      assertDesktopThemeSource(value.preference)
      this.preference = value.preference
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  connect(initial: DesktopThemeSource, apply: (source: DesktopThemeSource) => Promise<void>) {
    return this.enqueue(async () => {
      assertDesktopThemeSource(initial)
      if (this.preference === undefined) await this.persist(initial)
      const source = this.preference!
      await apply(source)
      this.applyNative(source)
      this.clients.add(apply)
      return () => { this.clients.delete(apply) }
    })
  }

  select(source: DesktopThemeSource): Promise<void> {
    return this.enqueue(async () => {
      assertDesktopThemeSource(source)
      if (source !== this.preference) await this.persist(source)
      this.applyNative(source)
      // A failed/closing Host must not prevent healthy peers from receiving the choice.
      const results = await Promise.allSettled([...this.clients].map(apply => Promise.resolve().then(() => apply(source))))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Some windows could not synchronize their theme')
    })
  }

  private async persist(preference: DesktopThemeSource): Promise<void> {
    await writeFileAtomic(this.path, JSON.stringify({version: 1, preference}) + '\n', {mode: 0o600, dirMode: 0o700})
    this.preference = preference
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }
}
