/** Opt-in enhanced multi-window application. The ordinary Desktop launcher is unchanged. */
import { app, dialog, Menu, nativeImage, Tray } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { ElectronDesktopRuntime } from './electron-runtime.ts'
import { FileMainWindowStateStore } from './main-window-state.ts'
import { DesktopWindowRegistry, type ManagedDesktopWindow } from './window-registry.ts'
import { startIsolatedDesktopHost } from './host-process.ts'
import { createDesktopBrowserAccess } from './desktop-browser-access.ts'
import { installDesktopPnpmRuntime } from './desktop-runtime-environment.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import { desktopReleaseUserDataLocations } from './profile-channel-admission.ts'
import { desktopProfilePreferencesFromSettings } from './profile-preferences.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import type { PreparedDesktopProfile } from './profile.ts'
import type { DesktopStartupGenerationHost } from './startup-generation.ts'
import type { DesktopProfilePreferences } from './profile-preferences.ts'

export interface DesktopWorkbenchLaunch {
  prepared: PreparedDesktopProfile
  preferences: DesktopProfilePreferences
  homeDir: string
  stateDir: string
  cwd: string
  environment: NodeJS.ProcessEnv
}
export interface DesktopWorkbenchTarget {
  id: string
  title: string
  prepare(): Promise<DesktopWorkbenchLaunch>
}
export interface DesktopWorkbenchOptions {
  title: string
  labels: { menu: string; open: string; close: string }
  resolve(target: string): Promise<DesktopWorkbenchTarget>
  pick(): Promise<string | undefined>
  onChange?(windows: readonly { id: string; title: string; status: string }[]): void
}
interface Window extends ManagedDesktopWindow {
  runtime: ElectronDesktopRuntime
  title: string
  target: string
  status: string
}

/** One app lock, one menu and one tray; each enhanced window owns its Host. */
export class DesktopWorkbench {
  private readonly registry = new DesktopWindowRegistry<Window>()
  private readonly windows = new Map<string, Window>()
  private active: string | undefined
  private tray?: Tray
  private quitting = false
  private started = false
  private quitTask: Promise<void> | undefined
  private picker: Promise<void> | undefined

  constructor(private readonly options: DesktopWorkbenchOptions) {}

