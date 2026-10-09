// Find & replace over everything a page shows as text: the PDF's own text (paragraphs and table
// cells from the analyzer, at their moved position if they were moved) and the app's text boxes.
// Pure functions: the UI lives in FindBar.tsx, highlights in SearchLayer.tsx / TextBox.tsx.
//
// Replacing text that belongs to the PDF works like editing it by hand: the paragraph (or cell)
// becomes an edited text box with the replacement, and the original is removed on export.

import { textOverlayFromObject } from './content/edits'
import type { Box, ContentObject, PageContent } from './content/types'
import { isMove, isText, type FontFamily, type Overlay, type OverlayPatch, type PageModel, type TextOverlay } from './model'

export interface SearchOptions {
  matchCase: boolean
  wholeWord: boolean
}

/** A searchable piece of text: a PDF paragraph / cell, or a text box. */
export interface Unit {
  key: string
  pageId: string
  pageIndex: number
  objectId?: string
  overlayId?: string
  text: string
  /** PDF text: a box per character (null for separators); text boxes are measured in the DOM. */
  rects?: (Box | null)[]
  /** Translation of a moved PDF object. */
  dx: number
  dy: number
}

export interface Hit {
  id: string
  pageId: string
  pageIndex: number
  unitKey: string
  overlayId?: string
  objectId?: string
  start: number
  end: number
  /** Highlight boxes (view space) for PDF text; empty for text boxes. */
  rects: Box[]
  /** The matched text as it appears. */
  text: string
}

// ---------------------------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------------------------

const FOLD: Record<string, string> = { '’': "'", '‘': "'", '‛': "'", '“': '"', '”': '"', '„': '"', ' ': ' ', '‐': '-', '‑': '-' }

/** Same-length normalization: typographic quotes / non-breaking spaces match their plain forms. */
function fold(s: string, matchCase: boolean): string {
  let out = ''
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    let f = FOLD[c] ?? c
    if (!matchCase) {
      const l = f.toLowerCase()
      if (l.length === f.length) f = l
    }
    out += f
  }
  return out
}

const WORD = /[\p{L}\p{N}_]/u
const isWord = (c: string | undefined) => !!c && WORD.test(c)

/** Start offsets of non-overlapping matches of `query` in `text`. */
export function findAll(text: string, query: string, opts: SearchOptions): number[] {
  if (!query) return []
  const t = fold(text, opts.matchCase)
  const q = fold(query, opts.matchCase)
  const out: number[] = []
  let i = t.indexOf(q)
  while (i >= 0) {
    const ok =
      !opts.wholeWord ||
      ((!isWord(q[0]) || !isWord(text[i - 1])) && (!isWord(q[q.length - 1]) || !isWord(text[i + q.length])))
    if (ok) {
      out.push(i)
      i = t.indexOf(q, i + q.length)
    } else i = t.indexOf(q, i + 1)
  }
  return out
}

/** Replacement that follows the case of what it replaces: UPPER, Title or lower. */
export function preserveCase(found: string, repl: string): string {
  const letters = found.replace(/[^\p{L}]/gu, '')
  if (!letters || !repl) return repl
  if (letters === letters.toUpperCase() && letters !== letters.toLowerCase() && letters.length > 1) return repl.toUpperCase()
  if (letters === letters.toLowerCase()) return repl.toLowerCase()
  const first = letters[0]
  const rest = letters.slice(1)
  if (first === first.toUpperCase() && rest === rest.toLowerCase()) return repl[0].toUpperCase() + repl.slice(1).toLowerCase()
  return repl
}

