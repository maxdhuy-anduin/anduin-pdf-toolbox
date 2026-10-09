import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { PDFDocument } from 'pdf-lib'
import { uid, type PageInfo, type Rotation, type SourceMeta } from './model'

const BASE = import.meta.env.BASE_URL
// Served from public/ (copied by scripts/copy-pdfjs-assets.mjs): a stable URL in dev and prod,
// independent of Vite's node_modules/dep-optimizer paths.
pdfjs.GlobalWorkerOptions.workerSrc = `${BASE}pdfjs/pdf.worker.min.mjs`
const DOC_OPTIONS = {
  standardFontDataUrl: `${BASE}pdfjs/standard_fonts/`,
  cMapUrl: `${BASE}pdfjs/cmaps/`,
  cMapPacked: true,
  wasmUrl: `${BASE}pdfjs/wasm/`,
  iccUrl: `${BASE}pdfjs/iccs/`,
  // keeps converted font files around so the content analyzer can read real font names
  fontExtraProperties: true,
  isEvalSupported: false, // privacy/safety: never eval document-supplied code
  enableScripting: false,
  verbosity: 0,
}

export type PdfErrorKind = 'password' | 'encrypted' | 'invalid' | 'too-large' | 'unknown'

export class PdfError extends Error {
  kind: PdfErrorKind
  constructor(kind: PdfErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export const MAX_FILE_BYTES = 300 * 1024 * 1024
export const LARGE_FILE_BYTES = 50 * 1024 * 1024

interface Registered {
  bytes: Uint8Array
  pdf: PDFDocumentProxy
  pages: Map<number, Promise<PDFPageProxy>>
}
const registry = new Map<string, Registered>()

export const getSourceBytes = (id: string): Uint8Array => {
  const r = registry.get(id)
  if (!r) throw new Error('Source document is no longer loaded.')
  return r.bytes
}

export const hasSource = (id: string) => registry.has(id)

export const getPageCount = (id: string): number => registry.get(id)?.pdf.numPages ?? 0

export function getPdfPage(sourceId: string, index: number): Promise<PDFPageProxy> {
  const r = registry.get(sourceId)
  if (!r) return Promise.reject(new Error('Source document is no longer loaded.'))
  let p = r.pages.get(index)
  if (!p) {
    p = r.pdf.getPage(index + 1)
    r.pages.set(index, p)
  }
  return p
}

const releaseHooks = new Set<(id: string) => void>()
/** Caches keyed by source register here so a closed document's data doesn't stay in memory. */
export function onSourceReleased(fn: (id: string) => void) {
  releaseHooks.add(fn)
}

export function releaseSource(id: string) {
  const r = registry.get(id)
  if (!r) return
  registry.delete(id)
  void r.pdf.loadingTask.destroy()
  releaseHooks.forEach((fn) => fn(id))
}

export function releaseAllSources() {
  for (const id of [...registry.keys()]) releaseSource(id)
}

function classify(err: unknown): PdfError {
  if (err instanceof PdfError) return err
  const e = err as { name?: string; message?: string }
  if (e?.name === 'PasswordException') {
    return new PdfError('password', 'This PDF is password-protected. Remove the password in the application that created it, then open it again.')
  }
  if (e?.name === 'EncryptedPDFError' || /encrypted/i.test(e?.message ?? '')) {
    return new PdfError('encrypted', 'This PDF is encrypted or has permission restrictions that this tool cannot process.')
  }
  if (e?.name === 'InvalidPDFException' || e?.name === 'MissingPDFException' || /invalid pdf|no pdf header|failed to parse|corrupt/i.test(e?.message ?? '')) {
    return new PdfError('invalid', 'This file does not look like a valid PDF, or it is corrupted.')
  }
  return new PdfError('unknown', `This PDF could not be opened (${e?.message ?? 'unknown error'}).`)
}

/** Detects image-only PDFs by sampling pages for text. */
async function looksScanned(pdf: PDFDocumentProxy): Promise<boolean> {
  const n = pdf.numPages
  const sample = n <= 6 ? Array.from({ length: n }, (_, i) => i + 1) : [1, 2, 3, Math.ceil(n / 2), n - 1, n]
  let chars = 0
  for (const num of sample) {
    const page = await pdf.getPage(num)
    const tc = await page.getTextContent()
    for (const it of tc.items) if ('str' in it) chars += it.str.trim().length
    if (chars > 20) return false
  }
  return chars <= 20
}

/** Opens a PDF from raw bytes and registers it. Throws PdfError with a user-presentable message. */
/** Geometry of a PDF.js page in the app's terms (see lib/coords.ts). */
export function pageInfoOf(page: PDFPageProxy): PageInfo {
  const vp = page.getViewport({ scale: 1 })
  return { view: page.view as PageInfo['view'], rotate: (((page.rotate % 360) + 360) % 360) as Rotation, width: vp.width, height: vp.height }
}

export async function openPdfBytes(name: string, input: Uint8Array): Promise<SourceMeta> {
  if (input.byteLength > MAX_FILE_BYTES) {
    throw new PdfError('too-large', `This file is ${(input.byteLength / 1048576).toFixed(0)} MB. Files above ${MAX_FILE_BYTES / 1048576} MB are not supported in the browser.`)
  }
  if (input.byteLength < 8) throw new PdfError('invalid', 'This file is empty or too small to be a PDF.')
  const bytes = input
  const id = uid('src')
  let pdf: PDFDocumentProxy | null = null
  try {
    // pdf.js takes ownership of (transfers) the buffer it is given, so hand it a copy.
    const task = pdfjs.getDocument({ data: bytes.slice(), ...DOC_OPTIONS })
    // pdf-lib is what builds the export: make sure it can read the file too (encryption, damage).
    const [viewed, editable] = await Promise.allSettled([
      task.promise,
      PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false }).then((d) => d.getPageCount()),
    ])
    // pdf.js's verdict wins: it can tell "needs a password" apart from "damaged".
    if (viewed.status === 'rejected') throw viewed.reason
    const loaded = viewed.value
    pdf = loaded
    if (editable.status === 'rejected') throw editable.reason
    const pages: PageInfo[] = []
    for (let i = 1; i <= pdf.numPages; i += 1) {
      const page = await pdf.getPage(i)
      pages.push(pageInfoOf(page))
      page.cleanup()
    }
    if (pdf.numPages < 1) throw new PdfError('invalid', 'This PDF has no pages.')
    const likelyScanned = await looksScanned(pdf)
    registry.set(id, { bytes, pdf, pages: new Map() })
    return { id, name, size: bytes.byteLength, numPages: pdf.numPages, pages, likelyScanned }
  } catch (err) {
    if (pdf) void pdf.loadingTask.destroy()
    throw classify(err)
  }
}

export async function openPdfFile(file: File): Promise<SourceMeta> {
  return openPdfBytes(file.name, new Uint8Array(await file.arrayBuffer()))
}

export { pdfjs }
