/** Reuse the official pre-Host Setup flow for optional workspace applications. */
import { DesktopSetupWizardWindow } from './setup-wizard-window.ts'
import { completeOrSkipDesktopSetupWizard, desktopSetupWizardRequired, readDesktopSetupWizardState, desktopSetupWizardStateConstants } from './setup-wizard-state.ts'
import { readDesktopSetupWizardSettings, updateDesktopSetupWizardSettings } from './setup-wizard-settings.ts'
import { desktopProfilePreferencesFromSettings, writeDesktopProfilePreferences } from './profile-preferences.ts'
import { selectDesktopMarketProvider } from './desktop-market.ts'
import { desktopProductVersion } from './electron-runtime.ts'
import { dshProductVersion } from './dsh-product-version.ts'
import { windowsSupportsMica, windowsBuildNumber } from './window-material.ts'
import type { DesktopWorkbenchLaunch } from './workbench.ts'
import type { DesktopLocale } from './runtime.ts'
import type { DesktopSetupWizardInput, DesktopSetupWizardPresentation, DesktopSetupWizardSelection } from './setup-wizard-contract.ts'

export interface WorkbenchSetupOptions {
  readonly locale: DesktopLocale
  readonly signal: AbortSignal
  readonly presentationModes?: readonly DesktopSetupWizardPresentation[]
  readonly commitPresentation: (selection: DesktopSetupWizardSelection) => Promise<void>
}

/** Return changed only after preferences and the explicit Setup outcome are saved. */
export async function configureWorkbenchProfile(
  launch: DesktopWorkbenchLaunch,
  options: WorkbenchSetupOptions,
): Promise<'unchanged' | 'changed' | 'cancelled'> {
  const versions = {desktopVersion: desktopProductVersion(), dshVersion: dshProductVersion(), setupRevision: desktopSetupWizardStateConstants.setupRevision}
  if (!desktopSetupWizardRequired(readDesktopSetupWizardState(launch.stateDir, launch.prepared.profile.dir), versions)) return 'unchanged'
  if (options.signal.aborted) return 'cancelled'
  const settings = readDesktopSetupWizardSettings(launch.prepared.settingsDocument)
  const presentation = options.presentationModes?.find(item => item.id === launch.presentation)
  const input: DesktopSetupWizardInput = {
    ...settings, appVersion: versions.desktopVersion, profileName: launch.prepared.profile.name,
    platform: process.platform as DesktopSetupWizardInput['platform'], micaSupported: process.platform === 'win32' && windowsSupportsMica(windowsBuildNumber()),
    openBrowser: false, networkExposure: 'loopback', localOnly: true,
    ...(options.presentationModes ? {presentationModes: options.presentationModes} : {}),
    ...(presentation ? {presentation: presentation.id, mode: presentation.mode} : {}),
    market: launch.preferences.market, aaEnabled: launch.preferences.aaEnabled === true,
  }
  const wizard = new DesktopSetupWizardWindow({locale: options.locale, input})
  const cancel = () => wizard.close()
  options.signal.addEventListener('abort', cancel, {once: true})
  try {
    const result = await wizard.run()
    if (result.action === 'quit' || options.signal.aborted) return 'cancelled'
    const selection: DesktopSetupWizardSelection = result.action === 'complete' ? result.selection : {
      ...settings, openBrowser: false, networkExposure: 'loopback', market: input.market, aaEnabled: false,
      ...(presentation ? {presentation: presentation.id, mode: presentation.mode} : {}),
    }
    await updateDesktopSetupWizardSettings(launch.prepared.settingsDocument, selection)
    await writeDesktopProfilePreferences(launch.stateDir, launch.prepared.profile.dir,
      desktopProfilePreferencesFromSettings(selection, selection.notifications, selection.market, selection.aaEnabled === true))
    await selectDesktopMarketProvider(launch.stateDir, selection.market)
    await options.commitPresentation(selection)
    await completeOrSkipDesktopSetupWizard(launch.stateDir, launch.prepared.profile.dir,
      result.action === 'complete' ? 'completed' : 'skipped', versions)
    return 'changed'
  } finally { options.signal.removeEventListener('abort', cancel) }
}
