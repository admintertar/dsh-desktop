// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SetupWizardStepPage } from '../src/native-ui/setup-wizard/App.tsx'
import { desktopSetupWizardCopy } from '../src/setup-wizard-copy.ts'
import { desktopSetupWizardSelectionIsAvailable, isDesktopSetupWizardInput, type DesktopSetupWizardInput } from '../src/setup-wizard-contract.ts'

const input: DesktopSetupWizardInput = {appVersion: '2.0.10', profileName: 'new-profile', platform: 'darwin', micaSupported: false,
  mode: 'advanced', presentation: 'project', presentationModes: [{id: 'project', mode: 'advanced', title: '项目模式', description: '使用增强模式界面'}],
  localOnly: true, macosMaterial: 'transparent', windowsMaterial: 'off', openBrowser: false, networkExposure: 'loopback', market: 'disabled', aaEnabled: false,
  notifications: {enabled: true, notifyOnTurnCompletion: true, notifyOnTurnFailure: true, notifyOnJobCompletion: true, notifyOnJobFailure: true}}

it('offers Project beside the official modes and switches between them without two selected cards', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const update = vi.fn()
  const props = {copy: desktopSetupWizardCopy('zh'), input, selection: input, step: 'mode' as const, update, requestBrowserAccess: vi.fn(), requestExposure: vi.fn()}
  try {
    await act(async () => root.render(createElement(SetupWizardStepPage, props)))
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(4)
    expect(container.querySelector('[aria-checked="true"]')?.closest('label')?.textContent).toContain('项目模式')
    await act(async () => {container.querySelector<HTMLElement>('label[for="setup-window-mode-extended"] [role="radio"]')!.click()})
    const ordinary = update.mock.calls.at(-1)![0]
    expect(ordinary.mode).toBe('extended')
    expect(ordinary.presentation).toBeUndefined()
    await act(async () => root.render(createElement(SetupWizardStepPage, {...props, selection: ordinary})))
    await act(async () => {container.querySelector<HTMLElement>('label[for="setup-window-mode-project"] [role="radio"]')!.click()})
    expect(update.mock.calls.at(-1)![0]).toMatchObject({mode: 'advanced', presentation: 'project', openBrowser: false, networkExposure: 'loopback'})
    await act(async () => root.render(createElement(SetupWizardStepPage, {...props, step: 'browser'})))
    expect(container.textContent).toContain('此窗口不支持浏览器访问。')
    await act(async () => {container.querySelector<HTMLElement>('[role="switch"]')!.click()})
    expect(props.requestBrowserAccess).not.toHaveBeenCalled()
  } finally {await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals()}
})

it('only accepts registered presentation ids and their declared shell with the local access constraint', () => {
  expect(isDesktopSetupWizardInput(input)).toBe(true)
  expect(isDesktopSetupWizardInput({...input, presentation: 'unknown'})).toBe(false)
  expect(isDesktopSetupWizardInput({...input, presentationModes: [...input.presentationModes!, ...input.presentationModes!]})).toBe(false)
  expect(desktopSetupWizardSelectionIsAvailable(input, input)).toBe(true)
  expect(desktopSetupWizardSelectionIsAvailable({...input, mode: 'extended'}, input)).toBe(false)
  expect(desktopSetupWizardSelectionIsAvailable(input, {platform: 'darwin', micaSupported: false})).toBe(false)
  const {presentation: _project, ...ordinary} = input
  expect(desktopSetupWizardSelectionIsAvailable({...ordinary, mode: 'compatibility', openBrowser: true}, input)).toBe(false)

})
