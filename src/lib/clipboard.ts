// Structured clipboard for PDF objects. Copy / Paste is all the user sees.
//
// A copy keeps the selection (positions normalized to its top-left corner) plus, for every
// source page involved, a one-page PDF of that page, so the objects can be pasted into another
// document, even in another browser tab, and still be drawn by their original PDF operators.
//
// Transport: the payload stays in memory and is shared with the app's other open tabs through a
// BroadcastChannel (no localStorage / IndexedDB: copied document content is never written to
// disk). The system clipboard gets the plain text, so pasting into Word / Slack gives text, and
// a paste whose text no longer matches ours (the user copied something else) pastes that text.

import { PDFDocument } from 'pdf-lib'
import type { CopiedSelection } from './objects'
import type { PageInfo } from './model'
import { getSourceBytes } from './pdfjs'

export interface ClipPage {
  /** One-page PDF of the source page (unchanged, so operator indices still match). */
  bytes: Uint8Array
  info: PageInfo
  name: string
}

export interface ClipPayload {
  id: string
  /** Which tab copied it, and from which page (pasting there offsets the copy). */
  tab: string
  pageId: string
  sel: CopiedSelection
  /** Keyed by `${sourceId}|${srcIndex}` of the copying tab. */
  pages: Record<string, ClipPage>
}

export const TAB_ID = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random())
const CHANNEL = 'anduin-pdf-toolbox-clipboard'

let current: Promise<ClipPayload> | null = null
let currentId: string | null = null
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null

channel?.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as { type: 'clip'; payload: ClipPayload } | { type: 'want' }
  if (m?.type === 'clip' && m.payload?.id !== currentId) {
    current = Promise.resolve(m.payload)
    currentId = m.payload.id
  } else if (m?.type === 'want' && current) {
    current.then((payload) => channel.postMessage({ type: 'clip', payload })).catch(() => undefined)
  }
})
// a tab opened after the copy asks the others for it
channel?.postMessage({ type: 'want' })

const loaded = new Map<string, Promise<PDFDocument>>()
async function onePage(sourceId: string, srcIndex: number): Promise<Uint8Array> {
  let d = loaded.get(sourceId)
  if (!d) {
    d = PDFDocument.load(getSourceBytes(sourceId), { updateMetadata: false })
    loaded.set(sourceId, d)
    d.catch(() => loaded.delete(sourceId))
  }
  const out = await PDFDocument.create()
  const [p] = await out.copyPages(await d, [srcIndex])
  out.addPage(p)
  return out.save()
}

/** Forget cached parsed documents (call when sources are released). */
export function forgetClipboardSources() {
  loaded.clear()
}

/** Starts a copy. The PDF work runs in the background; paste waits for it if needed. */
export function setClipboard(sel: CopiedSelection, pageId: string, infos: (sourceId: string, srcIndex: number) => PageInfo, names: (sourceId: string) => string): string {
  const id = `${TAB_ID}:${Date.now()}`
  currentId = id
  current = (async () => {
    const pages: Record<string, ClipPage> = {}
    for (const g of sel.groups) {
      const k = `${g.sourceId}|${g.srcIndex}`
      if (!pages[k]) pages[k] = { bytes: await onePage(g.sourceId, g.srcIndex), info: infos(g.sourceId, g.srcIndex), name: names(g.sourceId) }
    }
    const payload: ClipPayload = { id, tab: TAB_ID, pageId, sel, pages }
    channel?.postMessage({ type: 'clip', payload })
    return payload
  })()
  current.catch(() => {
    if (currentId === id) {
      current = null
      currentId = null
    }
  })
  return id
}

export function getClipboard(): Promise<ClipPayload> | null {
  return current
}

/** Normalized text comparison between our payload and what the system clipboard holds. */
export const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()
