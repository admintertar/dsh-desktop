import { describe, expect, it, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({ runtimes: [] as any[], menu: vi.fn(), errors: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPreferredSystemLanguages: () => ['zh-CN'] },
  dialog: { showErrorBox: (...args: unknown[]) => state.errors(...args) },
  Menu: { buildFromTemplate: (value: unknown) => value, setApplicationMenu: (...args: unknown[]) => state.menu(...args) },
  nativeImage: {}, Tray: class {},
}))
vi.mock('../src/electron-runtime.ts', () => ({ ElectronDesktopRuntime: class {
  workspaceWindows: any
  locale = 'zh'
  scope: any
  configureTerminal = vi.fn()
  registerTrayItem = vi.fn()
  buildApplicationMenuItems = () => [{ label: 'Open DSH Terminal' }]
  show = vi.fn()
  prepareToQuit = vi.fn()
  mountScheduled = vi.fn()
  beginRendererBootMonitoring = async () => ({ report: { status: 'healthy' } })
  constructor(public restart: any, _report: any, _a: any, _b: any, _store: any, _c: any, scope: any) {
    this.scope = scope
    this.workspaceWindows = scope.windows
    state.runtimes.push(this)
  }
} }))
vi.mock('../src/host-process.ts', () => ({ startIsolatedDesktopHost: async (options: any) => {
  options.bindHost({ fiber: { dispose: vi.fn() } })
} }))
vi.mock('../src/desktop-runtime-environment.ts', () => ({ installDesktopPnpmRuntime: () => ({ dispose() {} }) }))
vi.mock('../src/packaged-runtime-path.ts', () => ({ packagedDependencyPath: () => '/test/pnpm.cjs' }))

import { DesktopWorkbench, type DesktopWorkbenchLaunch, type DesktopWorkbenchTarget } from '../src/workbench.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(() => { state.runtimes.length = 0; state.errors.mockClear(); state.menu.mockClear() })

describe('workspace application composition', () => {
  it('preserves native commands, binds each terminal to its Profile, and deduplicates projects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-menu-'))
    const launch = makeLaunch(root)
    const opened = vi.fn()
    const bench = new DesktopWorkbench({title: 'DSH Desktop', labels: locale => locale === 'zh' ? {open: '打开项目', close: '关闭项目', create: '新建项目', recent: '最近项目'} : {open: 'Open Project', close: 'Close Project', create: 'New Project', recent: 'Recent Projects'},
      create: async () => undefined, pick: async () => undefined, onOpened: opened,
      resolve: async id => ({id, title: id, prepare: async () => launch}),
    })
    try {
      await bench.open('a')
      await bench.open('a')
      expect(state.runtimes).toHaveLength(1)
      expect(state.runtimes[0].configureTerminal).toHaveBeenCalledWith({profileName: 'desktop', profileDir: join(root, 'profile'), homeDir: root})
      expect(opened).toHaveBeenCalledTimes(1)
      const menu = state.menu.mock.calls.at(-1)![0]
      expect(menu[0].submenu.some((item: any) => item.label === 'Open DSH Terminal')).toBe(true)
      expect(menu[1].submenu.map((item: any) => item.label).filter(Boolean)).toEqual(['新建项目', '打开项目', '最近项目', '关闭项目'])
      state.runtimes[0].locale = 'en'
      state.runtimes[0].scope.onMenuChange()
      const english = state.menu.mock.calls.at(-1)![0]
      expect(english[1].label).toBe('File')
      expect(english[1].submenu.map((item: any) => item.label).filter(Boolean)).toEqual(['New Project', 'Open Project', 'Recent Projects', 'Close Project'])
      expect(bench.locale).toBe('en')
      await bench.close('a')
      expect(state.runtimes[0].prepareToQuit).toHaveBeenCalledOnce()
    } finally { await bench.close('a'); rmSync(root, {recursive: true, force: true}) }
  })

  it('switches an existing destination through its own lifecycle before closing the source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-mode-'))
    const presentations = new Map([['a', 'advanced'], ['b', 'advanced']])
    const commits: string[] = []
    const resolve = async (id: string): Promise<DesktopWorkbenchTarget> => ({id, title: id,
      prepare: async () => ({...makeLaunch(join(root, id)), presentation: presentations.get(id)!}),
      selectPresentation: async (mode, directory) => ({target: directory ?? id, commit: async () => {
        const runtime = [...state.runtimes].reverse().find(value => value.id === id)
        expect(runtime.prepareToQuit).toHaveBeenCalledOnce()
        presentations.set(id, mode); commits.push(id)
      }}),
    })
    const bench = new DesktopWorkbench({title: 'DSH Desktop', labels: {open: 'Open', close: 'Close'}, pick: async () => undefined, resolve})
    try {
      await bench.open('a'); state.runtimes[0].id = 'a'
      await bench.open('b'); state.runtimes[1].id = 'b'
      await state.runtimes[0].workspaceWindows.selectPresentation('project', 'b')
      await vi.waitFor(() => expect(state.runtimes).toHaveLength(3))
      expect(commits).toEqual(['b'])
      expect(await state.runtimes[2].workspaceWindows.presentation()).toBe('project')
      expect(state.runtimes[0].prepareToQuit).toHaveBeenCalledOnce()
      expect(state.errors).not.toHaveBeenCalled()
    } finally { await bench.close('a'); await bench.close('b'); rmSync(root, {recursive: true, force: true}) }
  })
})

function makeLaunch(root: string): DesktopWorkbenchLaunch {
  return { homeDir: root, stateDir: join(root, 'electron'), cwd: root, environment: {}, presentation: 'project',
    prepared: {mode: 'advanced', openBrowser: false, networkExposure: 'loopback', profile: {name: 'desktop', dir: join(root, 'profile')}} as DesktopWorkbenchLaunch['prepared'],
    preferences: {mode: 'advanced', openBrowser: false, networkExposure: 'loopback', market: 'disabled', aaEnabled: false, notifications: {enabled: false}} as DesktopWorkbenchLaunch['preferences'] }
}
