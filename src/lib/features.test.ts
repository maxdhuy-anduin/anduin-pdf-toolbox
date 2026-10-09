// Find & replace, superscripts / footnotes, strikethrough, shapes, arrows, smart guides, rulers'
// margins and embedded fonts: unit tests plus round trips through the real export.
import { readFileSync } from 'node:fs'
import { PDFDict, PDFDocument, PDFName, type PDFRawStream } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyzePage, classifyFont } from './content/analyze'
import { extractPage } from './content/extract'
import type { ContentObject, PageContent, RawPage } from './content/types'
import { buildPdf } from './export'
import { setFontLoader, unsupportedChars } from './fonts'
import { markerAt, planFootnote } from './footnotes'
import { detectMargins, formatLength } from './margins'
import { initialState, isText, type DocState, makeLineOverlay, makePage, makeShapeOverlay, makeTextOverlay, reducer, shapeBounds, type Overlay, type PageModel, type ShapeKind, type SourceMeta } from './model'
import { copySelection, pageItems, planDelete, planMove } from './objects'
import { fromSuper, maxFootnote, measureRuns, runs, toggleSuper, toSuper } from './richText'
import { findAll, pageUnits, planReplace, preserveCase, replaceRanges, search } from './search'
import { shapePath, SHAPE_LABELS } from './shapes'
import { snapBox } from './snap'
import { createSampleFund } from './samples'
import { blankPdf, metaFromBytes, pageTexts, viewItems } from '../test/helpers'

setFontLoader(async (file) => new Uint8Array(readFileSync(`public/fonts/${file}`)))

async function open(bytes: Uint8Array, index: number): Promise<{ content: PageContent; raw: RawPage }> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' })
  const doc = await task.promise
  const raw = await extractPage(await doc.getPage(index + 1), pdfjs as never)
  const content = analyzePage(raw)
  await task.destroy()
  return { content, raw }
}

let fund: Uint8Array
let fundMeta: SourceMeta
let blank: Uint8Array
let blankMeta: SourceMeta
let rotated: Uint8Array
let rotatedMeta: SourceMeta
beforeAll(async () => {
  fund = await createSampleFund()
  fundMeta = await metaFromBytes('fund', 'fund.pdf', fund)
  blank = await blankPdf([[612, 792]])
  blankMeta = await metaFromBytes('blank', 'blank.pdf', blank)
  rotated = await blankPdf([[612, 792]], [90])
  rotatedMeta = await metaFromBytes('rot', 'rot.pdf', rotated)
})
const sources = () => ({ fund: fundMeta, blank: blankMeta, rot: rotatedMeta })
const bytesOf = (id: string) => (id === 'fund' ? fund : id === 'rot' ? rotated : blank)
const exportOne = (sourceId: string, overlays: Overlay[], index = 0) => buildPdf([{ ...makePage(sourceId, index), overlays }], sources(), bytesOf)

// -----------------------------------------------------------------------------------------------
describe('superscripts', () => {
  it('round-trips digits, signs and ordinals', () => {
    expect(toSuper('12')).toBe('¹²')
    expect(toSuper('st')).toBe('ˢᵗ')
    expect(fromSuper('x¹⁰⁺')).toBe('x10+')
    expect(toggleSuper('²')).toBe('2')
    expect(toggleSuper('2')).toBe('²')
  })
  it('splits runs and measures superscripts smaller', () => {
    expect(runs('Fund¹² x')).toEqual([{ text: 'Fund', sup: false }, { text: '12', sup: true }, { text: ' x', sup: false }])
    expect(measureRuns('a¹', (s) => s.length * 10)).toBeCloseTo(10 + 10 * 0.65)
  })
  it('does not flag superscripts as unsupported by standard fonts; embedded fonts are not flagged at all', () => {
    expect(unsupportedChars('Note⁴⁵')).toEqual([])
    expect(unsupportedChars('Lê ✓')).toEqual(['✓'])
    expect(unsupportedChars('Lê ✓', 'Calibri')).toEqual([])
  })
  it('exports a superscript smaller and raised, as real (searchable) text', async () => {
    const t = makeTextOverlay(72, 100, { text: 'Capital¹', fontSize: 20 })
    const { bytes } = await exportOne('blank', [t])
    const items = await viewItems(bytes, 0)
    const word = items.find((i) => i.str.includes('Capital'))!
    const one = items.find((i) => i.str === '1')!
    expect(word.size).toBeCloseTo(20, 0)
    expect(one.size).toBeCloseTo(13, 0) // 0.65 × 20
    expect(word.y - one.y).toBeCloseTo(7, 0) // raised 0.35 × 20
    expect(one.x).toBeGreaterThan(word.x + 50)
  })
})

