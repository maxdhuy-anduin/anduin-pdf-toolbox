import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyzePage } from '../content/analyze'
import { extractPage } from '../content/extract'
import { graphicOverlayFromObject, textOverlayFromObject } from '../content/edits'
import type { ContentObject, PageContent } from '../content/types'
import { buildPdf } from '../export'
import { makePage, type Overlay, type PageModel, type SourceMeta } from '../model'
import { createLayoutSuite } from '../testDocs'
import { createSampleFund } from '../samples'
import { metaFromBytes, pageTexts } from '../../test/helpers'

async function analyze(bytes: Uint8Array, index: number): Promise<PageContent> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' })
  const doc = await task.promise
  const c = analyzePage(await extractPage(await doc.getPage(index + 1), pdfjs as never))
  await task.destroy()
  return c
}

let suite: Uint8Array
let fund: Uint8Array
let suiteMeta: SourceMeta
let fundMeta: SourceMeta
beforeAll(async () => {
  suite = await createLayoutSuite()
  fund = await createSampleFund()
  suiteMeta = await metaFromBytes('suite', 'suite.pdf', suite)
  fundMeta = await metaFromBytes('fund', 'fund.pdf', fund)
})

const bytesOf = (id: string) => (id === 'suite' ? suite : fund)
const sources = () => ({ suite: suiteMeta, fund: fundMeta })
const find = (c: PageContent, pred: (o: ContentObject) => boolean) => Object.values(c.objects).find(pred)!

async function exportOne(sourceId: 'suite' | 'fund', index: number, overlays: Overlay[]) {
  const page: PageModel = { ...makePage(sourceId, index), overlays }
  return buildPdf([page], sources(), bytesOf)
}

describe('true removal of edited objects (content stream rewrite)', () => {
  it('replaces a paragraph: the original text is gone from the file, not just covered', async () => {
    const c = await analyze(suite, 0)
    const para = find(c, (o) => o.type === 'TEXT_BLOCK' && !!o.text?.startsWith('Investments will generally'))
    const ov = textOverlayFromObject(para, c, null)
    ov.text = 'Rewritten paragraph text.'
    const { bytes, stats } = await exportOne('suite', 0, [ov])
    expect(stats).toEqual({ removed: 1, covered: 0 })
    const text = (await pageTexts(bytes))[0]
    expect(text).not.toContain('minority or control')
    expect(text).toContain('Rewritten paragraph text.')
    expect(text).toContain('The Partnership seeks to generate') // neighbours untouched
    expect(text).toContain('Prospective investors should')
  })

  it('edits one table cell without disturbing the rest of the row', async () => {
    const c = await analyze(suite, 4)
    const cell = find(c, (o) => o.type === 'TABLE_CELL' && o.text === '$10,000,000')
    const ov = textOverlayFromObject(cell, c, null)
    ov.text = '$12,500,000'
    const { bytes, stats } = await exportOne('suite', 4, [ov])
    expect(stats.removed).toBe(1)
    const text = (await pageTexts(bytes))[0]
    expect(text).not.toContain('$10,000,000')
    expect(text).toContain('$12,500,000')
    for (const s of ['Meridian Growth I', '2016', '98%', '$20,000,000']) expect(text).toContain(s)
    // the table is still detected as the same table after export
    const after = await analyze(bytes, 0)
    const t = find(after, (o) => o.type === 'TABLE')
    expect([t.rows, t.cols]).toEqual([5, 4])
  })

  it('deletes text (a fund-sample run-in heading)', async () => {
    const c = await analyze(fund, 5)
    const h = find(c, (o) => o.type === 'TEXT_BLOCK' && o.text === 'Illiquidity.')
    const ov = textOverlayFromObject(h, c, null)
    ov.text = ''
    const { bytes, stats } = await exportOne('fund', 5, [ov])
    expect(stats.removed).toBe(1)
    const text = (await pageTexts(bytes))[0]
    expect(text).not.toContain('Illiquidity.')
    expect(text).toContain('Interests are not freely transferable')
  })

  it('moves a rule and deletes a rectangle', async () => {
    const c = await analyze(suite, 8)
    const rule = find(c, (o) => o.type === 'LINE' && (o.thickness ?? 0) > 1.5)
    const bar = find(c, (o) => o.type === 'RECTANGLE' && o.fillColor === '#17294f' && o.bounds.h < 20)
    const moved = graphicOverlayFromObject(rule, c, null)
    moved.y += 40
    const gone = graphicOverlayFromObject(bar, c, null)
    gone.deleted = true
    const { bytes, stats } = await exportOne('suite', 8, [moved, gone])
    expect(stats).toEqual({ removed: 2, covered: 0 })
    const after = await analyze(bytes, 0)
    const lines = Object.values(after.objects).filter((o) => o.type === 'LINE')
    expect(lines.some((l) => Math.abs(l.bounds.y - (rule.bounds.y + 40)) < 1.5)).toBe(true)
    expect(lines.some((l) => Math.abs(l.bounds.y - rule.bounds.y) < 1.5 && (l.thickness ?? 0) > 1.5)).toBe(false)
    const rects = Object.values(after.objects).filter((o) => o.type === 'RECTANGLE')
    expect(rects.length).toBe(Object.values(c.objects).filter((o) => o.type === 'RECTANGLE').length - 1)
  })

  it('moves and resizes an image by re-transforming its XObject (no re-encoding)', async () => {
    const c = await analyze(suite, 8)
    const img = find(c, (o) => o.type === 'IMAGE')
    const g = graphicOverlayFromObject(img, c, null)
    g.x += 30
    g.y += 300
    g.w = img.bounds.w / 2
    g.h = img.bounds.h / 2
    const { bytes, stats } = await exportOne('suite', 8, [g])
    expect(stats.removed).toBe(1)
    const after = await analyze(bytes, 0)
    const moved = find(after, (o) => o.type === 'IMAGE')
    expect(moved.bounds.x).toBeCloseTo(img.bounds.x + 30, 0)
    expect(moved.bounds.y).toBeCloseTo(img.bounds.y + 300, 0)
    expect(moved.bounds.w).toBeCloseTo(img.bounds.w / 2, 0)
    // file size stays small: the image stream is reused, not duplicated
    expect(bytes.length).toBeLessThan(suite.length)
  })

  it('keeps text positions intact when removing one of several runs on a line', async () => {
    const c = await analyze(suite, 7)
    const line = find(c, (o) => o.type === 'TEXT_BLOCK' && !!o.text?.startsWith('A line with bold'))
    const ov = textOverlayFromObject(line, c, null)
    const { bytes, stats } = await exportOne('suite', 7, [ov])
    expect(stats.removed).toBe(1)
    // the centred remark below must still be where it was
    const after = await analyze(bytes, 0)
    const before = find(c, (o) => o.type === 'TEXT_BLOCK' && o.text === 'Centred closing remark')
    const kept = find(after, (o) => o.type === 'TEXT_BLOCK' && o.text === 'Centred closing remark')
    expect(kept.bounds.x).toBeCloseTo(before.bounds.x, 1)
  })

  it('exports open cleanly in pdf-lib after content rewrites', async () => {
    const c = await analyze(suite, 3)
    const cells = Object.values(c.objects).filter((o) => o.type === 'TABLE_CELL' && o.text).slice(0, 6)
    const ovs = cells.map((cell) => Object.assign(textOverlayFromObject(cell, c, null), { text: `${cell.text}*` }))
    const { bytes } = await exportOne('suite', 3, ovs)
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    const text = (await pageTexts(bytes))[0]
    expect(text).toContain('Fund*')
  })
})
