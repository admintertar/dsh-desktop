import {describe, expect, it} from 'vitest'
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {DesktopProfileCheckpoint} from '../src/profile-checkpoint.ts'
import {reconcileWorkbenchCheckpointSettings} from '../src/workbench-checkpoint.ts'
import {writeDesktopProfilePreferences, readDesktopProfilePreferences} from '../src/profile-preferences.ts'
import {readDesktopSetupWizardSettings} from '../src/setup-wizard-settings.ts'

describe('restored project settings', () => {
  it('restores settings and their preference mirror without changing sessions or credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-restore-'))
    const home = join(root, 'dsh'), profile = join(home, 'profiles/desktop'), stateDir = join(root, 'electron')
    mkdirSync(profile, {recursive: true}); mkdirSync(stateDir)
    writeFileSync(join(profile, 'package.json'), '{"name":"fixture","dependencies":{}}')
    writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
    const settingsPath = join(home, 'settings.yaml')
    writeFileSync(settingsPath, 'dsh-desktop:\n  mode: compatibility\ndsh-desktop-notifications:\n  enabled: false\n')
    const checkpoint = new DesktopProfileCheckpoint({userDataDir: stateDir, profileDir: profile, homeDir: home, profileName: 'desktop'})
    try {
      const captured = checkpoint.captureHealthy()
      if (captured.status !== 'captured') throw new Error('No checkpoint captured')
      writeFileSync(settingsPath, 'dsh-desktop:\n  mode: advanced\ndsh-desktop-notifications:\n  enabled: true\n')
      await writeDesktopProfilePreferences(stateDir, profile, {mode: 'advanced', openBrowser: false, networkExposure: 'loopback',
        market: 'community-market', aaEnabled: true, notifications: readDesktopSetupWizardSettings(settingsPath).notifications})
      writeFileSync(join(home, '.credentials.yaml'), 'private fixture\n')
      mkdirSync(join(home, 'sessions')); writeFileSync(join(home, 'sessions/fixture.jsonl'), 'conversation fixture\n')
      checkpoint.restoreSlot(captured.slotId)
      await reconcileWorkbenchCheckpointSettings(stateDir, profile, home)
      expect(readDesktopSetupWizardSettings(settingsPath)).toMatchObject({mode: 'compatibility', notifications: {enabled: false}})
      expect(readDesktopProfilePreferences(stateDir, profile)).toMatchObject({mode: 'compatibility', notifications: {enabled: false},
        market: 'community-market', aaEnabled: true})
      expect(readFileSync(join(home, '.credentials.yaml'), 'utf8')).toBe('private fixture\n')
      expect(readFileSync(join(home, 'sessions/fixture.jsonl'), 'utf8')).toBe('conversation fixture\n')
      expect(checkpoint.captureHealthy().status).toBe('skipped-after-restore')
    } finally {rmSync(root, {recursive: true, force: true})}
  })
})
