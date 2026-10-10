// Crop (like Apple Preview): the model keeps a canonical crop box per page; the export sets the
// page's CropBox to it. Every export check reopens the bytes and compares where text lands.
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { buildPdf } from './export'
import { cropPages, displaySize, initialState, makePage, reducer, type PageInfo } from './model'
import { pdfFileName } from './saveFile'
import { metaFromBytes, viewItems } from '../test/helpers'

const letter: PageInfo = { view: [0, 0, 612, 792], rotate: 0, width: 612, height: 792 }

describe('cropPages', () => {
  const pages = [makePage('s', 0), makePage('s', 1)]
  const info = () => letter

  it('clips the box to the page and leaves other pages alone', () => {
    const out = cropPages(pages, [pages[0].id], { x: -20, y: 100, w: 300, h: 900 }, info)
    expect(out[0].crop).toEqual({ x: 0, y: 100, w: 280, h: 692 })
    expect(out[1]).toBe(pages[1])
  })

  it('ignores a box that is too small, and removes the crop for a box covering the whole page', () => {
    expect(cropPages(pages, [pages[0].id], { x: 10, y: 10, w: 5, h: 300 }, info)).toBe(pages)
    const cropped = cropPages(pages, [pages[0].id], { x: 10, y: 10, w: 100, h: 100 }, info)
    const whole = cropPages(cropped, [pages[0].id], { x: 0, y: 0, w: 612, h: 792 }, info)
    expect('crop' in whole[0]).toBe(false)
    expect(cropPages(cropped, [pages[0].id], null, info)[0].crop).toBeUndefined()
  })

  it('shows the crop size, swapped by the page rotation', () => {
    const p = { ...makePage('s', 0), crop: { x: 10, y: 20, w: 200, h: 100 } }
    expect(displaySize(p, letter)).toEqual({ w: 200, h: 100 })
    expect(displaySize({ ...p, rotation: 90 }, letter)).toEqual({ w: 100, h: 200 })
  })

  it('is one undo step, and a no-op adds no history', () => {
    const meta = { id: 's', name: 's.pdf', size: 1, numPages: 2, pages: [letter, letter], likelyScanned: false }
    const loaded = reducer(initialState, { type: 'load', source: meta, fileName: 's.pdf' })
    const ids = loaded.pages.map((p) => p.id)
    const cropped = reducer(loaded, { type: 'cropPages', ids, box: { x: 50, y: 50, w: 300, h: 300 } })
    expect(cropped.pages.every((p) => p.crop)).toBe(true)
    expect(reducer(cropped, { type: 'cropPages', ids, box: { x: 50, y: 50, w: 300, h: 300 } })).toBe(cropped)
    expect(reducer(cropped, { type: 'undo' }).pages.every((p) => !p.crop)).toBe(true)
  })
})

describe('exporting a cropped page', () => {
  it('sets the crop box so the kept area shows exactly, at every /Rotate and with an offset media box', async () => {
    for (const rot of [0, 90, 180, 270]) {
      const doc = await PDFDocument.create()
      const page = doc.addPage([500, 700])
      page.setMediaBox(30, 40, 500, 700)
      page.setRotation(degrees(rot))
      const font = await doc.embedFont(StandardFonts.Helvetica)
      page.drawText('KEEP', { x: 200, y: 400, size: 12, font })
      page.drawText('OUTSIDE', { x: 60, y: 80, size: 12, font })
      const bytes = await doc.save()
      const meta = await metaFromBytes('s', 's.pdf', bytes)
      const before = (await viewItems(bytes, 0)).find((i) => i.str === 'KEEP')!
      const crop = { x: before.x - 40, y: before.y - 60, w: 160, h: 120 }
      const r = await buildPdf([{ ...makePage('s', 0), crop }], { s: meta }, () => bytes)
      const after = await viewItems(r.bytes, 0)
      const keep = after.find((i) => i.str === 'KEEP')!
      expect(keep.x, `rot ${rot}`).toBeCloseTo(before.x - crop.x, 1)
      expect(keep.y, `rot ${rot}`).toBeCloseTo(before.y - crop.y, 1)
      const out = await PDFDocument.load(r.bytes)
      const shown = out.getPage(0).getCropBox()
      expect(rot % 180 ? [shown.height, shown.width] : [shown.width, shown.height]).toEqual([expect.closeTo(160, 3), expect.closeTo(120, 3)])
      // as in Preview the rest is hidden, not deleted: say so
      expect(r.warnings.some((w) => w.includes('cropped page'))).toBe(true)
    }
  })
})

describe('pdfFileName', () => {
  it('adds the extension and drops characters file systems reject', () => {
    expect(pdfFileName('Report Q3')).toBe('Report Q3.pdf')
    expect(pdfFileName('a/b:c?.PDF')).toBe('abc.PDF')
    expect(pdfFileName('   ', 'x.pdf')).toBe('x.pdf')
    expect(pdfFileName('.pdf', 'x.pdf')).toBe('x.pdf')
  })
})
