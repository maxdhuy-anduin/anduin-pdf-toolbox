// Export integrity on PDFs built to stress the content-stream editor: offset crop boxes with every
// /Rotate, content that leaves the transform modified, edits that cannot be removed exactly,
// fillable forms and duplicated pages with annotations. Every check reopens the exported bytes.
import { PDFDocument, PDFName, PDFRef, PDFString, StandardFonts, degrees } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { buildPdf } from './export'
import { makePage, makeTextOverlay, type MoveOverlay, type PageInfo, type PageModel, type SourceMeta, type SourceRef } from './model'
import { pageTexts, viewItems } from '../test/helpers'

/** Source metadata exactly as the app derives it (PDF.js view box = crop ∩ media, /Rotate applied). */
async function metaOf(id: string, bytes: Uint8Array): Promise<SourceMeta> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
  const doc = await task.promise
  const pages: PageInfo[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const p = await doc.getPage(i)
    const vp = p.getViewport({ scale: 1 })
    pages.push({ view: p.view as PageInfo['view'], rotate: p.rotate as PageInfo['rotate'], width: vp.width, height: vp.height })
  }
  await task.destroy()
  return { id, name: id, size: bytes.length, numPages: pages.length, pages, likelyScanned: false }
}

/** One Letter page whose content stream is exactly `content` (font /F1 = Helvetica). */
async function rawPage(content: string) {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.node.setFontDictionary(PDFName.of('F1'), font.ref)
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)))
  return doc.save()
}

const deleted = (source: SourceRef): MoveOverlay => ({ id: `del_${source.objectId}`, type: 'move', source, dx: 0, dy: 0, deleted: true, coverColor: '#ffffff' })
const block = (bounds: SourceRef['bounds']): SourceRef => ({ objectId: 'b1', objType: 'TEXT_BLOCK', bounds, ops: [], exclusive: true })

