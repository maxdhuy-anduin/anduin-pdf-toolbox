// Synthetic demo documents (no real fund or confidential content). Generated with
// pdf-lib so the app ships no binary assets and the text is real, editable PDF text.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

const NAVY = rgb(0.118, 0.227, 0.373)
const GREY = rgb(0.4, 0.43, 0.48)
const INK = rgb(0.1, 0.12, 0.16)
const W = 612
const H = 792
const M = 64

interface Ctx {
  doc: PDFDocument
  sans: PDFFont
  sansBold: PDFFont
  serif: PDFFont
  serifBold: PDFFont
  serifItalic: PDFFont
}

async function makeCtx(title: string): Promise<Ctx> {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  doc.setProducer('Anduin PDF Toolbox (synthetic sample)')
  return {
    doc,
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansBold: await doc.embedFont(StandardFonts.HelveticaBold),
    serif: await doc.embedFont(StandardFonts.TimesRoman),
    serifBold: await doc.embedFont(StandardFonts.TimesRomanBold),
    serifItalic: await doc.embedFont(StandardFonts.TimesRomanItalic),
  }
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(next, size) > width && line) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

function header(c: Ctx, page: PDFPage, section: string, n: number, total: number, doc: string) {
  page.drawText(doc, { x: M, y: H - 40, size: 8.5, font: c.sans, color: GREY })
  page.drawText(section.toUpperCase(), { x: W - M - c.sans.widthOfTextAtSize(section.toUpperCase(), 8.5), y: H - 40, size: 8.5, font: c.sans, color: GREY })
  page.drawLine({ start: { x: M, y: H - 48 }, end: { x: W - M, y: H - 48 }, thickness: 0.6, color: rgb(0.8, 0.82, 0.86) })
  page.drawText('Synthetic sample document for demonstration only. Not an offer of securities.', { x: M, y: 34, size: 7.5, font: c.sans, color: GREY })
  const label = `Page ${n} of ${total}`
  page.drawText(label, { x: W - M - c.sans.widthOfTextAtSize(label, 8.5), y: 34, size: 8.5, font: c.sans, color: GREY })
}

function title(c: Ctx, page: PDFPage, text: string, y = H - 110) {
  page.drawText(text, { x: M, y, size: 22, font: c.serifBold, color: NAVY })
  page.drawLine({ start: { x: M, y: y - 10 }, end: { x: M + 60, y: y - 10 }, thickness: 2, color: NAVY })
  return y - 40
}

function paragraph(c: Ctx, page: PDFPage, text: string, y: number, opts: { size?: number; width?: number; x?: number; font?: PDFFont; color?: ReturnType<typeof rgb> } = {}) {
  const size = opts.size ?? 11
  const font = opts.font ?? c.serif
  const lines = wrap(text, font, size, opts.width ?? W - 2 * M)
  for (const l of lines) {
    page.drawText(l, { x: opts.x ?? M, y, size, font, color: opts.color ?? INK })
    y -= size * 1.45
  }
  return y - size * 0.7
}

function termsTable(c: Ctx, page: PDFPage, rows: [string, string][], y: number) {
  const x2 = M + 190
  for (const [k, v] of rows) {
    const lines = wrap(v, c.serif, 11, W - M - x2)
    const rowH = Math.max(1, lines.length) * 15.5 + 12
    page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.4, color: rgb(0.82, 0.84, 0.88) })
    page.drawText(k, { x: M, y: y - 6, size: 10, font: c.sansBold, color: NAVY })
    lines.forEach((l, i) => page.drawText(l, { x: x2, y: y - 6 - i * 15.5, size: 11, font: c.serif, color: INK }))
    y -= rowH
  }
  page.drawLine({ start: { x: M, y: y + 8 }, end: { x: W - M, y: y + 8 }, thickness: 0.4, color: rgb(0.82, 0.84, 0.88) })
  return y
}

export const SAMPLE_FUND_NAME = 'Sample - Meridian Growth Fund III (synthetic).pdf'
export const SAMPLE_SUPPLEMENT_NAME = 'Sample - Side Letter and Fee Schedule (synthetic).pdf'