describe('strikethrough', () => {
  it('draws a rule through the middle of the text', async () => {
    const t = makeTextOverlay(72, 100, { text: 'Struck', fontSize: 20, strike: true })
    const { bytes } = await exportOne('blank', [t])
    const { raw } = await open(bytes, 0)
    const baseline = (await viewItems(bytes, 0))[0].y
    const rules = raw.paths.filter((p) => p.stroke && p.bbox.w > 40)
    expect(rules).toHaveLength(1)
    expect(baseline - rules[0].bbox.y).toBeCloseTo(0.27 * 20, 0)
  })
})

// -----------------------------------------------------------------------------------------------
describe('find', () => {
  const o = { matchCase: false, wholeWord: false }
  it('matches case-insensitively by default, exactly with match case', () => {
    expect(findAll('Fund fund FUND', 'fund', o)).toEqual([0, 5, 10])
    expect(findAll('Fund fund FUND', 'fund', { ...o, matchCase: true })).toEqual([5])
  })
  it('whole words only', () => {
    expect(findAll('fund funds refund fund.', 'fund', { ...o, wholeWord: true })).toEqual([0, 18])
    expect(findAll('fund funds refund', 'fund', o)).toEqual([0, 5, 13])
  })
  it('typographic quotes match plain ones', () => {
    expect(findAll('the investor’s share', "investor's", o)).toEqual([4])
  })
  it('preserves case when asked', () => {
    expect(preserveCase('FUND', 'trust')).toBe('TRUST')
    expect(preserveCase('Fund', 'trust')).toBe('Trust')
    expect(preserveCase('fund', 'Trust')).toBe('trust')
    expect(replaceRanges('Fund and fund', [{ start: 0, end: 4 }, { start: 9, end: 13 }], 'trust', true)).toBe('Trust and trust')
    expect(replaceRanges('Fund and fund', [{ start: 0, end: 4 }, { start: 9, end: 13 }], 'Trust', false)).toBe('Trust and Trust')
  })
})

