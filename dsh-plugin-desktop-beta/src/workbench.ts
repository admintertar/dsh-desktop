/** Opt-in multi-window application. The ordinary Desktop launcher is unchanged. */
import { app, dialog, Menu, nativeImage, Tray } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { desktopProductVersion, ElectronDesktopRuntime } from './electron-runtime.ts'
import { dshProductVersion } from './dsh-product-version.ts'
import { DESKTOP_PACKAGE_NAME, DESKTOP_RELEASE_CHANNEL } from './product-identity.ts'
import { DesktopProfileCheckpoint } from './profile-checkpoint.ts'
import { maskSecrets } from './mask-secrets.ts'
import { FileMainWindowStateStore } from './main-window-state.ts'
import { DesktopWindowRegistry, type ManagedDesktopWindow } from './window-registry.ts'
import { startIsolatedDesktopHost } from './host-process.ts'
import { createDesktopBrowserAccess } from './desktop-browser-access.ts'
import { installDesktopPnpmRuntime } from './desktop-runtime-environment.ts'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import { desktopReleaseUserDataLocations } from './profile-channel-admission.ts'
import { desktopProfilePreferencesFromSettings } from './profile-preferences.ts'
import { macApplicationMenuTemplate, nativeMenuLocale } from './native-menu.ts'
import { desktopTrayLabel } from './tray-locale.ts'
import { resetDesktopSafeModeEnvironment, DESKTOP_SAFE_MODE_PROFILE_NAME } from './safe-mode.ts'
import { createDesktopWebProfile, selectDesktopProfile } from './profile-manager.ts'
import { prepareTrayIcon } from './tray-icons.ts'
import type { PreparedDesktopProfile } from './profile.ts'
import type { DesktopStartupGenerationHost } from './startup-generation.ts'
import type { DesktopLocale } from './runtime.ts'
import type { DesktopProfilePreferences } from './profile-preferences.ts'

/** Available before Profile composition, including when its configuration cannot be parsed. */
export interface DesktopWorkbenchEnvironment {
  homeDir: string
  stateDir: string
  cwd: string
  environment: NodeJS.ProcessEnv
}
export interface DesktopWorkbenchLaunch extends DesktopWorkbenchEnvironment {
  prepared: PreparedDesktopProfile
  presentation?: string
  preferences: DesktopProfilePreferences
}
export interface DesktopWorkbenchTarget {
  id: string
  title: string
  recovery?: DesktopWorkbenchEnvironment
  prepare(): Promise<DesktopWorkbenchLaunch>
  setup?(launch: DesktopWorkbenchLaunch, signal: AbortSignal): Promise<DesktopWorkbenchLaunch | undefined>
  selectPresentation?(mode: string, directory?: string): Promise<{ target: string; commit(): Promise<void> } | undefined>
}
export interface DesktopWorkbenchOptions {
  title: string
  labels: { open: string; close: string; create?: string; recent?: string } | ((locale: DesktopLocale) => { open: string; close: string; create?: string; recent?: string })
  resolve(target: string): Promise<DesktopWorkbenchTarget>
  pick(): Promise<string | undefined>
  create?(): Promise<string | undefined>
  recent?(): readonly { path: string; title: string }[]
  onOpened?(target: string, title: string): void
  /** Resolve only after the maintenance process has exited; restart reopens this project. */
  recover?(mode: 'recovery' | 'safe-mode', environment: DesktopWorkbenchEnvironment,
    signal: AbortSignal, failureDetail?: string): Promise<'restart' | 'cancelled'>
  onChange?(windows: readonly { id: string; title: string; status: string }[]): void
}
interface Window extends ManagedDesktopWindow {
  runtime: ElectronDesktopRuntime
  title: string
  target: string
  status: string
}

/** A still-live Host must never share its Profile with a recovery process. */
class WorkbenchStopError extends Error {}

/** One app lock, one menu and one tray; each window owns its Host. */
export class DesktopWorkbench {
  private readonly registry = new DesktopWindowRegistry<Window>()
  private readonly windows = new Map<string, Window>()
  private readonly blockedWindows = new Map<string, Window>()
  private active: string | undefined
  private tray?: Tray
  private quitting = false
  private started = false
  private quitTask: Promise<void> | undefined
  private picker: Promise<void> | undefined

  constructor(private readonly options: DesktopWorkbenchOptions) {}

  async open(target: string): Promise<void> {
    await this.openTarget(target)
  }

