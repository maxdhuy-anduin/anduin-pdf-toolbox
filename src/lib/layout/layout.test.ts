import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyzePage } from '../content/analyze'
import { extractPage } from '../content/extract'
import { canvasRectToPdf, canvasToPdf, canvasToScreen, pdfRectToCanvas, pdfToCanvas, screenToCanvas } from '../coords'
import type { PageInfo } from '../model'
import { createLayoutSuite } from '../testDocs'
import { layoutFromAdobe, type AdobeExtract } from './adobe'
import { layoutFromTextItems } from './basic'
import { familyFromFontName, layoutFromContent } from './fromContent'
import { formatTree, treeRows } from './tree'
import type { ChunkType, LayoutPage } from './types'

const info = (rotate: PageInfo['rotate'], view: PageInfo['view'] = [10, 20, 622, 812]): PageInfo => {
  const w = view[2] - view[0]
  const h = view[3] - view[1]
  return { view, rotate, width: rotate % 180 ? h : w, height: rotate % 180 ? w : h }
}

describe('coordinates', () => {
  it.each([0, 90, 180, 270] as const)('pdfToCanvas / canvasToPdf round-trip at /Rotate %i', (rot) => {
    const i = info(rot)
    for (const p of [{ x: 10, y: 20 }, { x: 300.5, y: 400.25 }, { x: 622, y: 812 }]) {
      const c = pdfToCanvas(i, p)
      expect(c.x).toBeGreaterThanOrEqual(-1e-9)
      expect(c.y).toBeGreaterThanOrEqual(-1e-9)
      expect(c.x).toBeLessThanOrEqual(i.width + 1e-9)
      expect(c.y).toBeLessThanOrEqual(i.height + 1e-9)
      const back = canvasToPdf(i, c)
      expect(back.x).toBeCloseTo(p.x)
      expect(back.y).toBeCloseTo(p.y)
    }
  })
  it('flips y for an unrotated page (top-left origin, offset view box)', () => {
    const i = info(0)
    expect(pdfToCanvas(i, { x: 10, y: 812 })).toEqual({ x: 0, y: 0 })
    expect(pdfRectToCanvas(i, [110, 712, 210, 762])).toEqual({ x: 100, y: 50, width: 100, height: 50 })
    expect(canvasRectToPdf(i, { x: 100, y: 50, width: 100, height: 50 })).toEqual({ x: 110, y: 712, width: 100, height: 50 })
  })
  it.each([0, 90, 180, 270])('canvasToScreen / screenToCanvas round-trip with app rotation %i', (rotation) => {
    const v = { scale: 1.5, rotation, width: 612, height: 792 }
    const p = { x: 100, y: 50 }
    const s = canvasToScreen(p, v)
    const back = screenToCanvas(s, v)
    expect(back.x).toBeCloseTo(p.x)
    expect(back.y).toBeCloseTo(p.y)
  })
  it('rotating the page 90° clockwise puts its top-left corner at the top-right of the screen box', () => {
    const v = { scale: 1, rotation: 90, width: 612, height: 792 }
    expect(canvasToScreen({ x: 0, y: 0 }, v)).toEqual({ x: 792, y: 0 })
  })
})