describe('find & replace in a real PDF', () => {
  let content: PageContent
  let block: ContentObject
  let word: string
  beforeAll(async () => {
    content = (await open(fund, 2)).content
    block = Object.values(content.objects).find((x) => x.type === 'TEXT_BLOCK' && x.role === 'paragraph' && (x.text?.split(' ').length ?? 0) > 8)!
    word = block.text!.split(/\s+/).find((w) => /^[a-z]{6,}$/.test(w))!
  })

  it('finds a word inside a paragraph, highlighted inside the paragraph', () => {
    const page: PageModel = makePage('fund', 2)
    const units = pageUnits(page, 0, content)
    expect(units.find((u) => u.objectId === block.id)?.rects).toBeTruthy() // per-character boxes were rebuilt
    const hits = search(units, word, { matchCase: true, wholeWord: true }).filter((h) => h.objectId === block.id)
    expect(hits.length).toBeGreaterThan(0)
    for (const r of hits[0].rects) {
      expect(r.x).toBeGreaterThanOrEqual(block.bounds.x - 1)
      expect(r.x + r.w).toBeLessThanOrEqual(block.bounds.x + block.bounds.w + 1)
      expect(r.y).toBeGreaterThanOrEqual(block.bounds.y - 1)
      expect(r.y + r.h).toBeLessThanOrEqual(block.bounds.y + block.bounds.h + 1)
      expect(r.w).toBeGreaterThan(word.length * 2) // roughly a word wide, not the whole line
      expect(r.w).toBeLessThan(word.length * 12)
    }
  })

  it('a moved paragraph is found at its new place; a deleted one is not found', async () => {
    const { moveOverlayFor } = await import('./content/edits')
    const moved: PageModel = { ...makePage('fund', 2), overlays: [moveOverlayFor(block, { dx: 30, dy: 40 })] }
    const h1 = search(pageUnits(moved, 0, content), word, { matchCase: true, wholeWord: true }).find((h) => h.objectId === block.id)!
    const h0 = search(pageUnits(makePage('fund', 2), 0, content), word, { matchCase: true, wholeWord: true }).find((h) => h.objectId === block.id)!
    expect(h1.rects[0].x - h0.rects[0].x).toBeCloseTo(30)
    expect(h1.rects[0].y - h0.rects[0].y).toBeCloseTo(40)
    const deleted: PageModel = { ...makePage('fund', 2), overlays: [moveOverlayFor(block, { deleted: true })] }
    expect(search(pageUnits(deleted, 0, content), word, { matchCase: true, wholeWord: true }).some((h) => h.objectId === block.id)).toBe(false)
  })

  it('replace turns the paragraph into an edited text box and exports the new text', async () => {
    const page = makePage('fund', 2)
    const hits = search(pageUnits(page, 0, content), word, { matchCase: true, wholeWord: true }).filter((h) => h.objectId === block.id)
    const { edits, count } = planReplace([page], () => content, hits, 'ZEPHYRWORD', false, () => null)
    expect(count).toBe(hits.length)
    const t = edits[0].add[0]
    expect(isText(t) && t.source?.objectId).toBe(block.id)
    expect(isText(t) && t.text).toBe(block.text!.split(word).join('ZEPHYRWORD'))
    const { bytes } = await buildPdf([{ ...page, overlays: edits[0].add }], { fund: fundMeta }, () => fund)
    const text = (await pageTexts(bytes))[0]
    expect(text).toContain('ZEPHYRWORD')
  })

  it('replace in a text box edits its text; replace all is one undo step across pages', () => {
    const t1 = makeTextOverlay(10, 10, { text: 'Fund one fund' })
    const t2 = makeTextOverlay(10, 10, { text: 'another FUND' })
    const p1: PageModel = { ...makePage('blank', 0), overlays: [t1] }
    const p2: PageModel = { ...makePage('blank', 0), overlays: [t2] }
    const hits = search([...pageUnits(p1, 0, undefined), ...pageUnits(p2, 1, undefined)], 'fund', { matchCase: false, wholeWord: false })
    expect(hits).toHaveLength(3)
    const { edits } = planReplace([p1, p2], () => undefined, hits, 'trust', true, () => null)
    let s: DocState = { ...initialState, pages: [p1, p2], savedPages: [p1, p2] }
    s = reducer(s, { type: 'editMany', edits })
    expect((s.pages[0].overlays[0] as typeof t1).text).toBe('Trust one trust')
    expect((s.pages[1].overlays[0] as typeof t1).text).toBe('another TRUST')
    s = reducer(s, { type: 'undo' })
    expect((s.pages[0].overlays[0] as typeof t1).text).toBe('Fund one fund')
    expect((s.pages[1].overlays[0] as typeof t1).text).toBe('another FUND')
  })
})

