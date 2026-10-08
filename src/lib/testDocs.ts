// Synthetic layout test suite for the content analyzer: one scenario per page.
// Used by unit tests and by the in-app debug menu ("Load layout test suite").
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'

const W = 612
const H = 792
const M = 64
const INK = rgb(0.1, 0.1, 0.12)
const GREY = rgb(0.45, 0.45, 0.5)
const NAVY = rgb(0.09, 0.16, 0.31)

export const LAYOUT_SUITE_NAME = 'Layout test suite (synthetic).pdf'

export const SUITE_PAGES = [
  'Paragraphs',
  'Headings and paragraphs',
  'Two-column layout',
  'Table with full borders',
  'Table with horizontal rules',
  'Table without borders',
  'Mixed text, list and table',
  'Fonts, sizes, styles and colours',
  'Images, shapes and rules',
] as const

interface F {
  r: PDFFont
  b: PDFFont
  i: PDFFont
  bi: PDFFont
  s: PDFFont
  sb: PDFFont
  mono: PDFFont
}

const LOREM = [
  'The Partnership seeks to generate long-term capital appreciation by investing in growth-stage companies with recurring revenue, durable competitive advantages and experienced management teams.',
  'Investments will generally be made in the form of minority or control equity positions, with an expected holding period of four to six years. The General Partner may use moderate leverage at the portfolio company level where appropriate.',
  'Prospective investors should carefully consider the risks described in this memorandum, including illiquidity, concentration, valuation uncertainty and the possibility of losing all or part of their investment.',
]

function words(text: string, font: PDFFont, size: number, width: number): string[][] {
  const out: string[][] = []
  let line: string[] = []
  for (const w of text.split(' ')) {
    const next = [...line, w].join(' ')
    if (font.widthOfTextAtSize(next, size) > width && line.length) {
      out.push(line)
      line = [w]
    } else line.push(w)
  }
  if (line.length) out.push(line)
  return out
}

/** Draws a paragraph; justified paragraphs place every word separately (as many generators do). */
function para(page: PDFPage, text: string, x: number, y: number, width: number, font: PDFFont, size: number, opts: { justify?: boolean; leading?: number; color?: RGB } = {}) {
  const lead = opts.leading ?? size * 1.4
  const ls = words(text, font, size, width)
  ls.forEach((ws, k) => {
    const last = k === ls.length - 1
    if (opts.justify && !last && ws.length > 1) {
      const total = ws.reduce((s, w) => s + font.widthOfTextAtSize(w, size), 0)
      const gap = (width - total) / (ws.length - 1)
      let cx = x
      for (const w of ws) {
        page.drawText(w, { x: cx, y, size, font, color: opts.color ?? INK })
        cx += font.widthOfTextAtSize(w, size) + gap
      }
    } else page.drawText(ws.join(' '), { x, y, size, font, color: opts.color ?? INK })
    y -= lead
  })
  return y - lead * 0.6
}

function chrome(page: PDFPage, f: F, n: number, title: string) {
  page.drawText('Layout test suite', { x: M, y: H - 40, size: 8, font: f.s, color: GREY })
  page.drawText(title.toUpperCase(), { x: W - M - f.s.widthOfTextAtSize(title.toUpperCase(), 8), y: H - 40, size: 8, font: f.s, color: GREY })
  const pg = `Page ${n} of ${SUITE_PAGES.length}`
  page.drawText(pg, { x: W / 2 - f.s.widthOfTextAtSize(pg, 8) / 2, y: 30, size: 8, font: f.s, color: GREY })
}

function heading(page: PDFPage, f: F, text: string, y: number, size = 20) {
  page.drawText(text, { x: M, y, size, font: f.sb, color: NAVY })
  return y - size * 1.9
}

function table(page: PDFPage, f: F, rows: string[][], x: number, y: number, widths: number[], mode: 'grid' | 'rules' | 'none', opts: { rightAlign?: number[] } = {}) {
  const rowH = 22
  const total = widths.reduce((a, b) => a + b, 0)
  rows.forEach((r, ri) => {
    const top = y - ri * rowH
    if (mode !== 'none') page.drawLine({ start: { x, y: top }, end: { x: x + total, y: top }, thickness: ri === 1 && mode === 'rules' ? 1.2 : 0.6, color: rgb(0.55, 0.57, 0.62) })
    let cx = x
    r.forEach((cell, ci) => {
      const font = ri === 0 ? f.sb : f.s
      const size = 10
      const tw = font.widthOfTextAtSize(cell, size)
      const tx = opts.rightAlign?.includes(ci) ? cx + widths[ci] - 8 - tw : cx + 8
      page.drawText(cell, { x: tx, y: top - 15, size, font, color: INK })
      cx += widths[ci]
    })
  })
  const bottom = y - rows.length * rowH
  if (mode !== 'none') page.drawLine({ start: { x, y: bottom }, end: { x: x + total, y: bottom }, thickness: 0.6, color: rgb(0.55, 0.57, 0.62) })
  if (mode === 'grid') {
    let cx = x
    for (const w of [0, ...widths]) {
      cx += w
      page.drawLine({ start: { x: cx, y }, end: { x: cx, y: bottom }, thickness: 0.6, color: rgb(0.55, 0.57, 0.62) })
    }
  }
  return bottom - 24
}