/** 7-page synthetic fund offering summary. Page 4 is an "internal notes" page to delete in the demo. */
export async function createSampleFund(): Promise<Uint8Array> {
  const c = await makeCtx('Meridian Growth Fund III, L.P. — Offering Summary (synthetic)')
  const total = 7
  const docName = 'Meridian Growth Fund III, L.P.'
  const pages = Array.from({ length: total }, () => c.doc.addPage([W, H]))

  // 1 — cover
  {
    const p = pages[0]
    p.drawRectangle({ x: 0, y: H - 300, width: W, height: 300, color: NAVY })
    p.drawText('CONFIDENTIAL OFFERING SUMMARY', { x: M, y: H - 120, size: 10, font: c.sansBold, color: rgb(0.75, 0.82, 0.92) })
    p.drawText('Meridian Growth', { x: M, y: H - 175, size: 38, font: c.serifBold, color: rgb(1, 1, 1) })
    p.drawText('Fund III, L.P.', { x: M, y: H - 220, size: 38, font: c.serifBold, color: rgb(1, 1, 1) })
    p.drawText('A Delaware limited partnership', { x: M, y: H - 255, size: 13, font: c.serifItalic, color: rgb(0.85, 0.9, 0.96) })
    p.drawText('Private offering of limited partnership interests', { x: M, y: H - 350, size: 14, font: c.serif, color: INK })
    p.drawText('Prepared for: Prospective Limited Partners', { x: M, y: H - 375, size: 12, font: c.serif, color: GREY })
    p.drawText('October 2026', { x: M, y: H - 395, size: 12, font: c.serif, color: GREY })
    paragraph(c, p, 'This document is a synthetic sample created to demonstrate the Anduin PDF Toolbox. The fund, its terms, and every figure in it are fictional.', H - 470, { size: 10.5, font: c.serifItalic, color: GREY, width: 380 })
    p.drawText('Synthetic sample document for demonstration only. Not an offer of securities.', { x: M, y: 34, size: 7.5, font: c.sans, color: GREY })
  }

  // 2 — contents
  {
    const p = pages[1]
    header(c, p, 'Contents', 2, total, docName)
    let y = title(c, p, 'Contents')
    const toc: [string, number][] = [['Summary of Principal Terms', 3], ['Internal Drafting Notes', 4], ['Investment Strategy', 5], ['Risk Factors', 6], ['Subscription Instructions', 7]]
    for (const [name, pg] of toc) {
      p.drawText(name, { x: M, y, size: 13, font: c.serif, color: INK })
      const num = String(pg)
      p.drawText(num, { x: W - M - c.serif.widthOfTextAtSize(num, 13), y, size: 13, font: c.serif, color: INK })
      p.drawLine({ start: { x: M + c.serif.widthOfTextAtSize(name, 13) + 8, y: y + 3 }, end: { x: W - M - 24, y: y + 3 }, thickness: 0.5, color: rgb(0.75, 0.77, 0.8), dashArray: [1.5, 2.5] })
      y -= 30
    }
  }

  // 3 — terms
  {
    const p = pages[2]
    header(c, p, 'Summary of Principal Terms', 3, total, docName)
    let y = title(c, p, 'Summary of Principal Terms')
    y = paragraph(c, p, 'The following is a summary of certain terms of the Partnership. It is qualified in its entirety by the Limited Partnership Agreement.', y)
    termsTable(c, p, [
      ['Target Fund Size', '$500,000,000'],
      ['Minimum Commitment', '$1,000,000, subject to the discretion of the General Partner'],
      ['Management Fee', '2.0% per annum of committed capital during the investment period'],
      ['Carried Interest', '20% of net profits, subject to the preferred return'],
      ['Preferred Return', '8% per annum, compounded annually'],
      ['Investment Period', 'Five years from the Initial Closing Date'],
      ['Term', 'Ten years, subject to two one-year extensions'],
      ['General Partner', 'Meridian Growth GP III, LLC'],
    ], y - 6)
  }

  // 4 — internal notes (to delete)
  {
    const p = pages[3]
    header(c, p, 'Internal', 4, total, docName)
    p.drawRectangle({ x: M, y: H - 160, width: W - 2 * M, height: 46, color: rgb(0.99, 0.93, 0.9), borderColor: rgb(0.85, 0.35, 0.25), borderWidth: 1 })
    p.drawText('INTERNAL DRAFTING NOTES — REMOVE BEFORE DISTRIBUTION', { x: M + 14, y: H - 142, size: 12, font: c.sansBold, color: rgb(0.7, 0.2, 0.12) })
    let y = H - 200
    y = paragraph(c, p, 'Open items for the deal team before this document goes to investors:', y, { font: c.serifBold })
    for (const b of ['Confirm final management fee step-down with counsel.', 'Update target fund size once the anchor commitment is confirmed.', 'Replace placeholder contact details on the last page.', 'Legal to approve the risk factor language.']) {
      y = paragraph(c, p, `•  ${b}`, y, { x: M + 12, width: W - 2 * M - 12 })
    }
  }

  // 5 — strategy
  {
    const p = pages[4]
    header(c, p, 'Investment Strategy', 5, total, docName)
    let y = title(c, p, 'Investment Strategy')
    y = paragraph(c, p, 'The Partnership will invest primarily in growth-stage technology and business-services companies headquartered in North America and Western Europe, targeting equity investments of $20 million to $60 million.', y)
    y = paragraph(c, p, 'The General Partner seeks companies with recurring revenue, durable competitive advantages, and experienced management teams. Portfolio construction targets 12 to 16 investments, with no single investment exceeding 15% of aggregate commitments.', y)
    y = paragraph(c, p, 'Value creation is driven by operational partnership, disciplined capital allocation, and selective add-on acquisitions. The General Partner expects to hold investments for four to six years before pursuing an exit.', y)
    p.drawText('Target allocation', { x: M, y: y - 8, size: 12, font: c.sansBold, color: NAVY })
    const alloc: [string, number][] = [['Software & data', 0.42], ['Business services', 0.28], ['Healthcare technology', 0.18], ['Financial technology', 0.12]]
    let by = y - 34
    for (const [name, share] of alloc) {
      p.drawText(name, { x: M, y: by, size: 10.5, font: c.serif, color: INK })
      p.drawRectangle({ x: M + 150, y: by - 2, width: 300 * share * 2, height: 11, color: NAVY, opacity: 0.85 })
      p.drawText(`${Math.round(share * 100)}%`, { x: M + 150 + 300 * share * 2 + 8, y: by, size: 10.5, font: c.sans, color: INK })
      by -= 24
    }
  }

  // 6 — risk factors
  {
    const p = pages[5]
    header(c, p, 'Risk Factors', 6, total, docName)
    let y = title(c, p, 'Risk Factors')
    y = paragraph(c, p, 'An investment in the Partnership involves a high degree of risk. Prospective investors should consider, among others, the following.', y)
    const risks: [string, string][] = [
      ['Illiquidity.', 'Interests are not freely transferable and no public market exists. Investors should be prepared to bear the economic risk of the investment for the full term.'],
      ['Concentration.', 'The Partnership may hold a limited number of investments, so the performance of a single company may materially affect overall returns.'],
      ['Valuation.', 'Portfolio companies are privately held; valuations are estimates and may differ materially from realized proceeds.'],
      ['Capital calls.', 'Limited Partners that fail to fund a capital call may be subject to default remedies, including forfeiture of part of their interest.'],
    ]
    for (const [h, body] of risks) {
      p.drawText(h, { x: M, y, size: 11.5, font: c.serifBold, color: INK })
      y = paragraph(c, p, body, y - 16)
    }
  }

  // 7 — subscription
  {
    const p = pages[6]
    header(c, p, 'Subscription Instructions', 7, total, docName)
    let y = title(c, p, 'Subscription Instructions')
    y = paragraph(c, p, 'To subscribe, complete and return the subscription agreement together with the supporting investor documentation listed below.', y)
    for (const b of ['Completed and signed Subscription Agreement', 'Investor Questionnaire and accredited investor representations', 'Tax form (IRS Form W-9 or applicable W-8)', 'Anti-money-laundering and know-your-customer documentation']) {
      y = paragraph(c, p, `•  ${b}`, y, { x: M + 12, width: W - 2 * M - 12 })
    }
    y -= 10
    p.drawText('Investor relations', { x: M, y, size: 12, font: c.sansBold, color: NAVY })
    y -= 20
    p.drawText('Meridian Growth GP III, LLC', { x: M, y, size: 11, font: c.serif, color: INK })
    p.drawText('investor.relations@example.com', { x: M, y: y - 16, size: 11, font: c.serif, color: INK })
    p.drawText('+1 (555) 010-0199', { x: M, y: y - 32, size: 11, font: c.serif, color: INK })
  }

  return c.doc.save()
}