// -----------------------------------------------------------------------------------------------
describe('shapes', () => {
  it('every shape has a path', () => {
    for (const k of Object.keys(SHAPE_LABELS) as ShapeKind[]) expect(shapePath(k, 100, 60)).toMatch(/^M/)
  })

  it('exports a rectangle at the same place as on screen (also on a page with /Rotate 90)', async () => {
    for (const src of ['blank', 'rot']) {
      const sh = makeShapeOverlay('rect', 100, 50, 80, 40, { stroke: '#c2412a', fill: '#e6f3fd', thickness: 2 })
      const { bytes } = await exportOne(src, [sh])
      const { raw } = await open(bytes, 0)
      const p = raw.paths.find((x) => x.fill || x.stroke)!
      expect(p, src).toBeTruthy()
      expect(p.stroke && p.fill).toBe(true)
      expect(p.bbox.x).toBeCloseTo(100, 0)
      expect(p.bbox.y).toBeCloseTo(50, 0)
      expect(p.bbox.w).toBeCloseTo(80, 0)
      expect(p.bbox.h).toBeCloseTo(40, 0)
    }
  })

  it('ellipse, star and check mark export as vector paths inside their box', async () => {
    const shapes = [makeShapeOverlay('ellipse', 50, 50, 100, 60), makeShapeOverlay('star', 200, 50, 80, 80, { fill: '#ffcc00' }), makeShapeOverlay('check', 320, 50, 40, 40, { thickness: 3 })]
    const { bytes, warnings } = await exportOne('blank', shapes)
    expect(warnings).toEqual([])
    const { raw } = await open(bytes, 0)
    expect(raw.paths).toHaveLength(3)
    shapes.forEach((s, i) => {
      const b = raw.paths[i].bbox
      expect(b.x).toBeGreaterThanOrEqual(s.x - 2)
      expect(b.y).toBeGreaterThanOrEqual(s.y - 2)
      expect(b.x + b.w).toBeLessThanOrEqual(s.x + s.w + 2)
      expect(b.y + b.h).toBeLessThanOrEqual(s.y + s.h + 2)
    })
    expect(raw.paths[1].fill).toBe(true)
    expect(raw.paths[2].fill).toBe(false) // a check mark is never filled
  })

  it('move, delete and copy like other objects', () => {
    const sh = makeShapeOverlay('ellipse', 100, 100, 50, 50)
    const page = { ...makePage('blank', 0), overlays: [sh] as Overlay[] }
    const items = pageItems(undefined, page.overlays)
    expect(items[0].bounds).toEqual(shapeBounds(sh))
    const mv = planMove(page, undefined, [`v:${sh.id}`], 10, 20)
    expect(mv.update).toEqual([{ id: sh.id, patch: { x: 110, y: 120 } }])
    expect(planDelete(page, undefined, [`v:${sh.id}`]).remove).toEqual([sh.id])
    const c = copySelection(page, undefined, items, [`v:${sh.id}`])!
    expect(c.shapes).toHaveLength(1)
    expect(c.shapes![0].x).toBeCloseTo(sh.thickness / 2)
  })
})

describe('arrows', () => {
  it('exports the shaft plus a filled arrowhead at the end', async () => {
    const l = { ...makeLineOverlay(100, 100, 300, 100, { thickness: 2 }), arrow: 'end' as const }
    const { bytes } = await exportOne('blank', [l])
    const { raw } = await open(bytes, 0)
    const head = raw.paths.find((p) => p.fill)!
    const shaft = raw.paths.find((p) => p.stroke && !p.fill)!
    expect(head.bbox.x + head.bbox.w).toBeCloseTo(300, 0) // tip at the end point
    expect(shaft.bbox.x).toBeCloseTo(100, 0)
    expect(shaft.bbox.x + shaft.bbox.w).toBeLessThan(300) // shortened under the head
  })
})

// -----------------------------------------------------------------------------------------------
describe('smart guides', () => {
  const page = { w: 600, h: 800 }
  it('aligns left edges and the page centre', () => {
    const r = snapBox({ x: 103, y: 300, w: 100, h: 20 }, [{ x: 100, y: 100, w: 200, h: 50 }], page, null, 5)
    expect(r.dx).toBeCloseTo(-3)
    expect(r.guides.some((g) => g.kind === 'align' && g.axis === 'x' && g.at === 100)).toBe(true)
    const c = snapBox({ x: 248, y: 500, w: 100, h: 20 }, [], page, null, 5)
    expect(c.dx).toBeCloseTo(2) // centred: 250..350
  })
  it('spaces evenly between two neighbours and continues a regular stack', () => {
    // two blocks 100 apart vertically; moving one in between snaps to equal gaps
    const others = [{ x: 100, y: 100, w: 300, h: 40 }, { x: 100, y: 260, w: 300, h: 40 }]
    const r = snapBox({ x: 100, y: 183, w: 300, h: 40 }, others, page, null, 5)
    expect(r.dy).toBeCloseTo(-3) // 140..180 gap 40 / 220..260 gap 40
    expect(r.guides.some((g) => g.kind === 'gap' && g.axis === 'y' && Math.abs(g.value - 40) < 0.01)).toBe(true)
    // same gap as the two above it
    // same gap as between the two above it (60): 340 + 60 = 400
    const stack = snapBox({ x: 100, y: 403, w: 300, h: 40 }, [{ x: 100, y: 200, w: 300, h: 40 }, { x: 100, y: 300, w: 300, h: 40 }], page, null, 5)
    expect(stack.dy).toBeCloseTo(-3)
    expect(stack.guides.some((g) => g.kind === 'gap' && Math.abs(g.value - 60) < 0.01 && g.segments.length === 2)).toBe(true)
  })
  it('does nothing beyond the threshold', () => {
    const r = snapBox({ x: 37, y: 333, w: 10, h: 10 }, [{ x: 100, y: 100, w: 10, h: 10 }], page, null, 5)
    expect([r.dx, r.dy]).toEqual([0, 0])
  })
})

