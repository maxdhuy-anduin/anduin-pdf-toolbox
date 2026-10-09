import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildPdf, wrapLines } from './export'
import { BASELINE_RATIO } from './coords'
import { makePage, makeTextOverlay, type PageModel, type SourceMeta } from './model'
import { createSampleFund, createSampleSupplement } from './samples'
import { blankPdf, metaFromBytes, pageTexts, viewItems } from '../test/helpers'

let fund: Uint8Array
let supp: Uint8Array
let fundMeta: SourceMeta
let suppMeta: SourceMeta
let sources: Record<string, SourceMeta>
const bytes = (id: string) => (id === 'fund' ? fund : supp)

beforeAll(async () => {
  fund = await createSampleFund()
  supp = await createSampleSupplement()
  fundMeta = await metaFromBytes('fund', 'fund.pdf', fund)
  suppMeta = await metaFromBytes('supp', 'supp.pdf', supp)
  sources = { fund: fundMeta, supp: suppMeta }
})

const fundPages = () => Array.from({ length: fundMeta.numPages }, (_, i) => makePage('fund', i))

describe('buildPdf', () => {
  it('samples are real, 7 and 3 pages', () => {
    expect(fundMeta.numPages).toBe(7)
    expect(suppMeta.numPages).toBe(3)
  })

  it('preserves reordering, deletion and duplication in the exported file', async () => {
    const p = fundPages()
    // delete page 4 (notes), move page 7 to position 2, duplicate page 3
    const order = [p[0], p[6], p[1], p[2], { ...p[2], id: 'dup' }, p[4], p[5]]
    const { bytes: out } = await buildPdf(order, sources, bytes)
    const texts = await pageTexts(out)
    expect(texts).toHaveLength(7)
    expect(texts[1]).toContain('Subscription Instructions')
    expect(texts[2]).toContain('Contents')
    expect(texts[3]).toContain('Summary of Principal Terms')
    expect(texts[4]).toContain('Summary of Principal Terms')
    expect(texts.join(' ')).not.toContain('INTERNAL DRAFTING NOTES')
  })

  it('inserts pages from another PDF at the right place', async () => {
    const p = fundPages().slice(0, 3)
    const ins = [makePage('supp', 0), makePage('supp', 2)]
    const { bytes: out } = await buildPdf([p[0], p[1], ...ins, p[2]], sources, bytes)
    const texts = await pageTexts(out)
    expect(texts).toHaveLength(5)
    expect(texts[2]).toContain('Supplemental Disclosure')
    expect(texts[3]).toContain('Fee Schedule')
    expect(texts[4]).toContain('Summary of Principal Terms')
  })

  it('extracts a subset into a valid, independent PDF', async () => {
    const p = fundPages()
    const { bytes: out } = await buildPdf([p[2], p[4]], sources, bytes)
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(2)
    const texts = await pageTexts(out)
    expect(texts[0]).toContain('Summary of Principal Terms')
    expect(texts[1]).toContain('Investment Strategy')
  })

  it('applies rotation on top of the intrinsic page rotation', async () => {
    const p = fundPages()
    const { bytes: out } = await buildPdf([{ ...p[0], rotation: 90 }, p[1]], sources, bytes)
    const doc = await PDFDocument.load(out)
    expect(doc.getPage(0).getRotation().angle).toBe(90)
    expect(doc.getPage(1).getRotation().angle).toBe(0)
  })

  it('writes text overlays that survive a reopen, and covers the original text', async () => {
    const p = fundPages()
    const page: PageModel = {
      ...p[2],
      overlays: [
        makeTextOverlay(72, 100, { text: 'Hello Overlay', fontSize: 18, bold: true, color: '#cc0000' }),
        makeTextOverlay(72, 200, { text: 'Edited value', cover: { x: 250, y: 190, w: 100, h: 20, color: '#ffffff' } }),
      ],
    }
    const { bytes: out, warnings } = await buildPdf([page], sources, bytes)
    // a cover with no detected source object can only paint over the original: say so
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/only covered.*still in the file/)
    const doc = await PDFDocument.load(out)
    expect(doc.getPageCount()).toBe(1)
    const items = await viewItems(out, 0)
    expect(items.some((i) => i.str.includes('Hello Overlay'))).toBe(true)
    expect(items.some((i) => i.str.includes('Edited value'))).toBe(true)
  })

  it('warns when characters cannot be encoded by the standard fonts', async () => {
    const p = fundPages()
    const page = { ...p[0], overlays: [makeTextOverlay(50, 50, { text: 'Price ≥ 5 — ok' })] }
    const { warnings, bytes: out } = await buildPdf([page], sources, bytes)
    expect(warnings).toHaveLength(1)
    expect((await pageTexts(out))[0]).toContain('Price ? 5')
  })

  it('rejects an empty page list', async () => {
    await expect(buildPdf([], sources, bytes)).rejects.toThrow()
  })
})

