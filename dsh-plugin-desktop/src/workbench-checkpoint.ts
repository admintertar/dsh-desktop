/** Reconcile Desktop's preference mirror after restoring a project's Home settings. */
import {join} from 'node:path'
import {readDesktopProfilePreferences, writeDesktopProfilePreferences, desktopProfilePreferencesFromSettings} from './profile-preferences.ts'
import {readDesktopSetupWizardSettings} from './setup-wizard-settings.ts'
import {readDesktopMarketStateForUserData} from './desktop-market.ts'

/** Prevent the next project preparation from writing newer preferences over restored settings. */
export async function reconcileWorkbenchCheckpointSettings(stateDir: string, profileDir: string, homeDir: string): Promise<void> {
  const previous = readDesktopProfilePreferences(stateDir, profileDir)
  const restored = readDesktopSetupWizardSettings(join(homeDir, 'settings.yaml'))
  // Market and AA choices are outside the original checkpoint file set; retain them.
  await writeDesktopProfilePreferences(stateDir, profileDir, desktopProfilePreferencesFromSettings(
    restored, restored.notifications, previous?.market ?? readDesktopMarketStateForUserData(stateDir).requested,
    previous?.aaEnabled === true,
  ))
}