  /** Keep maintenance and retries inside the same per-project registry reservation. */
  private async openTarget(target: string, maintenance?: {mode: 'recovery' | 'safe-mode'; environment: DesktopWorkbenchEnvironment}, restart = false): Promise<void> {
    const descriptor = await this.options.resolve(target)
    const register = restart ? this.registry.restart.bind(this.registry) : this.registry.open.bind(this.registry)
    await register(descriptor.id, async signal => {
      const blocked = this.blockedWindows.get(descriptor.id)
      if (blocked) {
        await blocked.dispose()
        this.blockedWindows.delete(descriptor.id)
      }
      let recovery = descriptor.recovery
      let request = maintenance
      let failureDetail: string | undefined
      for (;;) {
        signal.throwIfAborted()
        if (request) {
          if (!this.options.recover) throw new Error('Recovery launcher is unavailable')
          const result = await this.options.recover(request.mode, request.environment, signal, failureDetail)
          signal.throwIfAborted()
          if (result !== 'restart') throw new DOMException('Recovery was closed', 'AbortError')
          request = undefined
        }
        try {
          return await this.openWindow(target, descriptor, signal, launch => { recovery = launch })
        } catch (error) {
          if (signal.aborted || (error instanceof Error && error.name === 'AbortError')
            || error instanceof WorkbenchStopError || !this.options.recover || !recovery) throw error
          failureDetail = maskSecrets(error instanceof Error ? error.message : String(error))
          request = {mode: 'recovery', environment: recovery}
        }
      }
    })
  }

