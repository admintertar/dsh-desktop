/** Exit protocol for an explicitly supervised Desktop maintenance process. */
export const WORKBENCH_MAINTENANCE_ENV = 'DSH_DESKTOP_WORKBENCH_MAINTENANCE'

/** Reserved successful handoffs, emitted only after Desktop has stopped its Host. */
export const WORKBENCH_MAINTENANCE_EXIT_CODES = Object.freeze({restart: 80, recovery: 81, 'safe-mode': 82})

interface NativeApplicationExit {
  relaunch(options: {args: string[]}): void
  exit(code: number): void
}

/** Ordinary Desktop relaunches itself; supervised maintenance returns a target to its parent. */
export function createWorkbenchMaintenanceExit(native: NativeApplicationExit, supervised: boolean) {
  let handoff: number | undefined
  return {
    relaunch(args: readonly string[]): void {
      if (!supervised) { native.relaunch({args: [...args]}); return }
      handoff = args.includes('--dsh-desktop-safe-mode') ? WORKBENCH_MAINTENANCE_EXIT_CODES['safe-mode']
        : args.includes('--dsh-desktop-recovery') ? WORKBENCH_MAINTENANCE_EXIT_CODES.recovery
          : WORKBENCH_MAINTENANCE_EXIT_CODES.restart
    },
    exit(code: number): void {
      native.exit(code === 0 && handoff !== undefined ? handoff : code)
    },
  }
}
