import {describe, expect, it, vi} from 'vitest'
import {createWorkbenchMaintenanceExit, WORKBENCH_MAINTENANCE_EXIT_CODES} from '../src/workbench-maintenance.ts'
import {createDesktopExitCoordinator} from '../src/shutdown.ts'

describe('supervised Desktop maintenance exit', () => {
  it.each([
    [[], 'restart'],
    [['--dsh-desktop-recovery'], 'recovery'],
    [['--dsh-desktop-safe-mode'], 'safe-mode'],
  ] as const)('returns %j to the parent only after a clean shutdown', (args, target) => {
    const native = {relaunch: vi.fn(), exit: vi.fn()}
    const maintenance = createWorkbenchMaintenanceExit(native, true)
    const disposed = vi.fn()
    const exit = createDesktopExitCoordinator({prepareToQuit: vi.fn(),
      relaunch: values => maintenance.relaunch(values ?? []), exit: maintenance.exit}, disposed)
    exit.requestRelaunch(args)
    expect(native.exit).not.toHaveBeenCalled()
    exit.finish(0)
    expect(disposed).toHaveBeenCalledOnce()
    expect(native.relaunch).not.toHaveBeenCalled()
    expect(native.exit).toHaveBeenCalledWith(WORKBENCH_MAINTENANCE_EXIT_CODES[target])
  })

  it('never returns a successful handoff after teardown fails or the user quits', () => {
    for (const code of [0, 1]) {
      const native = {relaunch: vi.fn(), exit: vi.fn()}
      const maintenance = createWorkbenchMaintenanceExit(native, true)
      const exit = createDesktopExitCoordinator({prepareToQuit: vi.fn(),
        relaunch: values => maintenance.relaunch(values ?? []), exit: maintenance.exit}, () => {})
      if (code === 1) exit.requestRelaunch()
      exit.finish(code)
      expect(native.exit).toHaveBeenCalledWith(code)
    }
  })

  it('preserves the ordinary Desktop relaunch path', () => {
    const native = {relaunch: vi.fn(), exit: vi.fn()}
    const exit = createWorkbenchMaintenanceExit(native, false)
    exit.relaunch(['main.js', '--dsh-desktop-safe-mode'])
    exit.exit(0)
    expect(native.relaunch).toHaveBeenCalledWith({args: ['main.js', '--dsh-desktop-safe-mode']})
    expect(native.exit).toHaveBeenCalledWith(0)
  })
})
