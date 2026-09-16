import { MessageChannel } from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import { HostRpc } from '../src/host-rpc.ts'
import { bindNativeRuntime, createHostRuntime, runtimeSnapshot } from '../src/host-runtime-bridge.ts'
import type { DesktopRuntime, DesktopShellSpec, DesktopTrayItem } from '../src/runtime.ts'

it('carries shared theme handshakes, selections and cleanup over the existing Host RPC', async () => {
  const {port1, port2} = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({send: value => port.postMessage(value),
    listen: receive => {port.on('message', receive); return () => {port.off('message', receive)}}})) as [HostRpc, HostRpc]
  let apply!: (source: 'light' | 'dark' | 'system') => Promise<void>
  const disconnect = vi.fn()
  const native = {platform: 'darwin', locale: 'en', updates: {}, sharedTheme: {
    connect: vi.fn(async (_initial, callback) => {apply = callback; await apply('dark'); return disconnect}),
    select: vi.fn(async source => {await apply(source)}),
  }} as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    const runtime = createHostRuntime(child, runtimeSnapshot(native)), receive = vi.fn(async () => {})
    const stop = await runtime.sharedTheme!.connect('light', receive)
    expect(receive).toHaveBeenCalledWith('dark')
    await runtime.sharedTheme!.select('system')
    expect(receive).toHaveBeenLastCalledWith('system')
    await expect(child.call('theme:select', ['bad'])).rejects.toThrow('theme')
    expect(native.sharedTheme!.select).toHaveBeenCalledTimes(1)
    await stop()
    expect(disconnect).toHaveBeenCalledOnce()
  } finally {await release(); parent.close(); child.close(); port1.close(); port2.close()}
})

it('preserves the Web URL and authentication while projecting shell and tray callbacks', async () => {
  const { port1, port2 } = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({
    send: value => port.postMessage(value),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  })) as [HostRpc, HostRpc]
  let shell!: DesktopShellSpec
  let tray!: DesktopTrayItem
  const disposeShell = vi.fn(async () => {})
  const disposeTray = vi.fn()
  const native = {
    platform: 'win32', windowsBuild: 22631, locale: 'en',
    updates: { isPackaged: true, canDownload: true, currentVersion: '2.0.7-beta.1', statePath: '/tmp/update',
      request: vi.fn(async () => new Response('{"version":"2.0.8-beta.1"}', { headers: { 'x-test': 'yes' } })),
    },
    schedule: (value: DesktopShellSpec) => { shell = value; return disposeShell },
    registerTrayItem: (value: DesktopTrayItem) => { tray = value; return { refresh() {}, dispose: disposeTray } },
  } as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    const runtime = createHostRuntime(child, runtimeSnapshot(native))
    expect(runtime.workspaceWindows).toBeUndefined()
    let language: 'zh' | undefined
    const mode = vi.fn(async () => {})
    const invoke = vi.fn(async () => {})
    const spec = { url: 'http://127.0.0.1:1234/?dsh-desktop-mode=advanced',
      authenticationUrl: 'http://127.0.0.1:1234/?token=fixture',
      rendererAccessHeader: { name: 'x-dsh-desktop-renderer', value: 'fixture' },
      readLocalePreference: () => language, readThemeSource: () => 'dark',
      requestQuit() {}, requestModeChange: mode,
    } as unknown as DesktopShellSpec
    spec.readRemoteControl = vi.fn(async () => false)
    spec.enableRemoteControl = vi.fn(async () => {})
    const stopShell = runtime.schedule(spec)
    runtime.registerTrayItem({ group: 'tools', order: 1, label: () => 'Plugin action', invoke,
      submenu: () => [{ label: () => 'Child', invoke }] })
    language = 'zh'
    await runtime.mountScheduled()
    expect(await shell.readRemoteControl?.()).toBe(false)
    await shell.enableRemoteControl?.()
    expect(spec.enableRemoteControl).toHaveBeenCalledTimes(1)
    expect(shell.url).toBe(spec.url)
    expect(shell.authenticationUrl).toBe(spec.authenticationUrl)
    expect(shell.rendererAccessHeader).toEqual(spec.rendererAccessHeader)
    expect(shell.readLocalePreference()).toBe('zh')
    await shell.requestModeChange('extended')
    expect(mode).toHaveBeenCalledWith('extended')
    expect(tray.label()).toBe('Plugin action')
    await tray.submenu?.()[0]?.invoke()
    expect(invoke).toHaveBeenCalledOnce()
    const response = await runtime.updates.request('https://example.invalid', { headers: { accept: 'application/json' } })
    expect(response.headers.get('x-test')).toBe('yes')
    expect(await response.json()).toEqual({ version: '2.0.8-beta.1' })
    await stopShell()
    expect(disposeShell).toHaveBeenCalledOnce()
  } finally { await release(); parent.close(); child.close(); port1.close(); port2.close() }
})

it('projects only the workspace window capability granted to this Host', async () => {
  const { port1, port2 } = new MessageChannel()
  const [parent, child] = [port1, port2].map(port => new HostRpc({
    send: value => port.postMessage(value),
    listen: receive => { port.on('message', receive); return () => { port.off('message', receive) } },
  })) as [HostRpc, HostRpc]
  const windows = { list: vi.fn(async () => [{ id: 'a', title: 'A', current: true }]),
    open: vi.fn(async () => {}), focus: vi.fn(async (_id: string) => {}), close: vi.fn(async () => {}) }
  const native = { platform: 'darwin', locale: 'en', updates: {}, workspaceWindows: windows } as unknown as DesktopRuntime
  const release = bindNativeRuntime(parent, native)
  try {
    const runtime = createHostRuntime(child, runtimeSnapshot(native))
    expect(await runtime.workspaceWindows!.list()).toEqual([{ id: 'a', title: 'A', current: true }])
    await runtime.workspaceWindows!.open()
    await runtime.workspaceWindows!.focus('a')
    expect(windows.open).toHaveBeenCalledOnce()
    expect(windows.focus).toHaveBeenCalledWith('a')
    await expect(child.call('windows:focus', [42])).rejects.toThrow('identity')
    expect(windows.focus).toHaveBeenCalledOnce()
  } finally { await release(); parent.close(); child.close(); port1.close(); port2.close() }
})