  private async openWindow(target: string, descriptor: DesktopWorkbenchTarget, signal: AbortSignal,
    prepared: (launch: DesktopWorkbenchLaunch) => void): Promise<Window> {
    let launch = await descriptor.prepare()
    prepared(launch)
    signal.throwIfAborted()
    if (descriptor.setup) {
      const configured = await descriptor.setup(launch, signal)
      if (!configured) throw new DOMException('Setup was closed', 'AbortError')
      launch = configured
      prepared(launch)
      signal.throwIfAborted()
    }
    if (launch.prepared.openBrowser || launch.prepared.networkExposure !== 'loopback') {
      throw new Error('Workbench windows require local-only access')
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
      if (targetMode && !this.options.recover) throw new Error('Recovery launcher is unavailable')
      await this.openTarget(target, targetMode ? {mode: targetMode, environment: launch} : undefined, true)
    }, report => {
      const window = this.windows.get(id)
      if (window) { window.status = report.status; this.changed() }
      return true
    }, undefined, undefined, new FileMainWindowStateStore(launch.stateDir), undefined, {
      title: descriptor.title, stateDir: launch.stateDir,
      partition: `persist:dsh-workbench-${createHash('sha256').update(id).digest('hex')}`,
      onFocus: () => { this.active = id; this.changed() },
      onMenuChange: () => this.changed(),
      requestClose: () => { this.report(this.close(id)) },
      windows: {
        list: async () => [...this.windows].map(([key, value]) => ({ id: key, title: value.title, current: key === id })),
        open: () => this.pick(),
        focus: async key => { const window = this.windows.get(key); if (!window) throw new Error('Window is no longer open'); window.show() },
        close: () => this.close(id),
        presentation: async () => launch.presentation ?? launch.prepared.mode,
        selectPresentation: async (mode, directory) => {
          if (!descriptor.selectPresentation) throw new Error('Presentation selection is unavailable')
          const selection = await descriptor.selectPresentation(mode, directory)
          if (!selection) return
          // Acknowledge the originating Host before closing its RPC channel.
          setImmediate(() => this.report((async () => {
            const destination = await this.options.resolve(selection.target)
            if (destination.id !== id) {
              // Deduplicate/open the destination before touching its Profile.
              await this.open(selection.target)
              const other = this.windows.get(destination.id)!
              if (await other.runtime.workspaceWindows!.presentation!() !== mode) {
                await other.runtime.workspaceWindows!.selectPresentation!(mode)
              }
              other.show()
              await this.close(id)
              return
            }
            await this.close(id)
            await selection.commit()
            await this.open(selection.target)
          })()))
        },
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
    runtime.configureTerminal({ profileName: launch.prepared.profile.name,
      profileDir: launch.prepared.profile.dir, homeDir: launch.homeDir })
    runtime.registerTrayItem({ group: 'tools', order: 100,
      label: () => desktopTrayLabel(runtime.locale, 'enterSafeMode'), invoke: () => runtime.requestSafeModeRestart() })
    this.windows.set(id, window)
    this.active = id
    this.changed()
    try {
      const access = createDesktopBrowserAccess(false)
      const prepared = launch.prepared
      await startIsolatedDesktopHost({
        cwd: launch.cwd, environment, runtime, rendererToken: access.rendererHeader.value,
        host: { prepared, loadProjectEnvironment: true,
          profilePreferences: desktopProfilePreferencesFromSettings(launch.preferences, launch.preferences.notifications, launch.preferences.market, launch.preferences.aaEnabled === true),
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
        onFailure: error => {
          const starting = window.status === 'starting'
          window.status = 'failed'; this.changed()
          if (!starting) this.report(Promise.reject(error))
        },
      })
      signal.throwIfAborted()
      const health = runtime.beginRendererBootMonitoring({ commitHealthy: async () => {
        signal.throwIfAborted()
        try {
          new DesktopProfileCheckpoint({userDataDir: launch.stateDir, homeDir: launch.homeDir,
            profileDir: launch.prepared.profile.dir, profileName: launch.prepared.profile.name,
            provider: 'desktop-profile', appVersion: desktopProductVersion(),
            desktopPackageName: DESKTOP_PACKAGE_NAME, releaseChannel: DESKTOP_RELEASE_CHANNEL,
            dshVersion: dshProductVersion(),
          }).captureHealthy()
        } catch (error) {
          // Match ordinary Desktop: snapshot I/O failure must not discard a healthy window.
          console.error(maskSecrets(`Failed to checkpoint ${descriptor.title}: ${error instanceof Error ? error.message : String(error)}`))
        }
      } })
      // Observe rejection immediately, including failures during native mount.
      const monitored = health.then(value => ({ value }), error => ({ error }))
      await runtime.mountScheduled()
      const verdict = await monitored
      if ('error' in verdict) throw verdict.error
      if (verdict.value.report.status !== 'healthy') throw new Error('Window renderer failed to become healthy')
      signal.throwIfAborted()
      this.options.onOpened?.(target, descriptor.title)
      this.changed()
      return window
    } catch (error) {
      try { await window.dispose() }
      catch (stopError) {
        this.blockedWindows.set(id, window)
        throw new WorkbenchStopError('Project Host termination was not confirmed; recovery was not started', {cause: stopError})
      }
      throw error
    }
  }

  async close(id: string): Promise<void> {
    await this.registry.close(id)
    const blocked = this.blockedWindows.get(id)
    if (blocked) { await blocked.dispose(); this.blockedWindows.delete(id) }
  }

  pick(): Promise<void> {
    return this.picker ??= (async () => {
      const target = await this.options.pick()
      if (target) await this.open(target)
    })().finally(() => { this.picker = undefined })
  }

  get locale(): DesktopLocale {
    const active = this.active ? this.windows.get(this.active) : undefined
    return active?.runtime.locale ?? (nativeMenuLocale(app.getPreferredSystemLanguages()) === 'zh-CN' ? 'zh' : 'en')
  }

  private report(operation: Promise<unknown>): void {
    void operation.catch(error => {
      if (error instanceof Error && error.name === 'AbortError') return
      console.error(error)
      dialog.showErrorBox(this.options.title, error instanceof Error ? error.message : String(error))
    })
  }

  private changed(): void {
    this.options.onChange?.([...this.windows].map(([id, window]) => ({ id, title: window.title, status: window.status })))
    const labels = typeof this.options.labels === 'function' ? this.options.labels(this.locale) : this.options.labels
    const open = { label: labels.open, accelerator: 'CmdOrCtrl+O', click: () => this.report(this.pick()) }
    const windows = [...this.windows].map(([id, window]) => ({ label: window.title, type: 'checkbox' as const,
      checked: id === this.active, click: () => window.show() }))
    const current = this.active
    const close = { label: labels.close, accelerator: 'CmdOrCtrl+W', enabled: Boolean(current),
      click: () => { if (current) this.report(this.close(current)) } }
    const active = current ? this.windows.get(current) : undefined
    const additions = active?.runtime.buildApplicationMenuItems() ?? []
    const create = { label: labels.create ?? 'New Workspace…', accelerator: 'CmdOrCtrl+N',
      click: () => this.report((async () => { const target = await this.options.create?.(); if (target) await this.open(target) })()) }
    const recent = { label: labels.recent ?? 'Recent Workspaces',
      submenu: (this.options.recent?.() ?? []).map(item => ({ label: item.title,
        click: () => this.report(this.open(item.path)) })) }
    const file = [...(this.options.create ? [create] : []), open, recent, { type: 'separator' as const }, close]
    const template = macApplicationMenuTemplate(this.options.title, this.locale === 'zh' ? 'zh-CN' : 'en',
      additions, { file, windows })
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
    this.tray?.setContextMenu(Menu.buildFromTemplate([...file, { type: 'separator' }, ...additions, ...windows, { type: 'separator' }, { role: 'quit' }]))
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
      this.quitTask ??= this.registry.stop().then(async () => {
        await Promise.all([...this.blockedWindows.keys()].map(id => this.close(id)))
        this.tray?.destroy(); this.quitting = true; app.quit()
      }).catch(error => { this.quitTask = undefined; this.report(Promise.reject(error)) })
    })
    this.changed()
  }
}

/** Reuse the official disposable Safe Mode environment before its launcher starts. */
export function prepareWorkbenchSafeMode(stateDir: string): void {
  const paths = resetDesktopSafeModeEnvironment(stateDir)
  createDesktopWebProfile(paths.homeDir, DESKTOP_SAFE_MODE_PROFILE_NAME)
  selectDesktopProfile(join(paths.userDataDir, 'profile-selection/state.json'), paths.homeDir, DESKTOP_SAFE_MODE_PROFILE_NAME)
}

export { configureWorkbenchProfile } from './workbench-setup.ts'
export { WORKBENCH_MAINTENANCE_ENV, WORKBENCH_MAINTENANCE_EXIT_CODES } from './workbench-maintenance.ts'
