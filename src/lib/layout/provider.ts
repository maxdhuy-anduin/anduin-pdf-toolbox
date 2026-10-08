// Layout extraction providers. The editor never depends on a provider's raw output, only on
// LayoutPage / LayoutChunk.
//
//   LocalLayoutExtractor  on-device (PDF.js + content stream + heuristics). Default, always available.
//   AdobeLayoutExtractor  Adobe PDF Extract through *our own backend* (VITE_LAYOUT_SERVICE_URL).
//                         Credentials stay on the server; the browser never calls Adobe directly.
//                         Off unless that URL is configured and the user selects it.

import { getPageContent } from '../content/cache'
import { getPageCount, getPdfPage, getSourceBytes, pageInfoOf } from '../pdfjs'
import { layoutFromAdobe, type AdobeExtract } from './adobe'
import { emptyLayout, layoutFromTextItems, type BasicTextItem } from './basic'
import { layoutFromContent } from './fromContent'
import type { LayoutPage, ProviderId } from './types'

export interface LayoutExtractionProvider {
  id: ProviderId
  label: string
  /** Where document content is processed: shown in the UI next to the provider. */
  processing: 'on-device' | 'backend'
  available(): boolean
  extractPage(sourceId: string, pageIndex: number): Promise<LayoutPage>
}

/** Structured analysis, then PDF.js text items, then an empty layout. Never throws. */
export const LocalLayoutExtractor: LayoutExtractionProvider = {
  id: 'local',
  label: 'Local (on-device)',
  processing: 'on-device',
  available: () => true,
  async extractPage(sourceId, pageIndex) {
    try {
      return layoutFromContent(await getPageContent(sourceId, pageIndex), sourceId, pageIndex)
    } catch (e) {
      const why = `Structural analysis failed (${(e as Error)?.message ?? e}); showing basic text spans.`
      try {
        const page = await getPdfPage(sourceId, pageIndex)
        const tc = await page.getTextContent()
        const items = tc.items.filter((i): i is BasicTextItem & typeof i => 'str' in i)
        return layoutFromTextItems(items, pageInfoOf(page), sourceId, pageIndex, why)
      } catch (e2) {
        return emptyLayout({ width: 0, height: 0 }, sourceId, pageIndex, 'local', `No layout available (${(e2 as Error)?.message ?? e2}). Page operations still work.`)
      }
    }
  },
}

const SERVICE_URL: string = (import.meta.env?.VITE_LAYOUT_SERVICE_URL as string | undefined) ?? ''

const adobeDocs = new Map<string, Promise<LayoutPage[]>>()

export const AdobeLayoutExtractor: LayoutExtractionProvider = {
  id: 'adobe',
  label: 'Adobe PDF Extract (via backend)',
  processing: 'backend',
  available: () => !!SERVICE_URL,
  async extractPage(sourceId, pageIndex) {
    if (!SERVICE_URL) throw new Error('Adobe extraction is not configured (VITE_LAYOUT_SERVICE_URL).')
    let doc = adobeDocs.get(sourceId)
    if (!doc) {
      doc = (async () => {
        const bytes = getSourceBytes(sourceId)
        const res = await fetch(`${SERVICE_URL.replace(/\/$/, '')}/extract`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: bytes.slice() })
        if (!res.ok) throw new Error(`Layout service returned ${res.status}`)
        const json = (await res.json()) as AdobeExtract
        const n = getPageCount(sourceId)
        const infos = await Promise.all(Array.from({ length: n }, (_, i) => getPdfPage(sourceId, i).then(pageInfoOf)))
        return layoutFromAdobe(json, infos, sourceId)
      })()
      adobeDocs.set(sourceId, doc)
      doc.catch(() => adobeDocs.delete(sourceId))
    }
    const pages = await doc
    return pages[pageIndex]
  },
}

export const PROVIDERS: LayoutExtractionProvider[] = [LocalLayoutExtractor, AdobeLayoutExtractor]
