// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { DesktopSettingsSection, type DesktopSettingsSectionProps } from '../src/client/DesktopSettingsSection.tsx'
import { DesktopPresentationModes } from '../src/client/presentation-modes.ts'
import { zh } from '../src/client/desktop-settings-locales.ts'

it('renders a plugin mode beside built-ins, invokes it, and marks only that mode selected', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  const root = createRoot(container)
  const modes = new DesktopPresentationModes()
  const select = vi.fn(async () => {})
  const leave = vi.fn(async () => {})
  const option = {id: 'project', title: '项目模式', description: '复用增强模式', active: false, select, leave}
  let dispose = modes.register(option)
  const scope = (value: unknown) => {
    const snapshot = { status: 'ready', writable: true, value }
    return {getSnapshot: () => snapshot, subscribe: () => () => {}}
  }
  const props = {presentationModes: modes, t: (key: keyof typeof zh) => zh[key],
    api: {read: async () => ({current: 'desktop', profiles: [], aa: {requested: false, effective: false},
      market: {requested: 'disabled', effective: 'disabled', legacyDefaulted: false},
      web: {localUrl: '', lanUrls: [], lanState: 'inactive', lanError: null, lanCaFingerprint: null, lanCaUrls: []}})},
    platform: 'darwin', initialMode: 'advanced', micaSupported: false, setMode: async () => {},
    desktopSettings: scope({mode: 'advanced', openBrowser: false, networkExposure: 'loopback'}),
    notificationSettings: scope({enabled: false}),
  } as unknown as DesktopSettingsSectionProps
  try {
    await act(async () => {root.render(createElement(DesktopSettingsSection, props))})
    const choices = () => [...container.querySelectorAll<HTMLElement>('[aria-labelledby="dsh-desktop-presentation-title"] [role="radio"]')]
    expect(choices()).toHaveLength(4)
    expect(choices()[2]?.getAttribute('aria-checked')).toBe('true')
    await act(async () => {choices()[3]!.click()})
    expect(select).toHaveBeenCalledOnce()
    await act(async () => {dispose(); dispose = modes.register({...option, active: true})})
    expect(choices().filter(item => item.getAttribute('aria-checked') === 'true')).toEqual([choices()[3]])
    expect(choices()[3]?.textContent).toContain('项目模式')
    await act(async () => {dispose()})
    expect(choices()).toHaveLength(3)
  } finally {await act(async () => {root.unmount()}); vi.unstubAllGlobals()}
})