let suite: LayoutPage[]
beforeAll(async () => {
  const doc = await pdfjs.getDocument({ data: (await createLayoutSuite()).slice(), verbosity: 0, fontExtraProperties: true, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise
  suite = []
  for (let i = 1; i <= doc.numPages; i += 1) suite.push(layoutFromContent(analyzePage(await extractPage(await doc.getPage(i), pdfjs as never)), 'suite', i - 1))
})

const of = (p: LayoutPage, t: ChunkType) => Object.values(p.chunks).filter((c) => c.type === t)

describe('local provider → LayoutChunk', () => {
  it('produces a consistent tree in canonical page space', () => {
    for (const p of suite) {
      expect(p.provider).toBe('local')
      for (const c of Object.values(p.chunks)) {
        expect(c.pageIndex).toBe(p.pageIndex)
        expect(c.transform).toEqual([1, 0, 0, 1, 0, 0])
        if (c.parent) expect(p.chunks[c.parent].children).toContain(c.id)
        for (const k of c.children) expect(p.chunks[k].parent).toBe(c.id)
        expect(c.bounds.x).toBeGreaterThanOrEqual(-1)
        expect(c.bounds.y).toBeGreaterThanOrEqual(-1)
        expect(c.bounds.x + c.bounds.width).toBeLessThanOrEqual(p.width + 1)
        expect(c.bounds.y + c.bounds.height).toBeLessThanOrEqual(p.height + 1)
      }
      for (const r of p.roots) expect(p.chunks[r].parent).toBeNull()
    }
  })
  it('types headings (with levels) and paragraphs', () => {
    const hs = of(suite[1], 'HEADING')
    expect(hs.map((h) => h.text)).toEqual(['Investment Strategy', 'Portfolio construction', 'Risk management'])
    expect(hs.map((h) => h.level)).toEqual([1, 2, 2])
    expect(of(suite[1], 'PARAGRAPH').filter((p) => !p.role)).toHaveLength(3)
  })
  it('groups consecutive list items into a LIST', () => {
    const lists = of(suite[6], 'LIST')
    expect(lists.length).toBeGreaterThanOrEqual(1)
    const items = lists[0].children.map((id) => suite[6].chunks[id])
    expect(items.length).toBeGreaterThanOrEqual(3)
    expect(items.every((i) => i.type === 'LIST_ITEM' && i.parent === lists[0].id)).toBe(true)
    expect(suite[6].roots).toContain(lists[0].id)
  })
  it('exposes tables as TABLE ▸ TABLE_ROW ▸ TABLE_CELL with grid info', () => {
    const t = of(suite[3], 'TABLE')[0]
    expect(t.table?.rows).toBeGreaterThan(2)
    expect(t.table?.cells).toHaveLength(t.table!.rows)
    const row = suite[3].chunks[t.children[0]]
    expect(row.type).toBe('TABLE_ROW')
    const cell = suite[3].chunks[row.children[0]]
    expect(cell.type).toBe('TABLE_CELL')
    expect(cell.cell).toMatchObject({ row: 0, col: 0, rowSpan: 1, colSpan: 1 })
  })
  it('keeps operator ownership so edits can hide/remove exactly', () => {
    const p = of(suite[0], 'PARAGRAPH')[0]
    expect(p.source.objectId).toBe(p.id)
    expect(p.source.ops?.length).toBeGreaterThan(0)
    expect(p.style?.fontSize).toBeGreaterThan(0)
  })
  it('describes rules, rectangles and images', () => {
    const g = suite[8]
    expect(of(g, 'LINE')[0].line?.strokeWidth).toBeGreaterThan(0)
    expect(of(g, 'IMAGE').length).toBeGreaterThan(0)
    expect(of(g, 'RECTANGLE').length).toBeGreaterThan(0)
  })
  it('prints an object tree', () => {
    const tree = formatTree(suite[6])
    expect(tree).toMatch(/LIST/)
    expect(tree).toMatch(/└── LI/)
    expect(tree).toMatch(/TABLE \d+×\d+/)
  })
  it('extracts readable family names', () => {
    expect(familyFromFontName('ABCDEF+TimesNewRomanPS-BoldMT')).toBe('Times New Roman')
    expect(familyFromFontName('Arial,Bold')).toBe('Arial')
    expect(familyFromFontName('Helvetica-Oblique')).toBe('Helvetica')
  })
})

describe('Adobe Extract adapter', () => {
  // Synthetic sample shaped like the documented structuredData.json (not real Adobe output).
  const json: AdobeExtract = {
    pages: [{ page_number: 0, width: 612, height: 792, rotation: 0 }],
    elements: [
      { Path: '//Document/H1', Page: 0, Bounds: [72, 700, 300, 724], Text: 'Fund Overview ', TextSize: 20, Font: { name: 'Arial-BoldMT', family_name: 'Arial', weight: 700, italic: false }, attributes: { TextAlign: 'Start', LineHeight: 24 } },
      { Path: '//Document/P', Page: 0, Bounds: [72, 640, 540, 690], Text: 'The Fund invests in growth equity.', TextSize: 10, Font: { name: 'TimesNewRomanPSMT', family_name: 'Times New Roman', weight: 400 }, attributes: { TextAlign: 'Justify', LineHeight: 12 } },
      { Path: '//Document/L/LI/Lbl', Page: 0, Bounds: [72, 610, 78, 620], Text: '• ' },
      { Path: '//Document/L/LI/LBody', Page: 0, Bounds: [84, 610, 300, 620], Text: 'First item ' },
      { Path: '//Document/L/LI[2]/Lbl', Page: 0, Bounds: [72, 595, 78, 605], Text: '• ' },
      { Path: '//Document/L/LI[2]/LBody', Page: 0, Bounds: [84, 595, 300, 605], Text: 'Second item ' },
      { Path: '//Document/Table', Page: 0, attributes: { BBox: [72, 400, 540, 560], NumRow: 3, NumCol: 3 } },
      { Path: '//Document/Table/TR/TH', Page: 0, attributes: { BBox: [72, 520, 540, 560], ColSpan: 3, RowIndex: 0, ColIndex: 0 } },
      { Path: '//Document/Table/TR/TH/P', Page: 0, Bounds: [80, 530, 200, 550], Text: 'Fees ', TextSize: 10, Font: { name: 'Arial-BoldMT', weight: 700 } },
      { Path: '//Document/Table/TR[2]/TD', Page: 0, attributes: { BBox: [72, 400, 200, 520], RowSpan: 2, RowIndex: 1, ColIndex: 0 } },
      { Path: '//Document/Table/TR[2]/TD/P', Page: 0, Bounds: [80, 480, 190, 500], Text: 'Management ' },
      { Path: '//Document/Table/TR[2]/TD[2]/P', Page: 0, Bounds: [210, 480, 360, 500], Text: '2.0% ' },
      { Path: '//Document/Table/TR[2]/TD[3]/P', Page: 0, Bounds: [370, 480, 530, 500], Text: 'committed ' },
      { Path: '//Document/Table/TR[3]/TD/P', Page: 0, Bounds: [210, 420, 360, 440], Text: '1.5% ' },
      { Path: '//Document/Table/TR[3]/TD[2]/P', Page: 0, Bounds: [370, 420, 530, 440], Text: 'invested ' },
      { Path: '//Document/Figure', Page: 0, Bounds: [72, 100, 272, 300], filePaths: ['figures/fileoutpart0.png'] },
    ],
  }
  const [page] = layoutFromAdobe(json, [info(0, [0, 0, 612, 792])], 'doc')

  it('converts bottom-left Bounds to canonical top-left space', () => {
    const h1 = Object.values(page.chunks).find((c) => c.type === 'HEADING')!
    expect(h1.bounds).toEqual({ x: 72, y: 68, width: 228, height: 24 })
    expect(h1.text).toBe('Fund Overview')
    expect(h1.level).toBe(1)
    expect(h1.style).toMatchObject({ fontFamily: 'Arial', fontWeight: 700, fontSize: 20, lineHeight: 1.2, fallbackFont: 'Helvetica' })
    expect(page.provider).toBe('adobe')
  })
  it('keeps reading order and maps types', () => {
    expect(page.roots.map((r) => page.chunks[r].type)).toEqual(['HEADING', 'PARAGRAPH', 'LIST', 'TABLE', 'FIGURE'])
    const p = page.chunks[page.roots[1]]
    expect(p.style?.alignment).toBe('justify')
    expect(p.style?.fallbackFont).toBe('Times')
  })
  it('builds lists from L / LI / Lbl / LBody', () => {
    const list = page.chunks[page.roots[2]]
    expect(list.children).toHaveLength(2)
    const li = page.chunks[list.children[1]]
    expect(li.type).toBe('LIST_ITEM')
    expect(li.text).toBe('• Second item')
  })
  it('builds a table grid with row and column spans', () => {
    const t = page.chunks[page.roots[3]]
    expect(t.table).toMatchObject({ rows: 3, columns: 3, kind: 'provider' })
    const grid = t.table!.cells
    const th = page.chunks[grid[0][0]]
    expect(th.cell).toMatchObject({ header: true, colSpan: 3 })
    expect(grid[0][1]).toBe(grid[0][0])
    expect(grid[0][2]).toBe(grid[0][0])
    const mgmt = page.chunks[grid[1][0]]
    expect(mgmt.text).toBe('Management')
    expect(mgmt.cell?.rowSpan).toBe(2)
    expect(grid[2][0]).toBe(grid[1][0])
    // row 3's first TD sits in column 1 because column 0 is taken by the row-spanning cell
    expect(page.chunks[grid[2][1]].text).toBe('1.5%')
    expect(page.chunks[grid[2][2]].text).toBe('invested')
    expect(treeRows(page).length).toBeGreaterThan(10)
  })
  it('keeps figures with their rendition reference', () => {
    const f = page.chunks[page.roots[4]]
    expect(f.image?.ref).toBe('figures/fileoutpart0.png')
    expect(f.bounds).toEqual({ x: 72, y: 492, width: 200, height: 200 })
  })
  it('converts Bounds on a /Rotate 90 page', () => {
    const [rp] = layoutFromAdobe({ elements: [{ Path: '//Document/P', Page: 0, Bounds: [100, 200, 300, 220], Text: 'x' }] }, [info(90, [0, 0, 612, 792])], 'r')
    const c = Object.values(rp.chunks)[0]
    expect(c.bounds).toEqual({ x: 200, y: 100, width: 20, height: 200 })
  })
})

describe('fallback layout', () => {
  it('turns PDF.js text items into TEXT_SPAN chunks', () => {
    const p = layoutFromTextItems([{ str: 'Hello', transform: [12, 0, 0, 12, 72, 700], width: 30, height: 12, fontName: 'Helvetica' }, { str: ' ', transform: [12, 0, 0, 12, 0, 0], width: 3, height: 12 }], info(0, [0, 0, 612, 792]), 's', 0, 'why')
    expect(p.status).toBe('basic')
    expect(p.roots).toHaveLength(1)
    const c = p.chunks[p.roots[0]]
    expect(c.type).toBe('TEXT_SPAN')
    expect(c.bounds.x).toBe(72)
    expect(c.bounds.y).toBeCloseTo(792 - 700 - 0.88 * 12)
    expect(p.warnings).toEqual(['why'])
  })
})