// -----------------------------------------------------------------------------------------------
describe('margins', () => {
  it('detects body margins (ignoring running header / footer)', async () => {
    const { content } = await open(fund, 2)
    const m = detectMargins(content)!
    expect(m.left).toBeGreaterThan(30)
    expect(m.left).toBeLessThan(120)
    expect(m.right).toBeGreaterThan(30)
    expect(formatLength(72, 'in')).toBe('1.00 in')
    expect(formatLength(72, 'cm')).toBe('2.54 cm')
  })
})

describe('footnotes', () => {
  it('places the marker after a word on the baseline and the note at the bottom, stacking further notes', async () => {
    const { content } = await open(fund, 2)
    const page = makePage('fund', 2)
    const info = fundMeta.pages[2]
    const line = Object.values(content.objects).find((o) => o.type === 'TEXT_LINE' && (o.text?.length ?? 0) > 30)!
    const marker = markerAt(page, content, line.bounds.x + line.bounds.w + 2, line.bounds.y + line.bounds.h / 2, 1)
    expect(marker.text).toBe('¹')
    expect(marker.fontSize).toBeCloseTo(line.style!.fontSize, 1)
    expect(marker.x).toBeCloseTo(line.bounds.x + line.bounds.w + 0.3, 0) // snapped to the end of the line
    const { note, separator } = planFootnote(page, info, content, 1, { fontFamily: 'Times', fontSize: 11, color: '#000000' })
    expect(note.footnote).toBe(1)
    expect(note.text).toBe('¹ ')
    expect(note.fontSize).toBe(9)
    expect(note.y).toBeGreaterThan(info.height * 0.75)
    expect(note.y).toBeLessThan(info.height)
    expect(separator).toBeTruthy()
    const page2 = { ...page, overlays: [marker, separator!, note] as Overlay[] }
    expect(maxFootnote([page2])).toBe(1)
    const second = planFootnote(page2, info, content, 2, { fontFamily: 'Times', fontSize: 11, color: '#000000' })
    expect(second.separator).toBeNull()
    expect(second.note.y).toBeGreaterThan(note.y)
    // round trip: the note and the marker are text in the export
    const { bytes } = await buildPdf([{ ...page, overlays: [marker, separator!, { ...note, text: '¹ See the side letter.' }] }], { fund: fundMeta }, () => fund)
    expect((await pageTexts(bytes))[0]).toContain('See the side letter.')
  })
})