export function replaceRanges(text: string, ranges: { start: number; end: number }[], repl: string, keepCase: boolean): string {
  let out = text
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    const found = text.slice(r.start, r.end)
    out = out.slice(0, r.start) + (keepCase ? preserveCase(found, repl) : repl) + out.slice(r.end)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// what is searchable on a page
// ---------------------------------------------------------------------------------------------

type Measure = (s: string, family: FontFamily) => number
let measureText: Measure | null = null
function browserMeasure(): Measure | null {
  if (measureText) return measureText
  if (typeof document === 'undefined') return null
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return null
  const fonts: Partial<Record<FontFamily, string>> = { Times: 'serif', Cambria: 'serif', Georgia: 'serif', Garamond: 'serif', Courier: 'monospace' }
  measureText = (s, family) => {
    ctx.font = `100px ${fonts[family] ?? 'sans-serif'}`
    return ctx.measureText(s).width
  }
  return measureText
}

const rectCache = new WeakMap<ContentObject, Box[]>()

/** A box per character of a TEXT_LINE, from the x extents of the PDF items that drew it. */
export function lineCharRects(line: ContentObject): Box[] {
  let r = rectCache.get(line)
  if (!r) {
    r = computeLineCharRects(line)
    rectCache.set(line, r)
  }
  return r
}

function computeLineCharRects(line: ContentObject): Box[] {
  const text = line.text ?? ''
  const runs = line.textRuns ?? []
  const b = line.bounds
  const m = browserMeasure()
  const xs: [number, number][] = new Array(text.length)
  for (const r of runs) {
    const s = text.slice(r.s, r.e)
    const total = m ? m(s, r.family) : s.length
    let acc = 0
    for (let i = r.s; i < r.e; i += 1) {
      const w = m ? m(text[i], r.family) : 1
      const a = r.x0 + ((r.x1 - r.x0) * acc) / (total || 1)
      acc += w
      xs[i] = [a, r.x0 + ((r.x1 - r.x0) * acc) / (total || 1)]
    }
  }
  // characters no item drew (spaces inserted between items): fill the gap
  for (let i = 0; i < text.length; i += 1) {
    if (xs[i]) continue
    const prev = xs[i - 1]?.[1] ?? b.x
    let j = i + 1
    while (j < text.length && !xs[j]) j += 1
    const next = xs[j]?.[0] ?? b.x + b.w
    xs[i] = [prev, Math.max(prev, next)]
  }
  return xs.map(([a, c]) => ({ x: a, y: b.y, w: Math.max(0.5, c - a), h: b.h }))
}

/** Text of a paragraph / cell rebuilt from its lines, with a box per character. */
function unitRects(o: ContentObject, content: PageContent): (Box | null)[] | undefined {
  const lines = o.children.map((id) => content.objects[id]).filter((l) => l?.type === 'TEXT_LINE')
  if (!lines.length) return undefined
  let text = ''
  const rects: (Box | null)[] = []
  lines.forEach((l, k) => {
    if (k > 0) {
      if (o.hardBreaks?.[k - 1]) {
        text += '\n'
        rects.push(null)
      } else if (!/-$/.test(text)) {
        text += ' '
        rects.push(null)
      }
    }
    text += l.text ?? ''
    rects.push(...lineCharRects(l))
  })
  return text === o.text ? rects : undefined
}

function textObjectsInOrder(content: PageContent): ContentObject[] {
  const out: ContentObject[] = []
  const walk = (id: string) => {
    const o = content.objects[id]
    if (!o) return
    if (o.type === 'TEXT_BLOCK' || o.type === 'TABLE_CELL') {
      if (o.text?.trim()) out.push(o)
      return
    }
    o.children.forEach(walk)
  }
  content.roots.forEach(walk)
  return out
}

const unitCache = new WeakMap<PageModel, { pageIndex: number; content: PageContent | undefined; draft: TextOverlay | null | undefined; units: Unit[] }>()

/** Everything searchable on a page, in reading order (text boxes slotted in by position). Cached per page state. */
export function pageUnits(page: PageModel, pageIndex: number, content: PageContent | undefined, draft?: TextOverlay | null): Unit[] {
  const c = unitCache.get(page)
  if (c && c.pageIndex === pageIndex && c.content === content && c.draft === draft) return c.units
  const units = buildUnits(page, pageIndex, content, draft)
  unitCache.set(page, { pageIndex, content, draft, units })
  return units
}

function buildUnits(page: PageModel, pageIndex: number, content: PageContent | undefined, draft?: TextOverlay | null): Unit[] {
  const replaced = new Set<string>()
  const moves = new Map<string, { dx: number; dy: number; deleted: boolean }>()
  for (const o of page.overlays) {
    if (isMove(o)) moves.set(o.source.objectId, o)
    else if (o.source) replaced.add(o.source.objectId)
  }
  const units: Unit[] = []
  if (content) {
    for (const o of textObjectsInOrder(content)) {
      const mv = moves.get(o.id)
      if (replaced.has(o.id) || mv?.deleted) continue
      units.push({ key: `o:${o.id}`, pageId: page.id, pageIndex, objectId: o.id, text: o.text!, rects: unitRects(o, content), dx: mv?.dx ?? 0, dy: mv?.dy ?? 0 })
    }
  }
  const boxes = [...page.overlays.filter(isText), ...(draft && !page.overlays.some((o) => o.id === draft.id) ? [draft] : [])]
  const top = (u: Unit) => (u.rects?.find((r) => r)?.y ?? 0) + u.dy
  for (const t of boxes) {
    if (!t.text.trim()) continue
    const u: Unit = { key: `v:${t.id}`, pageId: page.id, pageIndex, overlayId: t.id, text: t.text, dx: 0, dy: 0 }
    const at = units.findIndex((x) => !x.overlayId && top(x) > t.y)
    if (at < 0) units.push(u)
    else units.splice(at, 0, u)
  }
  return units
}

/** Joins per-character boxes into one box per line of the match. */
function hitRects(u: Unit, start: number, end: number): Box[] {
  if (!u.rects) return []
  const out: Box[] = []
  for (let i = start; i < end; i += 1) {
    const r = u.rects[i]
    if (!r) continue
    const last = out[out.length - 1]
    if (last && Math.abs(last.y - (r.y + u.dy)) < 0.5) {
      const x1 = Math.max(last.x + last.w, r.x + u.dx + r.w)
      last.x = Math.min(last.x, r.x + u.dx)
      last.w = x1 - last.x
    } else out.push({ x: r.x + u.dx, y: r.y + u.dy, w: r.w, h: r.h })
  }
  return out
}

export function search(units: Unit[], query: string, opts: SearchOptions): Hit[] {
  const hits: Hit[] = []
  if (!query) return hits
  for (const u of units) {
    for (const start of findAll(u.text, query, opts)) {
      const end = start + query.length
      hits.push({
        id: `${u.key}@${start}`,
        pageId: u.pageId,
        pageIndex: u.pageIndex,
        unitKey: u.key,
        overlayId: u.overlayId,
        objectId: u.objectId,
        start,
        end,
        rects: hitRects(u, start, end),
        text: u.text.slice(start, end),
      })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------------------------
// replace
// ---------------------------------------------------------------------------------------------

export interface PageEdit {
  pageId: string
  add: Overlay[]
  update: { id: string; patch: OverlayPatch }[]
  remove: string[]
}

/**
 * Edits that replace `hits` with `repl`. PDF text becomes an edited text box (like editing it by
 * hand); text boxes just get new text. `canvasOf` gives a page's rendered canvas (colours).
 */
export function planReplace(
  pages: PageModel[],
  contentOf: (p: PageModel) => PageContent | undefined,
  hits: Hit[],
  repl: string,
  keepCase: boolean,
  canvasOf: (pageId: string) => HTMLCanvasElement | null,
): { edits: PageEdit[]; count: number } {
  const byUnit = new Map<string, Hit[]>()
  for (const h of hits) byUnit.set(`${h.pageId}|${h.unitKey}`, [...(byUnit.get(`${h.pageId}|${h.unitKey}`) ?? []), h])
  const edits = new Map<string, PageEdit>()
  const edit = (pageId: string) => {
    let e = edits.get(pageId)
    if (!e) {
      e = { pageId, add: [], update: [], remove: [] }
      edits.set(pageId, e)
    }
    return e
  }
  let count = 0
  for (const hs of byUnit.values()) {
    const page = pages.find((p) => p.id === hs[0].pageId)
    if (!page) continue
    if (hs[0].overlayId) {
      const t = page.overlays.find((o) => o.id === hs[0].overlayId)
      if (!t || !isText(t)) continue
      edit(page.id).update.push({ id: t.id, patch: { text: replaceRanges(t.text, hs, repl, keepCase) } })
      count += hs.length
      continue
    }
    const content = contentOf(page)
    const obj = content?.objects[hs[0].objectId ?? '']
    if (!content || !obj?.text) continue
    const ov = textOverlayFromObject(obj, content, canvasOf(page.id))
    ov.text = replaceRanges(obj.text, hs, repl, keepCase)
    const mv = page.overlays.find((x) => isMove(x) && x.source.objectId === obj.id)
    if (mv && isMove(mv)) {
      // a moved object is replaced where it now is
      // (the cover stays where the original is drawn once the move is undone)
      ov.x += mv.dx
      ov.y += mv.dy
      edit(page.id).remove.push(mv.id)
    }
    edit(page.id).add.push(ov)
    count += hs.length
  }
  return { edits: [...edits.values()], count }
}