// minimal greyscale PNG (no zlib dependency: stored/uncompressed deflate blocks)
function makePng(w: number, h: number, px: (x: number, y: number) => number): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff
    for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((c) => c.charCodeAt(0))
    const body = new Uint8Array([...t, ...data])
    return [...u32(data.length), ...body, ...u32(crc(body))]
  }
  const rawRows: number[] = []
  for (let y = 0; y < h; y += 1) {
    rawRows.push(0)
    for (let x = 0; x < w; x += 1) rawRows.push(px(x, y))
  }
  // zlib stream with stored blocks
  const z: number[] = [0x78, 0x01]
  for (let i = 0; i < rawRows.length; i += 65535) {
    const blk = rawRows.slice(i, i + 65535)
    const last = i + 65535 >= rawRows.length ? 1 : 0
    z.push(last, blk.length & 255, blk.length >> 8, ~blk.length & 255, (~blk.length >> 8) & 255, ...blk)
  }
  let a = 1, b = 0
  for (const v of rawRows) {
    a = (a + v) % 65521
    b = (b + a) % 65521
  }
  z.push(...u32(((b << 16) | a) >>> 0))
  return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [...u32(w), ...u32(h), 8, 0, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])])
}

export async function createLayoutSuite(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle('Layout test suite (synthetic)')
  const f: F = {
    r: await doc.embedFont(StandardFonts.TimesRoman),
    b: await doc.embedFont(StandardFonts.TimesRomanBold),
    i: await doc.embedFont(StandardFonts.TimesRomanItalic),
    bi: await doc.embedFont(StandardFonts.TimesRomanBoldItalic),
    s: await doc.embedFont(StandardFonts.Helvetica),
    sb: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
  }
  const pages = SUITE_PAGES.map(() => doc.addPage([W, H]))
  pages.forEach((p, i) => chrome(p, f, i + 1, SUITE_PAGES[i]))

  // 1. paragraphs (left-aligned and justified)
  {
    const p = pages[0]
    let y = H - 100
    y = para(p, LOREM[0], M, y, W - 2 * M, f.r, 11)
    y = para(p, LOREM[1], M, y, W - 2 * M, f.r, 11, { justify: true })
    y = para(p, LOREM[2], M, y, W - 2 * M, f.r, 11)
    para(p, 'A short closing paragraph on its own.', M, y, W - 2 * M, f.r, 11)
  }
  // 2. headings + paragraphs
  {
    const p = pages[1]
    let y = heading(p, f, 'Investment Strategy', H - 100, 22)
    y = para(p, LOREM[0], M, y, W - 2 * M, f.r, 11)
    p.drawText('Portfolio construction', { x: M, y, size: 14, font: f.sb, color: NAVY })
    y = para(p, LOREM[1], M, y - 22, W - 2 * M, f.r, 11)
    p.drawText('Risk management', { x: M, y, size: 14, font: f.sb, color: NAVY })
    para(p, LOREM[2], M, y - 22, W - 2 * M, f.r, 11)
  }
  // 3. two columns
  {
    const p = pages[2]
    const y0 = heading(p, f, 'Quarterly Letter to Limited Partners', H - 100, 18)
    const colW = (W - 2 * M - 24) / 2
    let y = para(p, LOREM[0] + ' ' + LOREM[1], M, y0, colW, f.r, 10.5, { justify: true })
    para(p, LOREM[2], M, y, colW, f.r, 10.5, { justify: true })
    y = para(p, LOREM[1] + ' ' + LOREM[2], M + colW + 24, y0, colW, f.r, 10.5, { justify: true })
    para(p, LOREM[0], M + colW + 24, y, colW, f.r, 10.5, { justify: true })
  }
  const rows = [
    ['Fund', 'Vintage', 'Commitment', 'Called'],
    ['Meridian Growth I', '2016', '$10,000,000', '98%'],
    ['Meridian Growth II', '2019', '$20,000,000', '87%'],
    ['Meridian Growth III', '2023', '$25,000,000', '41%'],
    ['Co-Invest Vehicle A', '2024', '$5,000,000', '12%'],
  ]
  const widths = [190, 80, 120, 94]
  // 4–6. tables
  {
    let y = heading(pages[3], f, 'Commitments by fund', H - 100, 18)
    y = para(pages[3], 'The table below summarises commitments as of the last quarter end.', M, y, W - 2 * M, f.r, 11)
    table(pages[3], f, rows, M, y, widths, 'grid', { rightAlign: [2, 3] })
  }
  {
    let y = heading(pages[4], f, 'Commitments by fund', H - 100, 18)
    y = para(pages[4], 'Same data with horizontal rules only, a common style in offering documents.', M, y, W - 2 * M, f.r, 11)
    table(pages[4], f, rows, M, y, widths, 'rules', { rightAlign: [2, 3] })
  }
  {
    let y = heading(pages[5], f, 'Commitments by fund', H - 100, 18)
    y = para(pages[5], 'Same data aligned with whitespace only, no ruling lines at all.', M, y, W - 2 * M, f.r, 11)
    y = table(pages[5], f, rows, M, y, widths, 'none', { rightAlign: [2, 3] })
    para(pages[5], 'Totals exclude recallable distributions. Figures are unaudited.', M, y, W - 2 * M, f.i, 10)
  }
  // 7. mixed
  {
    const p = pages[6]
    let y = heading(p, f, 'Subscription checklist', H - 100, 18)
    y = para(p, 'Please return the following documents together with your signed subscription agreement:', M, y, W - 2 * M, f.r, 11)
    for (const b of ['Completed investor questionnaire', 'IRS Form W-9 or the applicable Form W-8, signed and dated by an authorised signatory of the investor', 'Certified copies of formation documents and a list of authorised signatories']) {
      const ls = words(b, f.r, 11, W - 2 * M - 18)
      p.drawText('•', { x: M + 4, y, size: 11, font: f.r, color: INK })
      ls.forEach((w, k) => p.drawText(w.join(' '), { x: M + 18, y: y - k * 15, size: 11, font: f.r, color: INK }))
      y -= ls.length * 15 + 6
    }
    y -= 10
    p.drawText('Wire instructions', { x: M, y, size: 13, font: f.sb, color: NAVY })
    y = table(p, f, [['Field', 'Value'], ['Bank', 'Example National Bank'], ['ABA routing', '000000000'], ['Reference', 'Investor name + fund']], M, y - 14, [160, 324], 'rules')
    para(p, 'Contact investor relations with any questions about these instructions.', M, y, W - 2 * M, f.r, 11)
  }
  // 8. fonts and styles
  {
    const p = pages[7]
    let y = H - 100
    for (const [font, size, label, color] of [
      [f.sb, 26, 'Display heading 26pt', NAVY],
      [f.s, 16, 'Sans-serif subtitle 16pt', GREY],
      [f.b, 12, 'Serif bold 12pt', INK],
      [f.i, 12, 'Serif italic 12pt', INK],
      [f.bi, 12, 'Serif bold italic 12pt', INK],
      [f.mono, 10, 'Monospace 10pt: ACCT-0042-7781', INK],
      [f.s, 11, 'Coloured text in brand red', rgb(0.73, 0.11, 0.11)],
      [f.r, 8, 'Small print 8pt: past performance is not indicative of future results.', GREY],
    ] as [PDFFont, number, string, RGB][]) {
      p.drawText(label, { x: M, y, size, font, color })
      y -= size * 2.4
    }
    // mixed styles within one paragraph
    p.drawText('A line with', { x: M, y, size: 11, font: f.r, color: INK })
    let x = M + f.r.widthOfTextAtSize('A line with ', 11)
    p.drawText('bold', { x, y, size: 11, font: f.b, color: INK })
    x += f.b.widthOfTextAtSize('bold ', 11)
    p.drawText('and', { x, y, size: 11, font: f.r, color: INK })
    x += f.r.widthOfTextAtSize('and ', 11)
    p.drawText('italic', { x, y, size: 11, font: f.i, color: INK })
    x += f.i.widthOfTextAtSize('italic ', 11)
    p.drawText('words inside it.', { x, y, size: 11, font: f.r, color: INK })
    const t = 'Centred closing remark'
    p.drawText(t, { x: W / 2 - f.i.widthOfTextAtSize(t, 12) / 2, y: y - 50, size: 12, font: f.i, color: INK })
  }
  // 9. images, shapes, rules
  {
    const p = pages[8]
    let y = heading(p, f, 'Figures and shapes', H - 100, 18)
    const img = await doc.embedPng(makePng(120, 80, (x, yy) => Math.round(80 + 120 * (x / 120) * (1 - yy / 160))))
    p.drawImage(img, { x: M, y: y - 160, width: 240, height: 160 })
    p.drawText('Figure 1: Synthetic gradient image', { x: M, y: y - 176, size: 9, font: f.i, color: GREY })
    p.drawRectangle({ x: M + 280, y: y - 160, width: 204, height: 160, color: rgb(0.93, 0.95, 0.98), borderColor: NAVY, borderWidth: 1 })
    p.drawText('Callout box', { x: M + 296, y: y - 28, size: 12, font: f.sb, color: NAVY })
    para(p, 'Text inside a filled, bordered rectangle should be detected as its own block.', M + 296, y - 48, 172, f.s, 10)
    y -= 220
    p.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 2, color: NAVY })
    p.drawText('Below a thick navy rule', { x: M, y: y - 24, size: 11, font: f.r, color: INK })
    p.drawLine({ start: { x: M, y: y - 60 }, end: { x: W - M, y: y - 60 }, thickness: 0.5, color: rgb(0.7, 0.2, 0.2) })
    for (const [k, v] of [[0.62, 'Software'], [0.38, 'Services'], [0.21, 'Healthcare']] as [number, string][]) {
      y -= 30
      p.drawText(v, { x: M, y: y - 70, size: 10, font: f.s, color: INK })
      p.drawRectangle({ x: M + 100, y: y - 72, width: 300 * k, height: 12, color: NAVY })
    }
  }
  return doc.save()
}