/** 3-page synthetic supplement, handy to demo "Insert PDF". */
export async function createSampleSupplement(): Promise<Uint8Array> {
  const c = await makeCtx('Side Letter and Fee Schedule (synthetic)')
  const total = 3
  const docName = 'Meridian Growth Fund III, L.P. — Supplement'
  const pages = Array.from({ length: total }, () => c.doc.addPage([W, H]))

  {
    const p = pages[0]
    header(c, p, 'Supplement', 1, total, docName)
    let y = title(c, p, 'Supplemental Disclosure')
    y = paragraph(c, p, 'This supplement amends and should be read together with the Offering Summary of Meridian Growth Fund III, L.P.', y)
    paragraph(c, p, 'In the event of any inconsistency between this supplement and the Offering Summary, this supplement controls with respect to the matters described herein.', y)
  }
  {
    const p = pages[1]
    header(c, p, 'Side Letter', 2, total, docName)
    let y = title(c, p, 'Form of Side Letter')
    y = paragraph(c, p, 'Subject to the terms of the Limited Partnership Agreement, the General Partner agrees to extend the following to qualifying Limited Partners:', y)
    for (const b of ['Most-favoured-nation election within 30 days of the Final Closing.', 'Reasonable access to quarterly portfolio reporting and annual audited statements.', 'Advisory committee observer rights for commitments of $25,000,000 or more.']) {
      y = paragraph(c, p, `•  ${b}`, y, { x: M + 12, width: W - 2 * M - 12 })
    }
  }
  {
    const p = pages[2]
    header(c, p, 'Fee Schedule', 3, total, docName)
    let y = title(c, p, 'Fee Schedule')
    termsTable(c, p, [
      ['Commitment $1M – $9.99M', 'Management fee of 2.0% per annum'],
      ['Commitment $10M – $24.99M', 'Management fee of 1.75% per annum'],
      ['Commitment $25M and above', 'Management fee of 1.5% per annum'],
    ], y - 6)
  }
  return c.doc.save()
}
