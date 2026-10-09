// Parse once, analyze once, cache: hover/click only ever read the cached geometry.
import { analyzePage } from './analyze'
import { extractPage } from './extract'
import type { PageContent } from './types'
import { getPdfPage, hasSource, onSourceReleased, pdfjs } from '../pdfjs'
import { imageSnapshots } from './edits'

const cache = new Map<string, Promise<PageContent>>()
const done = new Map<string, PageContent>()
const listeners = new Set<() => void>()

export const contentKey = (sourceId: string, srcIndex: number) => `${sourceId}:${srcIndex}`

onSourceReleased((sourceId) => {
  for (const m of [cache, done, imageSnapshots] as Map<string, unknown>[]) for (const k of [...m.keys()]) if (k.startsWith(`${sourceId}:`)) m.delete(k)
})

export function getCachedContent(sourceId: string, srcIndex: number): PageContent | undefined {
  return done.get(contentKey(sourceId, srcIndex))
}

export function getPageContent(sourceId: string, srcIndex: number): Promise<PageContent> {
  const key = contentKey(sourceId, srcIndex)
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      const page = await getPdfPage(sourceId, srcIndex)
      const raw = await extractPage(page, pdfjs as never)
      const content = analyzePage(raw)
      done.set(key, content)
      listeners.forEach((l) => l())
      return content
    })()
    cache.set(key, p)
    p.catch(() => cache.delete(key))
  }
  return p
}

export function onContentAnalyzed(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Analyze every page of a source in the background, a page at a time when the browser is idle. */
export function prefetchContent(sourceId: string, numPages: number) {
  let i = 0
  const idle: (cb: () => void) => void =
    typeof window !== 'undefined' && 'requestIdleCallback' in window ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 }) : (cb) => setTimeout(cb, 50)
  const next = () => {
    if (i >= numPages || !hasSource(sourceId)) return
    const idx = i++
    getPageContent(sourceId, idx)
      .catch(() => undefined)
      .finally(() => idle(next))
  }
  idle(next)
}