describe('export integrity', () => {
  it('places overlays and removes content correctly on an offset crop box at every rotation', async () => {
    for (const rot of [0, 90, 180, 270]) {
      const doc = await PDFDocument.create()
      const page = doc.addPage([612, 792])
      const font = await doc.embedFont(StandardFonts.Helvetica)
      page.drawText('RemoveMe', { x: 120, y: 300, size: 12, font })
      page.drawText('KeepMe', { x: 120, y: 250, size: 12, font })
      page.setCropBox(50, 100, 400, 500)
      if (rot) page.setRotation(degrees(rot))
      const raw = await doc.save()
      const meta = await metaOf('a', raw)
      const rm = (await viewItems(raw, 0)).find((i) => i.str === 'RemoveMe')!
      // canonical-space box around "RemoveMe" (baseline-left at rm.x, rm.y; runs along the page's x after rotation)
      const vertical = rot === 90 || rot === 270
      const bounds = vertical
        ? { x: rm.x - 14, y: rm.y - (rot === 90 ? 0 : 60), w: 16, h: 60 }
        : { x: rm.x - (rot === 180 ? 60 : 0) - 1, y: rm.y - (rot === 180 ? 0 : 12) - 1, w: 62, h: 15 }
      const pg: PageModel = { ...makePage('a', 0), overlays: [deleted(block(bounds)), makeTextOverlay(10, 20, { text: 'Marker', fontSize: 20 })] }
      const r = await buildPdf([pg], { a: meta }, () => raw)
      const items = await viewItems(r.bytes, 0)
      expect(r.stats, `rot ${rot}`).toEqual({ removed: 1, covered: 0 })
      expect(items.map((i) => i.str).sort(), `rot ${rot}`).toEqual(['KeepMe', 'Marker'])
      const m = items.find((i) => i.str === 'Marker')!
      expect(m.x, `rot ${rot}`).toBeCloseTo(10, 0)
      expect(m.y, `rot ${rot}`).toBeCloseTo(20 + 20 * 0.9465, 0)
    }
  })

  it('places overlays correctly when the original content leaves the transform modified', async () => {
    const raw = await rawPage('1 0 0 1 100 100 cm BT /F1 12 Tf 10 10 Td (Original) Tj ET')
    const pg: PageModel = { ...makePage('a', 0), overlays: [makeTextOverlay(72, 100, { text: 'Marker', fontSize: 20 })] }
    const r = await buildPdf([pg], { a: await metaOf('a', raw) }, () => raw)
    const m = (await viewItems(r.bytes, 0)).find((i) => i.str === 'Marker')!
    expect(m.x).toBeCloseTo(72, 0)
    expect(m.y).toBeCloseTo(100 + 20 * 0.9465, 0)
  })

  it('warns that a delete it could only cover is still in the file', async () => {
    // one text operator paints the sensitive value and the rest of the line: it can't be removed alone
    const raw = await rawPage('BT /F1 12 Tf 72 700 Td (Confidential 123-45-6789 rest of the line) Tj ET')
    const pg: PageModel = { ...makePage('a', 0), overlays: [deleted(block({ x: 71, y: 80, w: 150, h: 14 }))] }
    const r = await buildPdf([pg], { a: await metaOf('a', raw) }, () => raw)
    expect(r.stats).toEqual({ removed: 0, covered: 1 })
    expect((await pageTexts(r.bytes))[0]).toContain('123-45-6789') // the limitation itself
    expect(r.warnings).toEqual([expect.stringMatching(/could not be removed.*still in the file.*confidential/s)])
  })

  it('warns when fillable form fields and bookmarks of the original are not carried over', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    const tf = doc.getForm().createTextField('investor.name')
    tf.setText('Jane Example')
    tf.addToPage(page, { x: 72, y: 600, width: 200, height: 20 })
    doc.catalog.set(PDFName.of('Outlines'), doc.context.register(doc.context.obj({ Type: 'Outlines', Count: 0 })))
    const raw = await doc.save()
    const r = await buildPdf([makePage('a', 0)], { a: await metaOf('a', raw) }, () => raw)
    expect(r.warnings.some((w) => /fillable form fields/.test(w))).toBe(true)
    expect(r.warnings.some((w) => /Bookmarks/.test(w))).toBe(true)
    // the filled-in value stays visible (widget appearance)
    const task = pdfjs.getDocument({ data: r.bytes.slice(), verbosity: 0 })
    const annots = await (await (await task.promise).getPage(1)).getAnnotations()
    await task.destroy()
    expect(annots.some((a: { fieldValue?: string }) => a.fieldValue === 'Jane Example')).toBe(true)
  })

  it('keeps an edit on one copy of a duplicated page off the other, and gives each copy its own annotations', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([612, 792])
    page.drawText('Para one', { x: 72, y: 700, size: 12, font: await doc.embedFont(StandardFonts.Helvetica) })
    const link = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [72, 500, 200, 520], A: { S: 'URI', URI: PDFString.of('https://example.com') } })
    page.node.addAnnot(doc.context.register(link))
    const raw = await doc.save()
    const it0 = (await viewItems(raw, 0))[0]
    const edited: PageModel = { ...makePage('a', 0), overlays: [deleted(block({ x: it0.x - 1, y: it0.y - 12, w: 50, h: 15 }))] }
    const r = await buildPdf([makePage('a', 0), edited, makePage('a', 0)], { a: await metaOf('a', raw) }, () => raw)
    expect(await pageTexts(r.bytes)).toEqual(['Para one', '', 'Para one'])
    const out = await PDFDocument.load(r.bytes)
    const refs = out.getPages().map((p) => (p.node.Annots()!.get(0) as PDFRef).toString())
    expect(new Set(refs).size).toBe(3)
    out.getPages().forEach((p, i) => {
      const a = out.context.lookup(p.node.Annots()!.get(0)) as unknown as { get: (n: PDFName) => unknown }
      const P = a.get(PDFName.of('P'))
      if (i > 0) expect(P).toBe(p.ref) // clones point back at their own page
    })
  })
})
