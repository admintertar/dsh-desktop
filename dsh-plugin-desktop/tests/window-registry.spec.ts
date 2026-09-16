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

it('reserves maintenance while the old window is stopping and deduplicates a simultaneous open', async () => {
  const registry = new DesktopWindowRegistry()
  const first = window(), next = window()
  let stopped!: () => void
  first.dispose.mockImplementation(() => new Promise<void>(resolve => { stopped = resolve }))
  await registry.open('a', async () => first)
  const maintain = vi.fn(async () => next), unwanted = vi.fn(async () => window())
  const restarting = registry.restart('a', maintain)
  const opening = registry.open('a', unwanted)
  await Promise.resolve()
  expect(maintain).not.toHaveBeenCalled()
  stopped()
  await Promise.all([restarting, opening])
  expect(maintain).toHaveBeenCalledOnce()
  expect(unwanted).not.toHaveBeenCalled()
  await registry.stop()
})

it('cancels a reserved restart before maintenance begins', async () => {
  const registry = new DesktopWindowRegistry()
  const first = window()
  let stopped!: () => void
  first.dispose.mockImplementation(() => new Promise<void>(resolve => { stopped = resolve }))
  await registry.open('a', async () => first)
  const maintain = vi.fn(async () => window())
  const restarting = registry.restart('a', maintain)
  const rejected = expect(restarting).rejects.toMatchObject({name: 'AbortError'})
  const closing = registry.close('a')
  await Promise.resolve()
  stopped()
  await Promise.all([rejected, closing])
  expect(maintain).not.toHaveBeenCalled()
})

it('keeps the old window owned when restart teardown fails', async () => {
  const registry = new DesktopWindowRegistry()
  const first = window(), maintain = vi.fn(async () => window())
  first.dispose.mockRejectedValueOnce(new Error('cannot stop'))
  await registry.open('a', async () => first)
  await expect(registry.restart('a', maintain)).rejects.toThrow('cannot stop')
  expect(maintain).not.toHaveBeenCalled()
  await registry.close('a')
  expect(first.dispose).toHaveBeenCalledTimes(2)
})

it('reports a failed predecessor teardown when the application quits during restart', async () => {
  const registry = new DesktopWindowRegistry()
  const first = window(), maintain = vi.fn(async () => window())
  let failStop!: (error: Error) => void
  first.dispose.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {failStop = reject}))
  await registry.open('a', async () => first)
  const restarting = registry.restart('a', maintain)
  const rejected = expect(restarting).rejects.toThrow('cannot stop')
  const quitting = expect(registry.stop()).rejects.toThrow('Some windows did not stop')
  await Promise.resolve()
  failStop(new Error('cannot stop'))
  await Promise.all([rejected, quitting])
  expect(maintain).not.toHaveBeenCalled()
  await registry.stop()
  expect(first.dispose).toHaveBeenCalledTimes(2)
})