// -----------------------------------------------------------------------------------------------
describe('embedded fonts', () => {
  const fontNames = async (bytes: Uint8Array) => {
    const doc = await PDFDocument.load(bytes)
    const out: string[] = []
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && obj.get(PDFName.of('Type'))?.toString() === '/Font') out.push(String(obj.get(PDFName.of('BaseFont'))))
    }
    return out
  }

  it('embeds Calibri (Carlito), Cambria, Georgia, Garamond, Open Sans, Roboto, Lato with bold / italic', async () => {
    const fams = ['Calibri', 'Cambria', 'Georgia', 'Garamond', 'OpenSans', 'Roboto', 'Lato'] as const
    const overlays = fams.flatMap((f, i) => [
      makeTextOverlay(72, 60 + i * 40, { text: `${f} Lê Huy Tháng ½`, fontFamily: f }),
      makeTextOverlay(320, 60 + i * 40, { text: `${f} bold`, fontFamily: f, bold: true, italic: true }),
    ])
    const { bytes, warnings } = await exportOne('blank', overlays)
    expect(warnings).toEqual([]) // Vietnamese and ½ are in these fonts: nothing replaced by "?"
    const names = (await fontNames(bytes)).join(' ')
    for (const n of ['Carlito-Regular', 'Carlito-BoldItalic', 'Caladea-Regular', 'Gelasio-Regular', 'EBGaramond-Regular', 'OpenSans-Regular', 'Roboto-Regular', 'Lato-Regular', 'Lato-BoldItalic']) expect(names).toContain(n)
    const text = (await pageTexts(bytes))[0]
    expect(text).toContain('Calibri Lê Huy Tháng ½')
    expect(text).toContain('Lato bold')
  })

  it('Calibri text wraps exactly like Calibri (Carlito has the same widths)', async () => {
    const t = makeTextOverlay(72, 72, { text: 'The quick brown fox jumps over the lazy dog', fontFamily: 'Calibri', fontSize: 11, width: 120 })
    const { bytes } = await exportOne('blank', [t])
    const items = await viewItems(bytes, 0)
    expect(items.length).toBeGreaterThanOrEqual(2) // wrapped
    expect(items[0].str).toBe('The quick brown fox')
  })

  it('falls back to a standard font (with a warning) if a font file cannot be loaded', async () => {
    setFontLoader(async () => {
      throw new Error('offline')
    })
    try {
      const { bytes, warnings } = await exportOne('blank', [makeTextOverlay(72, 72, { text: 'Fallback text', fontFamily: 'Georgia' })])
      expect(warnings.join(' ')).toMatch(/closest standard PDF font/)
      expect((await pageTexts(bytes))[0]).toContain('Fallback text')
      expect((await fontNames(bytes)).join(' ')).toContain('Times-Roman')
    } finally {
      setFontLoader(async (file) => new Uint8Array(readFileSync(`public/fonts/${file}`)))
    }
  })

  it('every font file survives subsetting: each embedded glyph has the original outline', async () => {
    const fontkit = (await import('@pdf-lib/fontkit')).default
    const { readdirSync } = await import('node:fs')
    const { decodePDFRawStream } = await import('pdf-lib')
    const text = 'The quick brown fox, Lê Huy ½'
    for (const file of readdirSync('public/fonts').filter((f) => f.endsWith('.ttf'))) {
      const src = readFileSync(`public/fonts/${file}`)
      const doc = await PDFDocument.create()
      doc.registerFontkit(fontkit)
      const font = await doc.embedFont(src, { subset: true })
      doc.addPage([400, 100]).drawText(text, { x: 10, y: 50, size: 12, font })
      const out = await PDFDocument.load(await doc.save({ useObjectStreams: false }))
      let program: Uint8Array | null = null
      for (const [, obj] of out.context.enumerateIndirectObjects()) {
        if (obj instanceof PDFDict && obj.get(PDFName.of('FontFile2'))) program = decodePDFRawStream(out.context.lookup(obj.get(PDFName.of('FontFile2'))) as PDFRawStream).decode()
      }
      expect(program, file).toBeTruthy()
      const original = fontkit.create(src)
      const subset = fontkit.create(program as never)
      // subset glyph ids follow first use in the text (0 = .notdef)
      const seen: number[] = []
      for (const g of original.layout(text).glyphs) if (!seen.includes(g.id)) seen.push(g.id)
      seen.forEach((id, k) => {
        const a = original.getGlyph(id)
        const b = subset.getGlyph(k + 1)
        const cmds = (g: { path: unknown }) => (g.path as { commands: unknown[] }).commands.length
        expect(cmds(b), `${file} glyph ${k + 1}`).toBe(cmds(a))
        expect(Math.round(b.bbox.maxY - b.bbox.minY), `${file} glyph ${k + 1}`).toBe(Math.round(a.bbox.maxY - a.bbox.minY))
      })
    }
  }, 30000)

  it('PDF text in these fonts is recognised, so edits keep the font', () => {
    expect(classifyFont('ABCDEF+Calibri-Bold', 'sans-serif').family).toBe('Calibri')
    expect(classifyFont('Cambria', 'serif').family).toBe('Cambria')
    expect(classifyFont('Georgia-Italic', 'serif').family).toBe('Georgia')
    expect(classifyFont('EBGaramond-Regular', 'serif').family).toBe('Garamond')
    expect(classifyFont('TimesNewRomanPSMT', 'serif').family).toBe('Times')
    expect(classifyFont('ArialMT', 'sans-serif').family).toBe('Helvetica')
  })
})
