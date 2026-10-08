// Adobe PDF Extract API adapter: structuredData.json → normalized LayoutPages.
//
// This is the only file that knows Adobe's schema. It follows the public documentation:
// `elements[]` in reading order, each with `Path` (structure path such as
// "//Document/Table[2]/TR[3]/TD[2]/P"), `Page` (0-based), `Bounds` ([left, bottom, right, top] in
// PDF points, origin bottom-left), `Text`, `TextSize`, `Font`, `attributes` (LineHeight,
// TextAlign, BBox, NumRow/NumCol for tables, RowIndex/ColIndex/RowSpan/ColSpan for cells) and
// `filePaths` (figure renditions). Unknown or missing fields are tolerated.
//
// Assumption to verify against real output: Bounds are in the page's PDF user space (unrotated),
// converted with the same pdfToCanvas used everywhere else.

import { pdfRectToCanvas } from '../coords'
import type { PageInfo } from '../model'
import { classifyFont } from '../content/analyze'
import { IDENTITY, type ChunkType, type LayoutChunk, type LayoutPage } from './types'

export interface AdobeFont {
  name?: string
  family_name?: string
  weight?: number
  italic?: boolean
  monospaced?: boolean
}

export interface AdobeElement {
  Path: string
  Page?: number
  Bounds?: [number, number, number, number]
  Text?: string
  TextSize?: number
  Font?: AdobeFont
  attributes?: Record<string, unknown>
  filePaths?: string[]
  Kids?: AdobeElement[]
}

export interface AdobeExtract {
  elements: AdobeElement[]
  pages?: { page_number: number; width: number; height: number; rotation?: number }[]
}

interface Seg {
  tag: string
  idx: number
}

