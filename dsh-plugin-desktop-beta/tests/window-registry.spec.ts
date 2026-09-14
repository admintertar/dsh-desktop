import { expect, it, vi } from 'vitest'
import { DesktopWindowRegistry } from '../src/window-registry.ts'

const window = () => ({ show: vi.fn(), dispose: vi.fn(async () => {}) })

it('deduplicates concurrent opens and closes only the selected window', async () => {
  const registry = new DesktopWindowRegistry()
  const a = window(), b = window()
  const create = vi.fn(async () => a)
  await Promise.all([registry.open('a', create), registry.open('a', create), registry.open('b', async () => b)])
  expect(create).toHaveBeenCalledOnce()
  expect(a.show).toHaveBeenCalledOnce()
  await registry.close('a')
  expect(a.dispose).toHaveBeenCalledOnce()
  expect(b.dispose).not.toHaveBeenCalled()
  await registry.stop()
  expect(b.dispose).toHaveBeenCalledOnce()
  await expect(registry.open('c', async () => window())).rejects.toThrow('shutting down')
})

it('cancels an opening window and waits for it before accepting a replacement', async () => {
  const registry = new DesktopWindowRegistry()
  let ready!: () => void
  let signal!: AbortSignal
  const first = window(), replacement = window()
  const opening = registry.open('a', async value => {
    signal = value
    await new Promise<void>(resolve => { ready = resolve })
    return first
  })
  await Promise.resolve()
  const closing = registry.close('a')
  const reopen = registry.open('a', async () => replacement)
  expect(signal.aborted).toBe(true)
  ready()
  await Promise.all([opening, closing, reopen])
  expect(first.dispose).toHaveBeenCalledOnce()
  expect(replacement.dispose).not.toHaveBeenCalled()
  await registry.stop()
})

it('allows retry after boot failure and retains failed teardown for retry', async () => {
  const registry = new DesktopWindowRegistry()
  await expect(registry.open('a', async () => { throw new Error('boot') })).rejects.toThrow('boot')
  const a = window()
  a.dispose.mockRejectedValueOnce(new Error('stop'))
  await registry.open('a', async () => a)
  await expect(registry.close('a')).rejects.toThrow('stop')
  await registry.close('a')
  expect(a.dispose).toHaveBeenCalledTimes(2)
})
