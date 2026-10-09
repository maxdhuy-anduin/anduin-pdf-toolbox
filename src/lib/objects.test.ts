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

describe('selection model', () => {
  it('marquee picks a table only when fully enclosed, otherwise the cells it touches', async () => {
    const { pageItems, marqueeSelect } = await import('./objects')
    const c = await analyze(suite, 3)
    const items = pageItems(c, [])
    const table = of(c, (o) => o.type === 'TABLE')[0]
    const all = marqueeSelect(items, { x: table.bounds.x - 5, y: table.bounds.y - 5, w: table.bounds.w + 10, h: table.bounds.h + 10 })
    expect(all).toContain(`o:${table.id}`)
    expect(all.some((k) => k.includes('c0_'))).toBe(false) // cells come with the table
    const part = marqueeSelect(items, { x: table.bounds.x + 1, y: table.bounds.y + 1, w: 40, h: 10 })
    expect(part).not.toContain(`o:${table.id}`)
    expect(part.length).toBeGreaterThan(0)
  })

  it('moves a mixed selection rigidly in one undo step', async () => {
    const { pageItems, planMove } = await import('./objects')
    const { reducer, initialState } = await import('./model')
    const c = await analyze(suite, 3)
    const table = of(c, (o) => o.type === 'TABLE')[0]
    const heading = of(c, (o) => o.type === 'TEXT_BLOCK' && o.role === 'heading')[0]
    const page = makePage('suite', 3)
    let st = reducer(initialState, { type: 'load', source: meta, fileName: 'suite.pdf' })
    st = { ...st, pages: st.pages.map((p, i) => (i === 3 ? { ...p, id: page.id } : p)) }
    const keys = [`o:${table.id}`, `o:${heading.id}`]
    const r1 = planMove(st.pages[3], c, keys, 10, 50)
    st = reducer(st, { type: 'editOverlays', pageId: page.id, add: r1.add, update: r1.update, remove: r1.remove })
    expect(st.past).toHaveLength(1)
    const moves = st.pages[3].overlays
    expect(moves.length).toBe(1 + 1 + table.rows! * table.cols!) // table, heading, every cell
    expect(moves.every((m) => m.type === 'move' && m.dx === 10 && m.dy === 50)).toBe(true)
    // moving again updates the same overlays (offsets accumulate)
    const r2 = planMove(st.pages[3], c, keys, -10, 5)
    expect(r2.add).toHaveLength(0)
    st = reducer(st, { type: 'editOverlays', pageId: page.id, update: r2.update })
    expect(st.pages[3].overlays.every((m) => m.type === 'move' && m.dx === 0 && m.dy === 55)).toBe(true)
    const items = pageItems(c, st.pages[3].overlays)
    expect(items.find((i) => i.key === `o:${heading.id}`)!.bounds.y).toBeCloseTo(heading.bounds.y + 55)
    st = reducer(st, { type: 'undo' })
    expect(st.pages[3].overlays.every((m) => m.type === 'move' && m.dy === 50)).toBe(true)
  })

  it('copies with positions relative to the selection top-left', async () => {
    const { pageItems, copySelection } = await import('./objects')
    const c = await analyze(suite, 0)
    const paras = of(c, (o) => o.type === 'TEXT_BLOCK' && o.role === 'paragraph').slice(0, 2)
    const page = makePage('suite', 0)
    const items = pageItems(c, [])
    const sel = copySelection(page, c, items, paras.map((p) => `o:${p.id}`))!
    expect(sel.origin).toEqual({ x: Math.min(...paras.map((p) => p.bounds.x)), y: paras[0].bounds.y })
    expect(sel.groups).toHaveLength(1)
    const g = sel.groups[0]
    // pasting at T draws item i at item.bounds + shift + T, i.e. same layout relative to T
    const T = { x: 300, y: 500 }
    const placed = g.items.map((i) => ({ x: i.bounds.x + g.shift.x + T.x, y: i.bounds.y + g.shift.y + T.y }))
    expect(placed[0].y).toBeCloseTo(T.y)
    expect(placed[1].y - placed[0].y).toBeCloseTo(paras[1].bounds.y - paras[0].bounds.y)
    expect(sel.text).toContain(paras[0].text!.slice(0, 20))
  })
})

describe('no automatic text fields', () => {
  it('moving or deleting any table never creates text boxes (empty cells are skipped)', async () => {
    const { planMove, planDelete } = await import('./objects')
    for (let i = 0; i < 9; i += 1) {
      const c = structuredClone(await analyze(suite, i))
      // blank out every other cell, like a form table with empty fields
      of(c, (o) => o.type === 'TABLE_CELL').forEach((cell, k) => {
        if (k % 2) Object.assign(cell, { text: '', ops: [], opsExclusive: false, children: [], sourceItems: [] })
      })
      for (const t of of(c, (o) => o.type === 'TABLE')) {
        const page = makePage('suite', i)
        for (const r of [planMove(page, c, [`o:${t.id}`], 5, 5), planDelete(page, c, [`o:${t.id}`])]) {
          expect(r.add.filter((o) => o.type === 'text')).toEqual([])
        }
      }
    }
  })

  it('exports drawn lines as vector lines', async () => {
    const { makeLineOverlay } = await import('./model')
    const { bytes } = await exportPages([{ index: 0, overlays: [makeLineOverlay(72, 700, 300, 700, { thickness: 2, color: '#ef6445' }), makeLineOverlay(72, 720, 300, 720, { dash: 'dashed' })] }])
    const after = await analyze(bytes, 0)
    const rules = of(after, (o) => o.type === 'LINE' && Math.abs(o.bounds.y + o.bounds.h / 2 - 700) < 2)
    expect(rules).toHaveLength(1)
    expect(rules[0].bounds.x).toBeCloseTo(72, 0)
    expect(rules[0].bounds.w).toBeCloseTo(228, 0)
    expect(rules[0].strokeColor).toBe('#ef6445')
  })
})