const parsePath = (p: string): Seg[] =>
  p
    .replace(/^\/\//, '')
    .split('/')
    .filter(Boolean)
    .map((s) => {
      const m = /^([A-Za-z]+\d?)(?:\[(\d+)\])?$/.exec(s)
      return m ? { tag: m[1], idx: m[2] ? Number(m[2]) : 1 } : { tag: s, idx: 1 }
    })

const keyOf = (segs: Seg[]) => segs.map((s) => `${s.tag}[${s.idx}]`).join('/')

/** Structure tags that only group content: their children attach to the nearest real ancestor. */
const TRANSPARENT = new Set(['Document', 'Sect', 'Part', 'Art', 'Div', 'NonStruct', 'Span'])

function typeOf(tag: string, parentType: ChunkType | null): { type: ChunkType; level?: number; role?: LayoutChunk['role'] } | null {
  const h = /^H([1-6])?$/.exec(tag)
  if (h) return { type: 'HEADING', level: h[1] ? Number(h[1]) : 1 }
  switch (tag) {
    case 'Title':
      return { type: 'HEADING', level: 1, role: 'title' }
    case 'P':
    case 'ParagraphSpan':
      return { type: parentType === 'TABLE_CELL' || parentType === 'LIST_ITEM' ? 'TEXT_SPAN' : 'PARAGRAPH' }
    case 'L':
      return { type: 'LIST' }
    case 'LI':
      return { type: 'LIST_ITEM' }
    case 'TOC':
      return { type: 'LIST', role: 'toc' }
    case 'TOCI':
      return { type: 'LIST_ITEM', role: 'toc' }
    case 'Lbl':
    case 'LBody':
    case 'StyleSpan':
    case 'Sub':
    case 'Sup':
    case 'Reference':
    case 'Link':
      return { type: 'TEXT_SPAN' }
    case 'Table':
      return { type: 'TABLE' }
    case 'TR':
      return { type: 'TABLE_ROW' }
    case 'TD':
    case 'TH':
      return { type: 'TABLE_CELL' }
    case 'Figure':
    case 'Formula':
      return { type: 'FIGURE' }
    case 'Footnote':
      return { type: 'PARAGRAPH', role: 'footnote' }
    case 'Caption':
      return { type: 'PARAGRAPH', role: 'caption' }
    case 'Aside':
      return { type: 'PARAGRAPH' }
    default:
      return null
  }
}

const ALIGN: Record<string, 'left' | 'center' | 'right' | 'justify'> = { Start: 'left', Center: 'center', End: 'right', Justify: 'justify', Left: 'left', Right: 'right' }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const isBox = (v: unknown): v is [number, number, number, number] => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number')

/**
 * @param infos page geometry from PDF.js (index = 0-based page), used for coordinate conversion
 */
export function layoutFromAdobe(json: AdobeExtract, infos: PageInfo[], sourceId: string): LayoutPage[] {
  const pages: LayoutPage[] = infos.map((info, pageIndex) => ({
    sourceId, pageIndex, width: info.width, height: info.height, provider: 'adobe', status: 'structured',
    chunks: {}, roots: [], hitOrder: [], ms: 0, warnings: [],
  }))
  // structure path → chunk id, per page (a table continued on the next page gets a new chunk there)
  const byPath = pages.map(() => new Map<string, string>())
  const counters = pages.map(() => 0)

  // flatten styling-mode Kids into the element list (paths are absolute either way)
  const flat: AdobeElement[] = []
  const walk = (els: AdobeElement[], page?: number) => {
    for (const el of els) {
      flat.push({ ...el, Page: el.Page ?? page })
      if (el.Kids?.length) walk(el.Kids, el.Page ?? page)
    }
  }
  walk(json.elements ?? [])

  const ensure = (pageIndex: number, segs: Seg[]): string | null => {
    // nearest non-transparent ancestor; creates container chunks (Table/TR/TD/L/LI) that Adobe omitted
    for (let n = segs.length; n > 0; n -= 1) {
      const tag = segs[n - 1].tag
      if (TRANSPARENT.has(tag)) continue
      const key = keyOf(segs.slice(0, n))
      const existing = byPath[pageIndex].get(key)
      if (existing) return existing
      const parentId = ensure(pageIndex, segs.slice(0, n - 1))
      const parentType = parentId ? pages[pageIndex].chunks[parentId].type : null
      const t = typeOf(tag, parentType)
      if (!t) return parentId
      return add(pageIndex, segs.slice(0, n), t, parentId, null)
    }
    return null
  }

  const add = (pageIndex: number, segs: Seg[], t: NonNullable<ReturnType<typeof typeOf>>, parent: string | null, el: AdobeElement | null): string => {
    const page = pages[pageIndex]
    const id = `a${pageIndex}-${counters[pageIndex]++}`
    const c: LayoutChunk = {
      id, type: t.type, sourceId, pageIndex, bounds: { x: 0, y: 0, width: 0, height: 0 }, rotation: 0, transform: IDENTITY,
      parent, children: [], editable: t.type !== 'TABLE_ROW' && t.type !== 'LIST' && t.type !== 'TABLE', source: { provider: 'adobe', path: keyOf(segs) },
    }
    if (t.level) c.level = t.level
    if (t.role) c.role = t.role
    if (t.type === 'TABLE') c.table = { rows: 0, columns: 0, cells: [], kind: 'provider' }
    if (t.type === 'TABLE_CELL') c.cell = { row: -1, col: -1, rowSpan: 1, colSpan: 1, header: segs[segs.length - 1].tag === 'TH' }
    page.chunks[id] = c
    byPath[pageIndex].set(keyOf(segs), id)
    if (parent) page.chunks[parent].children.push(id)
    else page.roots.push(id)
    if (el) apply(c, el, infos[pageIndex])
    return id
  }

  const apply = (c: LayoutChunk, el: AdobeElement, info: PageInfo) => {
    const attrs = el.attributes ?? {}
    const box = isBox(el.Bounds) ? el.Bounds : isBox(attrs.BBox) ? attrs.BBox : null
    if (box) c.bounds = pdfRectToCanvas(info, box)
    if (typeof el.Text === 'string') c.text = el.Text.replace(/\s+$/, '')
    if (el.Font || el.TextSize) {
      const f = el.Font ?? {}
      const name = f.name ?? f.family_name ?? ''
      const cls = classifyFont(name, f.monospaced ? 'monospace' : '', { bold: (f.weight ?? 400) >= 600, italic: f.italic })
      const size = el.TextSize ?? 10
      c.style = {
        fontFamily: f.family_name ?? name, fontName: name, fallbackFont: cls.family, fontSize: Math.round(size * 100) / 100,
        fontWeight: f.weight ?? (cls.bold ? 700 : 400), italic: !!f.italic || cls.italic, underline: false, color: null,
        alignment: ALIGN[String(attrs.TextAlign ?? 'Start')] ?? 'left',
        lineHeight: num(attrs.LineHeight) ? Math.round(((attrs.LineHeight as number) / size) * 100) / 100 : 1.2, characterSpacing: 0,
      }
    }
    if (c.table) {
      c.table.rows = num(attrs.NumRow) ?? c.table.rows
      c.table.columns = num(attrs.NumCol) ?? c.table.columns
    }
    if (c.cell) {
      c.cell.row = num(attrs.RowIndex) ?? c.cell.row
      c.cell.col = num(attrs.ColIndex) ?? c.cell.col
      c.cell.rowSpan = num(attrs.RowSpan) ?? c.cell.rowSpan
      c.cell.colSpan = num(attrs.ColSpan) ?? c.cell.colSpan
    }
    if (c.type === 'FIGURE') c.image = { ref: el.filePaths?.[0], rotation: 0 }
  }

  for (const el of flat) {
    const pageIndex = el.Page ?? 0
    if (!pages[pageIndex] || typeof el.Path !== 'string') continue
    const segs = parsePath(el.Path)
    if (!segs.length) continue
    const key = keyOf(segs)
    const existing = byPath[pageIndex].get(key)
    if (existing) {
      // container element reported after its implicit creation (e.g. TD attributes): fill it in
      apply(pages[pageIndex].chunks[existing], el, infos[pageIndex])
      continue
    }
    const tag = segs[segs.length - 1].tag
    const parentId = ensure(pageIndex, segs.slice(0, -1))
    const parentType = parentId ? pages[pageIndex].chunks[parentId].type : null
    const t = typeOf(tag, parentType) ?? (el.Text ? { type: 'PARAGRAPH' as ChunkType } : null)
    if (!t) continue
    add(pageIndex, segs, t, parentId, el)
  }

  for (const page of pages) finish(page)
  return pages
}

/** Bottom-up: fill missing bounds/text from children, build table grids, hit order. */
function finish(page: LayoutPage) {
  const { chunks } = page
  const visit = (id: string) => {
    const c = chunks[id]
    c.children.forEach(visit)
    const kids = c.children.map((k) => chunks[k])
    if (!c.bounds.width && !c.bounds.height && kids.length) {
      const bs = kids.map((k) => k.bounds).filter((b) => b.width || b.height)
      if (bs.length) {
        const x0 = Math.min(...bs.map((b) => b.x))
        const y0 = Math.min(...bs.map((b) => b.y))
        c.bounds = { x: x0, y: y0, width: Math.max(...bs.map((b) => b.x + b.width)) - x0, height: Math.max(...bs.map((b) => b.y + b.height)) - y0 }
      }
    }
    if (c.text === undefined && kids.some((k) => k.text !== undefined) && c.type !== 'TABLE' && c.type !== 'TABLE_ROW' && c.type !== 'LIST') {
      c.text = kids.filter((k) => k.text !== undefined).map((k) => k.text).join(c.type === 'LIST_ITEM' ? ' ' : '\n')
    }
    if (!c.style && kids[0]?.style && c.text !== undefined) c.style = { ...kids[0].style }
    if (c.type === 'TABLE') buildGrid(page, c)
  }
  page.roots.forEach(visit)

  const selectable = Object.values(chunks).filter((c) => ['HEADING', 'PARAGRAPH', 'LIST_ITEM', 'TABLE_CELL', 'TABLE', 'LINE', 'RECTANGLE', 'IMAGE', 'FIGURE'].includes(c.type))
  page.hitOrder = selectable.sort((a, b) => a.bounds.width * a.bounds.height - b.bounds.width * b.bounds.height).map((c) => c.id)
  if (!page.roots.length) page.status = 'empty'
}

function buildGrid(page: LayoutPage, table: LayoutChunk) {
  const rows = table.children.filter((r) => page.chunks[r].type === 'TABLE_ROW')
  const grid: string[][] = []
  const slot = (r: number) => (grid[r] ??= [])
  rows.forEach((rid, r) => {
    let col = 0
    for (const cid of page.chunks[rid].children) {
      const cell = page.chunks[cid]
      if (cell.type !== 'TABLE_CELL' || !cell.cell) continue
      const row = cell.cell.row >= 0 ? cell.cell.row : r
      if (cell.cell.col < 0) {
        while (slot(row)[col]) col += 1
        cell.cell.col = col
      }
      cell.cell.row = row
      for (let dr = 0; dr < cell.cell.rowSpan; dr += 1) for (let dc = 0; dc < cell.cell.colSpan; dc += 1) slot(row + dr)[cell.cell.col + dc] = cid
      col = cell.cell.col + cell.cell.colSpan
    }
  })
  const columns = Math.max(table.table?.columns ?? 0, ...grid.map((r) => r?.length ?? 0))
  table.table = { rows: Math.max(table.table?.rows ?? 0, grid.length), columns, cells: Array.from({ length: grid.length }, (_, r) => Array.from({ length: columns }, (_, c) => grid[r]?.[c] ?? '')), kind: 'provider' }
}
