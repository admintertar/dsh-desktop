/** Preserve the official Appearance control and settings events while sharing only its preference. */
import type {Context} from '@deepseek-ai/cordis'
import {THEME_SETTINGS_NAMESPACE, type ThemeSettings} from '@deepseek-ai/dsh-client-ui-theme'
import type {DesktopSharedTheme, DesktopThemeSource} from './runtime.ts'
import {assertDesktopThemeSource} from './workbench-theme.ts'

export async function connectWorkbenchThemeSettings(ctx: Context, theme: DesktopSharedTheme): Promise<() => Promise<void>> {
  const read = () => (ctx.settings.get(THEME_SETTINGS_NAMESPACE) as ThemeSettings).preference
  let applying: DesktopThemeSource | undefined
  let stopped = false
  const writes = new Set<Promise<void>>()
  const off = ctx.on('settings/updated', (namespace, next, prev) => {
    if (stopped || namespace !== THEME_SETTINGS_NAMESPACE) return
    const source = (next as ThemeSettings).preference
    if (source === (prev as ThemeSettings).preference || source === applying) return
    // Do not await the broadcast inside a settings commit: it may call this Host back.
    void theme.select(source).catch(error => ctx.logger.error(error))
  })
  try {
    const disconnect = await theme.connect(read(), async source => {
      assertDesktopThemeSource(source)
      if (stopped || read() === source) return
      applying = source
      const write = ctx.settings.update(THEME_SETTINGS_NAMESPACE, {preference: source})
      writes.add(write)
      try { await write }
      finally { writes.delete(write); applying = undefined }
    })
    let stopping: Promise<void> | undefined
    return () => {
      stopped = true; off()
      return stopping ??= (async () => {
        try { await disconnect() }
        finally { await Promise.allSettled([...writes]) }
      })()
    }
  } catch (error) { stopped = true; off(); throw error }
}
