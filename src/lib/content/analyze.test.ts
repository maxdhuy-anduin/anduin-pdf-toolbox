import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyzePage } from './analyze'
import { extractPage } from './extract'
import type { ContentObject, PageContent } from './types'
import { createLayoutSuite } from '../testDocs'
import { createSampleFund } from '../samples'

async function analyzeAll(bytes: Uint8Array): Promise<PageContent[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise
  const out: PageContent[] = []
  for (let i = 1; i <= doc.numPages; i += 1) out.push(analyzePage(await extractPage(await doc.getPage(i), pdfjs as never)))
  return out
}

const of = (c: PageContent, type: ContentObject['type'], role?: string) =>
  Object.values(c.objects).filter((o) => o.type === type && (!role || o.role === role))
const cellText = (c: PageContent, tableId: string, r: number, col: number) => c.objects[c.objects[tableId].cellIds![r][col]].text

let suite: PageContent[]
let fund: PageContent[]
beforeAll(async () => {
  suite = await analyzeAll(await createLayoutSuite())
  fund = await analyzeAll(await createSampleFund())
})

describe('text blocks', () => {
  it('groups wrapped lines into paragraphs and detects justification', () => {
    const paras = of(suite[0], 'TEXT_BLOCK', 'paragraph')
    expect(paras).toHaveLength(4)
    expect(paras.filter((p) => p.style?.align === 'justify')).toHaveLength(1)
    expect(paras[0].children.length).toBeGreaterThan(1)
    expect(paras[0].text).not.toContain('\n') // soft wraps reflow
  })
  it('separates headings from body text by size and weight', () => {
    expect(of(suite[1], 'TEXT_BLOCK', 'heading').map((h) => h.text)).toEqual(['Investment Strategy', 'Portfolio construction', 'Risk management'])
    expect(of(suite[1], 'TEXT_BLOCK', 'paragraph')).toHaveLength(3)
  })
  it('keeps two columns apart (justified, word-by-word text)', () => {
    const paras = of(suite[2], 'TEXT_BLOCK', 'paragraph')
    expect(paras).toHaveLength(4)
    expect(of(suite[2], 'TABLE')).toHaveLength(0)
    expect(new Set(paras.map((p) => Math.round(p.bounds.x)))).toEqual(new Set([64, 318]))
    for (const p of paras) expect(p.bounds.w).toBeLessThan(240)
  })
  it('detects list items with bullets', () => {
    const items = of(suite[6], 'TEXT_BLOCK', 'list-item')
    expect(items).toHaveLength(3)
    expect(items[0].text?.startsWith('•')).toBe(true)
  })
  it('detects headers and footers', () => {
    expect(of(suite[0], 'TEXT_BLOCK', 'header')).toHaveLength(2)
    expect(of(suite[0], 'TEXT_BLOCK', 'footer').map((f) => f.text)).toEqual(['Page 1 of 9'])
    expect(of(suite[0], 'TEXT_BLOCK', 'footer')[0].style?.align).toBe('center')
  })
  it('reads font family, weight, style and colour from the PDF', () => {
    const byText = (t: string) => of(suite[7], 'TEXT_BLOCK').find((b) => b.text?.startsWith(t))!
    expect(byText('Serif bold 12pt').style).toMatchObject({ fontFamily: 'Times', bold: true, italic: false, fontSize: 12 })
    expect(byText('Serif italic 12pt').style).toMatchObject({ bold: false, italic: true })
    expect(byText('Serif bold italic').style).toMatchObject({ bold: true, italic: true })
    expect(byText('Monospace').style?.fontFamily).toBe('Courier')
    expect(byText('Coloured text').style?.color).toBe('#ba1c1c')
    expect(byText('Centred closing').style?.align).toBe('center')
  })
  it('separates run-in bold headings from the paragraph below (fund sample)', () => {
    const heads = of(fund[5], 'TEXT_BLOCK', 'heading').map((h) => h.text)
    expect(heads).toEqual(expect.arrayContaining(['Risk Factors', 'Illiquidity.', 'Concentration.', 'Valuation.', 'Capital calls.']))
  })
  it('splits blocks into lines and style spans', () => {
    const line = of(suite[7], 'TEXT_LINE').find((l) => l.text?.startsWith('A line with bold'))!
    expect(line.children.length).toBe(5) // regular / bold / regular / italic / regular
  })
})

describe('tables', () => {
  for (const [page, kind] of [[3, 'lattice'], [4, 'rules'], [5, 'stream']] as const) {
    it(`detects a ${kind} table as 5 rows × 4 columns with addressable cells`, () => {
      const tables = of(suite[page], 'TABLE')
      expect(tables).toHaveLength(1)
      const t = tables[0]
      expect(t.tableKind).toBe(kind)
      expect([t.rows, t.cols]).toEqual([5, 4])
      expect(cellText(suite[page], t.id, 0, 0)).toBe('Fund')
      expect(cellText(suite[page], t.id, 1, 2)).toBe('$10,000,000')
      expect(cellText(suite[page], t.id, 4, 0)).toBe('Co-Invest Vehicle A')
      // the paragraph above is not swallowed by the table
      expect(of(suite[page], 'TEXT_BLOCK', 'paragraph').length).toBeGreaterThanOrEqual(1)
    })
  }
  it('detects the terms table with multi-line cells in the fund sample', () => {
    const t = of(fund[2], 'TABLE')[0]
    expect([t.rows, t.cols]).toEqual([8, 2])
    expect(cellText(fund[2], t.id, 0, 1)).toBe('$500,000,000')
    expect(cellText(fund[2], t.id, 2, 1)).toContain('investment period')
  })
  it('does not turn a bar chart with labels into a table', () => {
    expect(of(fund[4], 'TABLE')).toHaveLength(0)
  })
})

describe('graphics', () => {
  it('detects images, rectangles and rules with colour and thickness', () => {
    const p = suite[8]
    expect(of(p, 'IMAGE')).toHaveLength(1)
    const lines = of(p, 'LINE')
    expect(lines.map((l) => Math.round(l.thickness! * 10) / 10).sort()).toEqual([0.5, 2])
    expect(of(p, 'RECTANGLE').length).toBeGreaterThanOrEqual(4)
    const callout = of(p, 'RECTANGLE').find((r) => r.strokeColor && r.fillColor)!
    expect(callout).toBeTruthy()
    const inside = of(p, 'TEXT_BLOCK').filter((b) => b.bounds.x > callout.bounds.x && b.bounds.y > callout.bounds.y && b.bounds.y < callout.bounds.y + callout.bounds.h)
    expect(inside.length).toBe(2) // "Callout box" + its paragraph
  })
})

describe('hit testing support', () => {
  it('orders selectable objects smallest first and marks exclusive operators', () => {
    const c = suite[3]
    const types = c.hitOrder.map((id) => c.objects[id].type)
    expect(types.indexOf('TABLE_CELL')).toBeLessThan(types.indexOf('TABLE'))
    for (const b of of(suite[0], 'TEXT_BLOCK')) expect(b.opsExclusive).toBe(true)
  })
  it('classifies pages', () => {
    expect(suite.every((p) => p.kind === 'digital')).toBe(true)
  })
})