describe('overlay placement matches PDF.js view space for every page rotation', () => {
  for (const intrinsic of [0, 90, 180, 270]) {
    for (const extra of [0, 90, 180]) {
      it(`intrinsic ${intrinsic}° + user ${extra}°`, async () => {
        const raw = await blankPdf([[400, 600]], [intrinsic])
        const meta = await metaFromBytes('r', 'r.pdf', raw)
        const o = makeTextOverlay(80, 120, { text: 'Marker', fontSize: 20 })
        const page: PageModel = { ...makePage('r', 0), rotation: extra as 0, overlays: [o] }
        const { bytes: out } = await buildPdf([page], { r: meta }, () => raw)
        // The overlay is attached to the intrinsic view; the user rotation then spins the whole page.
        // Re-derive the expected position by rotating (80, base+120) about the intrinsic page.
        const items = await viewItems(out, 0)
        const it = items.find((i) => i.str === 'Marker')!
        expect(it).toBeTruthy()
        const W = meta.pages[0].width
        const H = meta.pages[0].height
        const bx = 80
        const by = 120 + 20 * BASELINE_RATIO.Helvetica
        let ex = bx, ey = by
        for (let k = 0; k < extra / 90; k += 1) {
          // 90° clockwise rotation of a (w × h) page: (x, y) -> (h - y, x)
          const nx = (k % 2 === 0 ? H : W) - ey
          ;[ex, ey] = [nx, ex]
        }
        expect(it.x).toBeCloseTo(ex, 0)
        expect(it.y).toBeCloseTo(ey, 0)
        expect(it.size).toBeCloseTo(20, 0)
      })
    }
  }
})

describe('wrapLines', () => {
  const m = (s: string) => s.length * 10
  it('wraps on spaces and honours newlines', () => {
    expect(wrapLines('aaa bbb ccc', 70, true, m)).toEqual(['aaa bbb', 'ccc'])
    expect(wrapLines('a\n\nb', 100, true, m)).toEqual(['a', '', 'b'])
  })
  it('breaks over-long words', () => {
    expect(wrapLines('abcdefghij', 40, true, m)).toEqual(['abcd', 'efgh', 'ij'])
  })
  it('does not wrap in nowrap mode', () => {
    expect(wrapLines('aaa bbb ccc', 10, false, m)).toEqual(['aaa bbb ccc'])
  })
})

describe('Stage 6 demo workflow (end to end on the model)', () => {
  it('delete a page, move a page, insert a page from another PDF, edit text, add text, export', async () => {
    const { initialState, reducer } = await import('./model')
    let s = reducer(initialState, { type: 'load', source: fundMeta, fileName: 'fund.pdf' })
    const ids = s.pages.map((p) => p.id)

    // 2. delete the internal-notes page (original page 4)
    s = reducer(s, { type: 'deletePages', ids: [ids[3]] })
    // 3. move the subscription page (original 7) to the front of the body, after the cover
    s = reducer(s, { type: 'movePages', ids: [ids[6]], before: 1 })
    // 4. insert the supplement's fee schedule after the (new) page 2
    s = reducer(s, { type: 'addSource', source: suppMeta })
    s = reducer(s, { type: 'insertPages', index: 2, pages: [makePage('supp', 2)] })
    // 5. edit existing text on the terms page: cover the old value, replace it
    const terms = s.pages.find((p) => p.sourceId === 'fund' && p.srcIndex === 2)!
    const items = await viewItems(fund, 2)
    const target = items.find((i) => i.str.includes('$500,000,000'))!
    expect(target).toBeTruthy()
    const edit = makeTextOverlay(target.x, target.y - target.size * 0.9375, {
      text: '$750,000,000', fontFamily: 'Times', fontSize: target.size, wrap: false, width: 80,
      cover: { x: target.x - 1.5, y: target.y - target.size * 0.88, w: 82, h: target.size * 1.15, color: '#ffffff' },
    })
    s = reducer(s, { type: 'addOverlay', pageId: terms.id, overlay: edit })
    // 6. add a text correction elsewhere on the page
    s = reducer(s, { type: 'addOverlay', pageId: terms.id, overlay: makeTextOverlay(64, 600, { text: 'Corrected per counsel', bold: true, color: '#b91c1c' }) })

    // 7. export + reopen
    const { bytes, warnings } = await buildPdf(s.pages, s.sources, bytesOf)
    // the hand-made cover edit above has no source object, so the old value is only painted over
    expect(warnings).toEqual([expect.stringMatching(/only covered.*still in the file/)])
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(7) // 7 - 1 deleted + 1 inserted
    const texts = await pageTexts(bytes)
    expect(texts[0]).toContain('Meridian Growth')
    expect(texts[1]).toContain('Subscription Instructions')
    expect(texts[2]).toContain('Fee Schedule')
    expect(texts.join(' ')).not.toContain('INTERNAL DRAFTING NOTES')
    const termsText = texts[4 - 0] // cover, subscription, fee schedule, contents, terms
    expect(termsText).toContain('$750,000,000')
    expect(termsText).toContain('Corrected per counsel')
  })
})
function bytesOf(id: string) {
  return id === 'fund' ? fund : supp
}
