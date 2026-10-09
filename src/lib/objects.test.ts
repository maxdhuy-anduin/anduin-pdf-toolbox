import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyzePage } from './content/analyze'
import { extractPage } from './content/extract'
import { moveOverlayFor, sourceRef } from './content/edits'
import type { ContentObject, PageContent } from './content/types'
import { buildPdf } from './export'
import { makePage, uid, type Overlay, type PasteOverlay, type SourceMeta } from './model'
import { createLayoutSuite } from './testDocs'
import { metaFromBytes, pageTexts } from '../test/helpers'

async function analyze(bytes: Uint8Array, index: number): Promise<PageContent> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' })
  const doc = await task.promise
  const c = analyzePage(await extractPage(await doc.getPage(index + 1), pdfjs as never))
  await task.destroy()
  return c
}

let suite: Uint8Array
let meta: SourceMeta
beforeAll(async () => {
  suite = await createLayoutSuite()
  meta = await metaFromBytes('suite', 'suite.pdf', suite)
})
const of = (c: PageContent, pred: (o: ContentObject) => boolean) => Object.values(c.objects).filter(pred)
const exportPages = (pages: { index: number; overlays: Overlay[] }[]) =>
  buildPdf(pages.map((p) => ({ ...makePage('suite', p.index), overlays: p.overlays })), { suite: meta }, () => suite)

describe('rigid moves keep the original drawing', () => {
  it('moves a whole ruled table (rules + every cell) without re-typesetting it', async () => {
    const c = await analyze(suite, 3)
    const table = of(c, (o) => o.type === 'TABLE')[0]
    expect(table.ops.length).toBeGreaterThan(0) // the table owns its rules
    const cells = of(c, (o) => o.type === 'TABLE_CELL')
    const members = [table, ...cells]
    const dy = 200
    const { bytes, stats, warnings } = await exportPages([{ index: 3, overlays: members.map((m) => moveOverlayFor(m, { dy })) }])
    expect(warnings).toEqual([])
    expect(stats.covered).toBe(0)
    const after = await analyze(bytes, 0)
    const t2 = of(after, (o) => o.type === 'TABLE')[0]
    expect(t2).toBeTruthy()
    expect(t2.bounds.y).toBeCloseTo(table.bounds.y + dy, 0)
    expect(t2.bounds.x).toBeCloseTo(table.bounds.x, 0)
    expect([t2.rows, t2.cols]).toEqual([table.rows, table.cols])
    // same text, same font, same size: drawn by the original operators
    for (const cell of cells.filter((x) => x.text)) {
      const moved = of(after, (o) => o.type === 'TABLE_CELL' && o.text === cell.text)[0]
      expect(moved, cell.text).toBeTruthy()
      expect(moved.style?.fontName).toBe(cell.style?.fontName)
      expect(moved.style?.fontSize).toBe(cell.style?.fontSize)
      expect(moved.bounds.y).toBeCloseTo(cell.bounds.y + dy, 0)
    }
    // nothing left behind where the table was
    expect(of(after, (o) => o.type === 'LINE' && o.bounds.y < table.bounds.y + table.bounds.h && o.bounds.y > table.bounds.y - 1)).toHaveLength(0)
  })

  it('moves a paragraph and a rule together, and deletes another paragraph', async () => {
    const c = await analyze(suite, 0)
    const paras = of(c, (o) => o.type === 'TEXT_BLOCK' && o.role === 'paragraph')
    const { bytes, stats } = await exportPages([{ index: 0, overlays: [moveOverlayFor(paras[0], { dx: 30, dy: 400 }), moveOverlayFor(paras[1], { deleted: true })] }])
    expect(stats).toEqual({ removed: 2, covered: 0 })
    const text = (await pageTexts(bytes))[0]
    expect(text).not.toContain(paras[1].text!.slice(0, 30))
    const after = await analyze(bytes, 0)
    const moved = of(after, (o) => o.type === 'TEXT_BLOCK' && o.text === paras[0].text)[0]
    expect(moved.bounds.x).toBeCloseTo(paras[0].bounds.x + 30, 0)
    expect(moved.bounds.y).toBeCloseTo(paras[0].bounds.y + 400, 0)
    expect(moved.style?.align).toBe(paras[0].style?.align)
  })

  it('deletes a table completely (rules, fills and text)', async () => {
    const c = await analyze(suite, 3)
    const table = of(c, (o) => o.type === 'TABLE')[0]
    const cells = of(c, (o) => o.type === 'TABLE_CELL')
    const { bytes } = await exportPages([{ index: 3, overlays: [table, ...cells].map((m) => moveOverlayFor(m, { deleted: true })) }])
    const after = await analyze(bytes, 0)
    expect(of(after, (o) => o.type === 'TABLE')).toHaveLength(0)
    expect(of(after, (o) => o.type === 'LINE' && o.bounds.y > table.bounds.y - 2 && o.bounds.y < table.bounds.y + table.bounds.h + 2)).toHaveLength(0)
  })
})

describe('paste', () => {
  it('stamps copied objects from another page as real, selectable text in the original font', async () => {
    const src = await analyze(suite, 1)
    const heading = of(src, (o) => o.type === 'TEXT_BLOCK' && o.text === 'Investment Strategy')[0]
    const paste: PasteOverlay = { id: uid('paste'), type: 'paste', sourceId: 'suite', srcIndex: 1, items: [sourceRef(heading)], dx: 0, dy: 500 }
    const { bytes, warnings } = await exportPages([{ index: 0, overlays: [paste] }])
    expect(warnings).toEqual([])
    const after = await analyze(bytes, 0)
    const h = of(after, (o) => o.type === 'TEXT_BLOCK' && o.text === 'Investment Strategy')[0]
    expect(h).toBeTruthy()
    expect(h.style?.fontName).toBe(heading.style?.fontName)
    expect(h.bounds.y).toBeCloseTo(heading.bounds.y + 500, 0)
    // only the copied object came along
    const others = of(src, (o) => o.type === 'TEXT_BLOCK' && o.id !== heading.id && !!o.text)
    const before = (await pageTexts(suite))[0]
    const text = (await pageTexts(bytes))[0]
    for (const o of others.filter((x) => !before.includes(x.text!.slice(0, 25)))) expect(text).not.toContain(o.text!.slice(0, 25))
  })
})
