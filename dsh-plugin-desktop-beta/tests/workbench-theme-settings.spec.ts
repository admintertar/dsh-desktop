import {describe, expect, it, vi} from 'vitest'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SettingsProvider, type SettingsNamespace} from '@deepseek-ai/dsh-settings'
import * as uiTheme from '@deepseek-ai/dsh-client-ui-theme'
import type {DesktopSharedTheme} from '../src/runtime.ts'
import {WorkbenchTheme} from '../src/workbench-theme.ts'
import {connectWorkbenchThemeSettings} from '../src/workbench-theme-settings.ts'

function host(preference: 'dark' | 'light' | 'system', fontSize: number) {
  let value = {preference, fontSize}
  const listeners = new Set<(namespace: string, next: typeof value, prev: typeof value) => void>()
  const settings = {
    get: () => value,
    update: vi.fn(async (namespace: string, patch: Partial<typeof value>) => {
      const previous = value
      value = {...value, ...patch}
      listeners.forEach(listener => listener(namespace, value, previous))
    }),
  }
  const ctx = {settings, logger: {error: vi.fn()}, on: (_event: string, listener: typeof listeners extends Set<infer T> ? T : never) => {
    listeners.add(listener); return () => {listeners.delete(listener)}
  }} as unknown as Context
  return {ctx, settings, listeners}
}

describe('Workbench theme settings binding', () => {
  it('uses the official settings queue and theme namespace without echoing its own commits', async () => {
    class MemorySettings extends SettingsProvider {
      get writable() { return true }
      protected async load() { return {} }
      protected async persist(_namespace: SettingsNamespace, _section: Record<string, unknown>) {
        // Leave a real async boundary, just as the file provider does during persistence.
        await new Promise(resolve => setImmediate(resolve))
      }
    }
    const root = mkdtempSync(join(tmpdir(), 'workbench-official-theme-'))
    const a = new Context(), b = new Context()
    const theme = new WorkbenchTheme(join(root, 'state.json'), vi.fn())
    const select = vi.spyOn(theme, 'select')
    const stops: (() => Promise<void>)[] = []
    try {
      for (const ctx of [a, b]) {await ctx.plugin(MemorySettings); await ctx.plugin(uiTheme)}
      await a.settings.update('ui-theme', {preference: 'dark', fontSize: 14})
      await b.settings.update('ui-theme', {preference: 'light', fontSize: 17})
      stops.push(await connectWorkbenchThemeSettings(a, theme), await connectWorkbenchThemeSettings(b, theme))
      expect(select).not.toHaveBeenCalled()
      expect(b.settings.get('ui-theme')).toEqual({preference: 'dark', fontSize: 17})
      await Promise.all([
        a.settings.update('ui-theme', {preference: 'light'}),
        b.settings.update('ui-theme', {preference: 'system'}),
      ])
      await vi.waitFor(() => {
        expect(a.settings.get('ui-theme')).toEqual({preference: 'system', fontSize: 14})
        expect(b.settings.get('ui-theme')).toEqual({preference: 'system', fontSize: 17})
      })
      expect(select).toHaveBeenCalledTimes(2)
    } finally {
      await Promise.all(stops.map(stop => stop()))
      await a.fiber.dispose(); await b.fiber.dispose()
      rmSync(root, {recursive: true, force: true})
    }
  })

  it('synchronizes the official preference without echoes, unrelated settings or stale Profile resets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-theme-settings-'))
    const theme = new WorkbenchTheme(join(root, 'state.json'), vi.fn())
    const select = vi.spyOn(theme, 'select')
    const a = host('dark', 14), b = host('light', 17)
    const stopA = await connectWorkbenchThemeSettings(a.ctx, theme)
    const stopB = await connectWorkbenchThemeSettings(b.ctx, theme)
    try {
      expect(b.settings.get()).toEqual({preference: 'dark', fontSize: 17})
      expect(select).not.toHaveBeenCalled()
      await b.settings.update('ui-theme', {preference: 'light'})
      await vi.waitFor(() => expect(a.settings.get()).toEqual({preference: 'light', fontSize: 14}))
      expect(select).toHaveBeenCalledTimes(1)
      await a.settings.update('ui-theme', {fontSize: 12})
      expect(select).toHaveBeenCalledTimes(1)
      await Promise.all([a.settings.update('ui-theme', {preference: 'dark'}), b.settings.update('ui-theme', {preference: 'system'})])
      await vi.waitFor(() => {
        expect(a.settings.get().preference).toBe('system')
        expect(b.settings.get().preference).toBe('system')
      })
      expect(select).toHaveBeenCalledTimes(3)
      expect(a.settings.get().fontSize).toBe(12)
      expect(b.settings.get().fontSize).toBe(17)
      await stopB()
      await theme.select('dark')
      expect(a.settings.get().preference).toBe('dark')
      expect(b.settings.get().preference).toBe('system')
      expect(b.listeners.size).toBe(0)
    } finally {await stopA(); await stopB(); rmSync(root, {recursive: true, force: true})}
  })

  it('removes observers on startup failure and reports later synchronization failures', async () => {
    const a = host('dark', 14)
    const failed: DesktopSharedTheme = {connect: vi.fn(async () => {throw new Error('cannot connect')}), select: vi.fn()}
    await expect(connectWorkbenchThemeSettings(a.ctx, failed)).rejects.toThrow('cannot connect')
    expect(a.listeners.size).toBe(0)
    const disconnect = vi.fn()
    const theme: DesktopSharedTheme = {connect: async () => disconnect, select: async () => {throw new Error('disk full')}}
    const stop = await connectWorkbenchThemeSettings(a.ctx, theme)
    await a.settings.update('ui-theme', {preference: 'light'})
    await vi.waitFor(() => expect(a.ctx.logger.error).toHaveBeenCalled())
    await stop()
    await stop()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(a.listeners.size).toBe(0)
  })
})
