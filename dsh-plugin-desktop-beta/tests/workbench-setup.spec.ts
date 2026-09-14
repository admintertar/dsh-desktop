import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DesktopWorkbenchLaunch } from '../src/workbench.ts'
import type { DesktopSetupWizardInput, DesktopSetupWizardResult } from '../src/setup-wizard-contract.ts'
const wizard = vi.hoisted(() => ({inputs: [] as DesktopSetupWizardInput[], result: {action: 'quit'} as DesktopSetupWizardResult}))
vi.mock('../src/setup-wizard-window.ts', () => ({DesktopSetupWizardWindow: class {
  constructor(options: {input: DesktopSetupWizardInput}) {wizard.inputs.push(options.input)}
  async run() {return wizard.result}
  close() {}
}}))
vi.mock('../src/electron-runtime.ts', () => ({desktopProductVersion: () => '2.0.10'}))
import { configureWorkbenchProfile } from '../src/workbench-setup.ts'
import { readDesktopSetupWizardState } from '../src/setup-wizard-state.ts'
import { readDesktopProfilePreferences } from '../src/profile-preferences.ts'

const projectMode = {id: 'project', mode: 'advanced' as const, title: '项目模式', description: '复用增强模式'}
function fixture(root: string): DesktopWorkbenchLaunch {
  mkdirSync(join(root, 'profile')); writeFileSync(join(root, 'settings.yaml'), '{}\n')
  return {homeDir: root, stateDir: join(root, 'electron'), cwd: root, environment: {}, presentation: 'project',
    prepared: {profile: {name: 'fresh', dir: join(root, 'profile')}, settingsDocument: join(root, 'settings.yaml')} as DesktopWorkbenchLaunch['prepared'],
    preferences: {mode: 'advanced', openBrowser: false, networkExposure: 'loopback', market: 'disabled', aaEnabled: false,
      notifications: {enabled: true, notifyOnTurnCompletion: true, notifyOnTurnFailure: true, notifyOnJobCompletion: true, notifyOnJobFailure: true}}}
}

describe('workbench first Profile setup', () => {
  it('shows the official wizard with custom modes, records completion, and never repeats it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-setup-'))
    const launch = fixture(root)
    wizard.inputs.length = 0
    wizard.result = {action: 'complete', selection: {mode: 'advanced', presentation: 'project', macosMaterial: 'transparent', windowsMaterial: 'off', openBrowser: false,
      networkExposure: 'loopback', market: 'disabled', aaEnabled: true, notifications: launch.preferences.notifications}}
    const commit = vi.fn(async () => {
      expect(readDesktopSetupWizardState(launch.stateDir, launch.prepared.profile.dir)).toBeUndefined()
    })
    const options = {locale: 'zh' as const, signal: new AbortController().signal, presentationModes: [projectMode], commitPresentation: commit}
    try {
      expect(await configureWorkbenchProfile(launch, options)).toBe('changed')
      expect(wizard.inputs[0]).toMatchObject({profileName: 'fresh', presentation: 'project', presentationModes: [projectMode], localOnly: true})
      expect(commit).toHaveBeenCalledWith(wizard.result.selection)
      expect(readDesktopSetupWizardState(launch.stateDir, launch.prepared.profile.dir)?.outcome).toBe('completed')
      expect(readDesktopProfilePreferences(launch.stateDir, launch.prepared.profile.dir)?.aaEnabled).toBe(true)
      expect(await configureWorkbenchProfile(launch, options)).toBe('unchanged')
      expect(wizard.inputs).toHaveLength(1)
    } finally {rmSync(root, {recursive: true, force: true})}
  })
  it('closing setup leaves no completion marker; an explicit skip records the Profile decision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-cancel-'))
    const launch = fixture(root)
    const commit = vi.fn(async (_selection: unknown) => {})
    const options = {locale: 'en' as const, signal: new AbortController().signal, presentationModes: [projectMode], commitPresentation: commit}
    try {
      wizard.result = {action: 'quit'}
      expect(await configureWorkbenchProfile(launch, options)).toBe('cancelled')
      expect(readDesktopSetupWizardState(launch.stateDir, launch.prepared.profile.dir)).toBeUndefined()
      expect(commit).not.toHaveBeenCalled()
      wizard.result = {action: 'skip'}
      expect(await configureWorkbenchProfile(launch, options)).toBe('changed')
      expect(readDesktopSetupWizardState(launch.stateDir, launch.prepared.profile.dir)?.outcome).toBe('skipped')
      expect(commit.mock.calls[0]?.[0]).toMatchObject({mode: 'advanced', presentation: 'project'})
    } finally {rmSync(root, {recursive: true, force: true})}
  })
})
