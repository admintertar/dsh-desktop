/** Optional product modes reuse Desktop's setting cards and built-in shells. */
export interface DesktopPresentationMode {
  id: string
  title: string
  description: string
  active: boolean
  select(): Promise<void>
  leave(mode: 'compatibility' | 'extended' | 'advanced'): Promise<void>
}

export class DesktopPresentationModes {
  private modes: readonly DesktopPresentationMode[] = []
  private listeners = new Set<() => void>()
  getSnapshot = () => this.modes
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  register(mode: DesktopPresentationMode): () => void {
    if (this.modes.some(value => value.id === mode.id)) throw new Error('Presentation mode already registered')
    this.modes = [...this.modes, mode]
    this.listeners.forEach(listener => listener())
    return () => { this.modes = this.modes.filter(value => value !== mode); this.listeners.forEach(listener => listener()) }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { desktopPresentationModes: DesktopPresentationModes }
}
