// One layout per (provider, source page), computed once and cached. Hover, overlays and the object
// tree only read cached geometry. If the selected provider fails, the local provider is used.

import { AdobeLayoutExtractor, LocalLayoutExtractor, PROVIDERS, type LayoutExtractionProvider } from './provider'
import type { LayoutPage, ProviderId } from './types'

const pending = new Map<string, Promise<LayoutPage>>()
const done = new Map<string, LayoutPage>()
const listeners = new Set<() => void>()
let active: ProviderId = 'local'

const key = (sourceId: string, pageIndex: number) => `${active}:${sourceId}:${pageIndex}`

export const getActiveProvider = (): LayoutExtractionProvider => PROVIDERS.find((p) => p.id === active) ?? LocalLayoutExtractor

export function setActiveProvider(id: ProviderId) {
  const p = PROVIDERS.find((x) => x.id === id)
  if (!p || !p.available() || id === active) return
  active = id
  listeners.forEach((l) => l())
}

export function getCachedLayout(sourceId: string, pageIndex: number): LayoutPage | undefined {
  return done.get(key(sourceId, pageIndex))
}

export function getPageLayout(sourceId: string, pageIndex: number): Promise<LayoutPage> {
  const k = key(sourceId, pageIndex)
  let p = pending.get(k)
  if (!p) {
    const provider = getActiveProvider()
    p = (async () => {
      let page: LayoutPage
      try {
        page = await provider.extractPage(sourceId, pageIndex)
      } catch (e) {
        if (provider === LocalLayoutExtractor) throw e
        page = await LocalLayoutExtractor.extractPage(sourceId, pageIndex)
        page = { ...page, warnings: [...page.warnings, `${provider.label} failed (${(e as Error)?.message ?? e}); using local analysis.`] }
      }
      done.set(k, page)
      listeners.forEach((l) => l())
      return page
    })()
    pending.set(k, p)
    p.catch(() => pending.delete(k))
  }
  return p
}

export function onLayoutChange(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export { AdobeLayoutExtractor }
