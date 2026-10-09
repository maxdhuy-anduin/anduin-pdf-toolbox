import { PDFDocument, degrees } from 'pdf-lib'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PageInfo, SourceMeta } from '../lib/model'

export async function metaFromBytes(id: string, name: string, bytes: Uint8Array): Promise<SourceMeta> {
  const doc = await PDFDocument.load(bytes)
  const pages: PageInfo[] = doc.getPages().map((p) => {
    const mb = p.getMediaBox()
    const rotate = (((p.getRotation().angle % 360) + 360) % 360) as PageInfo['rotate']
    const w = mb.width
    const h = mb.height
    const swap = rotate === 90 || rotate === 270
    return { view: [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height], rotate, width: swap ? h : w, height: swap ? w : h }
  })
  return { id, name, size: bytes.length, numPages: pages.length, pages, likelyScanned: false }
}

export async function blankPdf(sizes: [number, number][], rotate: number[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  sizes.forEach(([w, h], i) => {
    const p = doc.addPage([w, h])
    if (rotate[i]) p.setRotation(degrees(rotate[i]))
  })
  return doc.save()
}

export interface ViewItem { str: string; x: number; y: number; size: number }

/** Text items of one page with baseline-left positions in PDF.js "view space" (scale 1, y-down). */
export async function viewItems(bytes: Uint8Array, pageIndex: number): Promise<ViewItem[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 })
  const doc = await task.promise
  const page = await doc.getPage(pageIndex + 1)
  const vp = page.getViewport({ scale: 1 })
  const tc = await page.getTextContent()
  const out: ViewItem[] = []
  for (const it of tc.items as any[]) {
    if (!it.str?.trim()) continue
    const t = pdfjs.Util.transform(vp.transform, it.transform)
    out.push({ str: it.str, x: t[4], y: t[5], size: Math.hypot(t[0], t[1]) })
  }
  await task.destroy()
  return out
}

export async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 })
  const doc = await task.promise
  const out: string[] = []
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    out.push((tc.items as any[]).map((it) => it.str).join(' '))
  }
  await task.destroy()
  return out
}

/** One Letter page whose content stream is exactly `content` (font /F1 = Helvetica); `extra` can add resources. */
export async function rawPage(content: string, extra?: (doc: PDFDocument, page: ReturnType<PDFDocument['addPage']>) => void | Promise<void>) {
  const { PDFName, StandardFonts } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.node.setFontDictionary(PDFName.of('F1'), font.ref)
  if (extra) await extra(doc, page)
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)))
  return doc.save()
}

/** The app's analysis of page `n` (PDF.js extraction + analyzer), as the editor sees it. */
export async function analyzed(bytes: Uint8Array, n = 0) {
  const { extractPage } = await import('../lib/content/extract')
  const { analyzePage } = await import('../lib/content/analyze')
  const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, fontExtraProperties: true })
  const doc = await task.promise
  const page = await doc.getPage(n + 1)
  const content = analyzePage(await extractPage(page, pdfjs as never))
  await task.destroy()
  return content
}
