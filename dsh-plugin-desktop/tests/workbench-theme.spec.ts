import {describe, expect, it, vi} from 'vitest'
import {mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {WorkbenchTheme} from '../src/workbench-theme.ts'

describe('shared Workbench theme', () => {
  it('seeds once, persists choices, and prevents later Profiles from resetting the application', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-theme-'))
    const path = join(root, 'theme/state.json'), native = vi.fn(), a = vi.fn(), b = vi.fn()
    try {
      const theme = new WorkbenchTheme(path, native)
      const disconnect = await theme.connect('dark', a)
      await theme.connect('light', b)
      expect(a).toHaveBeenLastCalledWith('dark')
      expect(b).toHaveBeenLastCalledWith('dark')
      await Promise.all([theme.select('light'), theme.select('system')])
      expect(a.mock.calls.map(call => call[0])).toEqual(['dark', 'light', 'system'])
      expect(b.mock.calls.map(call => call[0])).toEqual(['dark', 'light', 'system'])
      expect(native).toHaveBeenLastCalledWith('system')
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({version: 1, preference: 'system'})
      await disconnect()
      await theme.select('dark')
      expect(a).toHaveBeenCalledTimes(3)
      const reopened = vi.fn()
      await new WorkbenchTheme(path, native).connect('light', reopened)
      expect(reopened).toHaveBeenCalledWith('dark')
    } finally {rmSync(root, {recursive: true, force: true})}
  })

  it('keeps the queue usable after a failed window sync and retries an unchanged choice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-theme-failure-'))
    try {
      const theme = new WorkbenchTheme(join(root, 'state.json'), vi.fn())
      const a = vi.fn(), b = vi.fn()
      await theme.connect('dark', a); await theme.connect('dark', b)
      a.mockRejectedValueOnce(new Error('Host unavailable'))
      await expect(theme.select('light')).rejects.toThrow('theme')
      expect(b).toHaveBeenLastCalledWith('light')
      await theme.select('light')
      expect(a).toHaveBeenLastCalledWith('light')
      await expect(theme.select('invalid' as 'dark')).rejects.toThrow('theme')
    } finally {rmSync(root, {recursive: true, force: true})}
  })

  it('does not replace damaged persisted state or publish after persistence failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workbench-theme-storage-'))
    try {
      const path = join(root, 'state.json')
      writeFileSync(path, 'bad json')
      expect(() => new WorkbenchTheme(path, vi.fn())).toThrow()
      expect(readFileSync(path, 'utf8')).toBe('bad json')
      const blocked = join(root, 'blocked'), native = vi.fn()
      const theme = new WorkbenchTheme(join(blocked, 'state.json'), native)
      writeFileSync(blocked, 'not a directory')
      await expect(theme.connect('dark', vi.fn())).rejects.toThrow()
      expect(native).not.toHaveBeenCalled()
      const directory = join(root, 'directory.json'); mkdirSync(directory)
      expect(() => new WorkbenchTheme(directory, native)).toThrow()
    } finally {rmSync(root, {recursive: true, force: true})}
  })
})