  async open(target: string): Promise<void> {
    const descriptor = await this.options.resolve(target)
    await this.registry.open(descriptor.id, async signal => {
      const launch = await descriptor.prepare()
      signal.throwIfAborted()
      if (launch.prepared.mode !== 'advanced' || launch.prepared.openBrowser || launch.prepared.networkExposure !== 'loopback') {
        throw new Error('This workbench requires an enhanced local-only Profile')
      }
      const environment = { ...launch.environment, DSH_HOME: launch.homeDir,
        DSH_AGENTS_HOME: join(launch.homeDir, 'agents') }
      delete (environment as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE
      const pnpmBinPath = packagedDependencyPath(import.meta.url, 'pnpm/bin/pnpm.mjs')
      const electronVersion = process.versions.electron!
      mkdirSync(launch.stateDir, { recursive: true, mode: 0o700 })
      const pnpm = installDesktopPnpmRuntime({ platform: process.platform, appExecutable: process.execPath,
        pnpmBinPath, electronVersion, stateDir: join(launch.stateDir, 'runtime-commands'), environment })
      const id = descriptor.id
      let host: DesktopStartupGenerationHost | undefined
      const runtime = new ElectronDesktopRuntime(async targetMode => {
        if (targetMode) throw new Error('Recovery launches require the ordinary Desktop launcher')
        await this.close(id)
        await this.open(target)
      }, report => {
        const window = this.windows.get(id)
        if (window) { window.status = report.status; this.changed() }
        return true
      }, undefined, undefined, new FileMainWindowStateStore(launch.stateDir), undefined, {
        title: descriptor.title, stateDir: launch.stateDir,
        partition: `persist:dsh-workbench-${createHash('sha256').update(id).digest('hex')}`,
        onFocus: () => { this.active = id; this.changed() },
        requestClose: () => { this.report(this.close(id)) },
        windows: {
          list: async () => [...this.windows].map(([key, value]) => ({ id: key, title: value.title, current: key === id })),
          open: () => this.pick(),
          focus: async key => { const window = this.windows.get(key); if (!window) throw new Error('Window is no longer open'); window.show() },
          close: () => this.close(id),
        },
      })
      const window: Window = { runtime, title: descriptor.title, target, status: 'starting',
        show: () => runtime.show(),
        dispose: async () => {
          runtime.prepareToQuit()
          await host?.fiber.dispose()
          pnpm.dispose()
          this.windows.delete(id)
          if (this.active === id) this.active = [...this.windows.keys()].at(-1)
          this.changed()
        },
      }
      this.windows.set(id, window)
      this.active = id
      this.changed()
      try {
        const access = createDesktopBrowserAccess(false)
        const prepared = launch.prepared
        // Keep the shared application presentation fixed while retaining ordinary
        // provider/theme/chat settings in each Host.
        await startIsolatedDesktopHost({
          cwd: launch.cwd, environment, runtime, rendererToken: access.rendererHeader.value,
          host: { prepared, loadProjectEnvironment: true,
            profilePreferences: desktopProfilePreferencesFromSettings(launch.preferences, launch.preferences.notifications, launch.preferences.market),
            homeDir: launch.homeDir, activeProfileName: prepared.profile.name,
            pluginManagementStatePath: join(launch.stateDir, 'plugin-management/state.json'),
            selectionStatePath: join(launch.stateDir, 'profile-selection/state.json'),
            marketUserDataDir: launch.stateDir,
            releaseUserDataLocations: desktopReleaseUserDataLocations(join(launch.stateDir, 'editions'), launch.stateDir),
            desktopLaunchEnvironment: createLaunchEnvironmentSnapshot([{ source: 'process', values: environment }]),
            desktopPnpmBootstrap: { activeProfileName: prepared.profile.name, activeProfileDir: prepared.profile.dir,
              homeDir: launch.homeDir, appExecutable: process.execPath, pnpmBinPath, electronVersion,
              nodeBinDir: pnpm.nodeBinDir, nodeShimPath: pnpm.nodeShimPath,
              clearEnvironmentPath: pnpm.clearEnvironmentPath,
              dshBootstrapPath: fileURLToPath(new URL('./desktop-cli.js', import.meta.url)) },
            logDirectory: join(launch.stateDir, 'logs/host'),
          },
          prepareCertificate: async () => { throw new Error('Workbench windows use loopback HTTP only') },
          bindHost: value => { host = value },
          requestQuit: () => { this.report(this.close(id)) },
          onFailure: error => { window.status = 'failed'; this.changed(); this.report(Promise.reject(error)) },
        })
        signal.throwIfAborted()
        const health = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {} })
        // Observe rejection immediately, including failures during native mount.
        const monitored = health.then(value => ({ value }), error => ({ error }))
        await runtime.mountScheduled()
        const verdict = await monitored
        if ('error' in verdict) throw verdict.error
        if (verdict.value.report.status !== 'healthy') throw new Error('Window renderer failed to become healthy')
        signal.throwIfAborted()
        return window
      } catch (error) {
        await window.dispose()
        throw error
      }
    })
  }

  close(id: string): Promise<void> { return this.registry.close(id) }

  pick(): Promise<void> {
    return this.picker ??= (async () => {
      const target = await this.options.pick()
      if (target) await this.open(target)
    })().finally(() => { this.picker = undefined })
  }

  private report(operation: Promise<unknown>): void {
    void operation.catch(error => {
      console.error(error)
      dialog.showErrorBox(this.options.title, error instanceof Error ? error.message : String(error))
    })
  }

  private changed(): void {
    this.options.onChange?.([...this.windows].map(([id, window]) => ({ id, title: window.title, status: window.status })))
    const open = { label: this.options.labels.open, accelerator: 'CmdOrCtrl+O', click: () => this.report(this.pick()) }
    const windows = [...this.windows].map(([id, window]) => ({ label: window.title, type: 'checkbox' as const,
      checked: id === this.active, click: () => window.show() }))
    const current = this.active
    const close = { label: this.options.labels.close, accelerator: 'CmdOrCtrl+W', enabled: Boolean(current),
      click: () => { if (current) this.report(this.close(current)) } }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: this.options.title, submenu: [{ role: 'about' as const }, { role: 'quit' as const }] }] : []),
      { label: this.options.labels.menu, submenu: [open, close, { type: 'separator' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'togglefullscreen' }, { type: 'separator' }, ...windows] },
    ]))
    this.tray?.setContextMenu(Menu.buildFromTemplate([open, ...windows, { type: 'separator' }, { role: 'quit' }]))
  }

  /** Install application-wide handlers exactly once, after Electron is ready. */
  start(): void {
    if (this.started) throw new Error('Workbench application handlers are already installed')
    this.started = true
    const iconRoot = fileURLToPath(new URL('../build/', import.meta.url))
    const icon = nativeImage.createFromPath(join(iconRoot, process.platform === 'darwin' ? 'app-icon-mac.png' : 'app-icon.png'))
    app.dock?.setIcon(icon)
    this.tray = new Tray(prepareTrayIcon({ templatePath: join(iconRoot, 'tray-iconTemplate.png'), bluePath: join(iconRoot, 'tray-icon-blue.png') }, process.platform as 'darwin' | 'win32' | 'linux'))
    this.tray.setToolTip(this.options.title)
    const activate = () => { const active = this.active && this.windows.get(this.active); if (active) active.show(); else this.report(this.pick()) }
    this.tray.on('click', activate)
    app.on('activate', activate)
    app.on('window-all-closed', () => {})
    app.on('before-quit', event => {
      if (this.quitting) return
      event.preventDefault()
      this.quitTask ??= this.registry.stop().then(() => {
        this.tray?.destroy(); this.quitting = true; app.quit()
      }).catch(error => { this.quitTask = undefined; this.report(Promise.reject(error)) })
    })
    this.changed()
  }
}
