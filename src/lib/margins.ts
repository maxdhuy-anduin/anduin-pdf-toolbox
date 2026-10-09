// Page margins: the box that holds a page's body content (text, tables, images), ignoring running
// headers and footers. Shown on the rulers and used as snap targets. The user can override them on
// the ruler; overrides are view settings (they don't change the PDF).

import type { Box, PageContent } from './content/types'

export interface Margins {
  left: number
  right: number
  top: number
  bottom: number
}

export function detectMargins(content: PageContent | undefined): Margins | null {
  if (!content) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const o of Object.values(content.objects)) {
    const body = (o.type === 'TEXT_BLOCK' && o.role !== 'header' && o.role !== 'footer') || o.type === 'TABLE' || o.type === 'IMAGE'
    if (!body || o.parent) continue
    const b = o.bounds
    if (b.w <= 0 || b.h <= 0) continue
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  if (!Number.isFinite(x0)) return null
  const r = (v: number) => Math.max(0, Math.round(v * 2) / 2)
  return { left: r(x0), top: r(y0), right: r(content.width - x1), bottom: r(content.height - y1) }
}

export const marginBox = (m: Margins, w: number, h: number): Box => ({ x: m.left, y: m.top, w: Math.max(0, w - m.left - m.right), h: Math.max(0, h - m.top - m.bottom) })

export type Unit = 'in' | 'cm' | 'mm' | 'pt'
export const UNIT_PT: Record<Unit, number> = { in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pt: 1 }

export function formatLength(pt: number, unit: Unit): string {
  const v = pt / UNIT_PT[unit]
  return unit === 'pt' ? `${Math.round(v)} pt` : unit === 'mm' ? `${v.toFixed(0)} mm` : `${v.toFixed(2)} ${unit}`
}
