// Fallback layout (tier 2): when structural analysis of a page fails, still expose PDF.js's
// text items as TEXT_SPAN chunks so the page can be inspected. Nothing here is editable as an
// object; the text-overlay editor (Add Text) and page operations keep working regardless.

import { pdfRectToCanvas } from '../coords'
import type { PageInfo } from '../model'
import { classifyFont } from '../content/analyze'
import { familyFromFontName } from './fromContent'
import { IDENTITY, type LayoutChunk, type LayoutPage, type ProviderId } from './types'

export interface BasicTextItem {
  str: string
  /** Text matrix in PDF user space [a, b, c, d, e, f]. */
  transform: number[]
  width: number
  height: number
  fontName?: string
}

export function layoutFromTextItems(items: BasicTextItem[], info: PageInfo, sourceId: string, pageIndex: number, warning: string): LayoutPage {
  const chunks: Record<string, LayoutChunk> = {}
  const roots: string[] = []
  items.forEach((it, i) => {
    if (!it.str.trim()) return
    const [a, b, , , e, f] = it.transform
    const size = Math.hypot(a, b) || it.height || 10
    const horizontal = Math.abs(b) < 1e-3 && a > 0
    // horizontal text: box from slightly below the baseline to the ascent; otherwise a size×size marker
    const rect: [number, number, number, number] = horizontal ? [e, f - 0.22 * size, e + it.width, f + 0.88 * size] : [e, f, e + size, f + size]
    const font = classifyFont(it.fontName ?? '', '')
    const id = `s${i}`
    chunks[id] = {
      id, type: 'TEXT_SPAN', sourceId, pageIndex, bounds: pdfRectToCanvas(info, rect), rotation: horizontal ? 0 : Math.round((Math.atan2(b, a) * 180) / Math.PI),
      transform: IDENTITY, parent: null, children: [], editable: false, text: it.str,
      style: {
        fontFamily: familyFromFontName(it.fontName ?? ''), fontName: it.fontName ?? '', fallbackFont: font.family, fontSize: Math.round(size * 10) / 10,
        fontWeight: font.bold ? 700 : 400, italic: font.italic, underline: false, color: null, alignment: 'left', lineHeight: 1.2, characterSpacing: 0,
      },
      source: { provider: 'local-basic' },
    }
    roots.push(id)
  })
  const area = (id: string) => chunks[id].bounds.width * chunks[id].bounds.height
  return {
    sourceId, pageIndex, width: info.width, height: info.height, provider: 'local-basic', status: roots.length ? 'basic' : 'empty',
    chunks, roots, hitOrder: [...roots].sort((x, y) => area(x) - area(y)), ms: 0, warnings: [warning],
  }
}

/** Last tier: no layout at all. The page still renders and supports page operations. */
export function emptyLayout(info: { width: number; height: number }, sourceId: string, pageIndex: number, provider: ProviderId, warning: string): LayoutPage {
  return { sourceId, pageIndex, width: info.width, height: info.height, provider, status: 'failed', chunks: {}, roots: [], hitOrder: [], ms: 0, warnings: [warning] }
}
