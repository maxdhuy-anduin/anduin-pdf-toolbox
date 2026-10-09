// Removing / transforming painted objects directly in a page's content stream (export time).
//
// The interpreter tracks the graphics state (CTM, q/Q), text state (Tm, Tf, Tc, Tw, Tz, TL, Ts)
// and path construction, and records a "mark" for each painting operator with its geometry in
// PDF user space. Edited objects (whose bounds come from the content analyzer) are matched to
// marks; matched operators are removed (text is replaced by an equivalent advance so following
// text on the same line does not shift) or, for images, wrapped in a new transform.
// Anything that cannot be matched safely is reported so the caller falls back to a cover.
import { Font, FontNames, Encodings } from '@pdf-lib/standard-fonts'
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream, type PDFPage, type PDFDocument } from 'pdf-lib'
import { parseContentStream, rebuildContentStream, serializeOperand, type Op, type Operand, type Replacements } from './contentStream'

const DEBUG_EDITS = typeof process !== 'undefined' && !!process.env?.DEBUG_EDITS
type M = [number, number, number, number, number, number]
const I: M = [1, 0, 0, 1, 0, 0]
/** m1 then m2 (row-vector convention used by PDF: p' = p × m1 × m2). */
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
]
const apply = (m: M, x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
const invert = (m: M): M => {
  const d = m[0] * m[3] - m[1] * m[2]
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d]
}

export interface UserRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface TextMark {
  kind: 'text'
  op: number
  a: { x: number; y: number }
  b: { x: number; y: number }
  /** Advance in unscaled text space (to re-emit as [-n] TJ). */
  advance: number
  fontSize: number
  hScale: number
  show: string
}
interface SubPath {
  first: number
  last: number
  bbox: UserRect
  points: { x: number; y: number }[]
}
interface PathMark {
  kind: 'path'
  start: number
  paint: number
  subpaths: SubPath[]
  clip: boolean
}
interface ImageMark {
  kind: 'image'
  op: number
  ctm: M
  bbox: UserRect
}
/** Painting that is never matched to an object (shadings, Form XObjects): only relevant to keepOnly. */
interface OtherMark {
  kind: 'other'
  op: number
}
type Mark = TextMark | PathMark | ImageMark | OtherMark

// ---------------------------------------------------------------------------
// font metrics (only needed to know where each text-show operator ends)
// ---------------------------------------------------------------------------

interface Metrics {
  twoByte: boolean
  width: (code: number) => number // glyph space units (1/1000 em)
}

const STD: Record<string, FontNames> = {
  Helvetica: FontNames.Helvetica, 'Helvetica-Bold': FontNames.HelveticaBold, 'Helvetica-Oblique': FontNames.HelveticaOblique, 'Helvetica-BoldOblique': FontNames.HelveticaBoldOblique,
  'Times-Roman': FontNames.TimesRoman, 'Times-Bold': FontNames.TimesRomanBold, 'Times-Italic': FontNames.TimesRomanItalic, 'Times-BoldItalic': FontNames.TimesRomanBoldItalic,
  Courier: FontNames.Courier, 'Courier-Bold': FontNames.CourierBold, 'Courier-Oblique': FontNames.CourierOblique, 'Courier-BoldOblique': FontNames.CourierBoldOblique,
  Symbol: FontNames.Symbol, ZapfDingbats: FontNames.ZapfDingbats,
}
let winAnsiNames: Map<number, string> | null = null
function glyphNameForCode(code: number) {
  if (!winAnsiNames) {
    winAnsiNames = new Map()
    const maps = (Encodings.WinAnsi as unknown as { unicodeMappings: Record<string, [number, string]> }).unicodeMappings
    for (const [c, nm] of Object.values(maps)) winAnsiNames.set(c, nm)
  }
  return winAnsiNames.get(code) ?? 'space'
}

function metricsFor(fontDict: PDFDict | undefined): Metrics {
  const fallback: Metrics = { twoByte: false, width: () => 500 }
  if (!fontDict) return fallback
  const subtype = fontDict.lookup(PDFName.of('Subtype'))?.toString()
  if (subtype === '/Type0') {
    const desc = fontDict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict)
    const dw = (desc?.lookup(PDFName.of('DW')) as PDFNumber | undefined)?.asNumber() ?? 1000
    const widths = new Map<number, number>()
    const w = desc?.lookup(PDFName.of('W'))
    if (w instanceof PDFArray) {
      // [first [w1 w2 …]] or [first last w]; stop at anything malformed (missing glyphs use DW)
      const n = (x: unknown) => (x instanceof PDFNumber ? x.asNumber() : null)
      for (let k = 0; k < w.size(); ) {
        const first = n(w.lookup(k))
        const next = w.lookup(k + 1)
        if (first === null) break
        if (next instanceof PDFArray) {
          for (let j = 0; j < next.size(); j += 1) {
            const v = n(next.lookup(j))
            if (v !== null) widths.set(first + j, v)
          }
          k += 2
        } else {
          const last = n(next)
          const val = k + 2 < w.size() ? n(w.lookup(k + 2)) : null
          if (last === null || val === null) break
          for (let c = first; c <= last && c - first < 65536; c += 1) widths.set(c, val)
          k += 3
        }
      }
    }
    return { twoByte: true, width: (c) => widths.get(c) ?? dw }
  }
  const widthsArr = fontDict.lookup(PDFName.of('Widths'))
  const firstChar = (fontDict.lookup(PDFName.of('FirstChar')) as PDFNumber | undefined)?.asNumber() ?? 0
  const missing = (fontDict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)?.lookup(PDFName.of('MissingWidth')) as PDFNumber | undefined)?.asNumber()
  const matrix = fontDict.lookup(PDFName.of('FontMatrix'))
  const scale = matrix instanceof PDFArray ? (matrix.lookup(0) as PDFNumber).asNumber() * 1000 : 1 // Type3
  if (widthsArr instanceof PDFArray) {
    const ws = Array.from({ length: widthsArr.size() }, (_, k) => {
      const x = widthsArr.lookup(k)
      return x instanceof PDFNumber ? x.asNumber() : 0
    })
    return { twoByte: false, width: (c) => (ws[c - firstChar] ?? missing ?? 500) * scale }
  }
  const base = fontDict.lookup(PDFName.of('BaseFont'))?.toString().replace(/^\//, '').replace(/^[A-Z]{6}\+/, '') ?? ''
  const std = STD[base] ?? (/arial|helvet/i.test(base) ? (/bold/i.test(base) ? FontNames.HelveticaBold : FontNames.Helvetica) : /times/i.test(base) ? FontNames.TimesRoman : /courier/i.test(base) ? FontNames.Courier : null)
  if (std) {
    const f = Font.load(std)
    return { twoByte: false, width: (c) => (f.getWidthOfGlyph(glyphNameForCode(c)) as number) ?? 500 }
  }
  return { twoByte: false, width: () => missing ?? 500 }
}

// ---------------------------------------------------------------------------
// interpreter
// ---------------------------------------------------------------------------

function interpret(ops: Op[], resources: PDFDict | undefined): Mark[] {
  const marks: Mark[] = []
  const fonts = resources?.lookupMaybe(PDFName.of('Font'), PDFDict)
  const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  const metricsCache = new Map<string, Metrics>()
  const metrics = (name: string) => {
    let m = metricsCache.get(name)
    if (!m) {
      try {
        m = metricsFor(fonts?.lookupMaybe(PDFName.of(name), PDFDict))
      } catch {
        m = { twoByte: false, width: () => 500 } // damaged font dictionary: approximate widths
      }
      metricsCache.set(name, m)
    }
    return m
  }
  interface GS {
    ctm: M
    font: string
    size: number
    tc: number
    tw: number
    th: number
    tl: number
    ts: number
  }
  let gs: GS = { ctm: I, font: '', size: 0, tc: 0, tw: 0, th: 1, tl: 0, ts: 0 }
  const stack: GS[] = []
  let tm: M = I
  let tlm: M = I
  let path: { start: number; subs: SubPath[]; cur: SubPath | null; clip: boolean } | null = null
  const num = (o: Operand | undefined) => (o?.t === 'num' ? o.v : 0)

  const addPoint = (opIdx: number, x: number, y: number, newSub = false) => {
    if (!path) path = { start: opIdx, subs: [], cur: null, clip: false }
    const p = apply(gs.ctm, x, y)
    if (newSub || !path.cur) {
      path.cur = { first: opIdx, last: opIdx, bbox: { x0: p.x, y0: p.y, x1: p.x, y1: p.y }, points: [] }
      path.subs.push(path.cur)
    }
    const s = path.cur
    s.last = opIdx
    s.points.push(p)
    s.bbox = { x0: Math.min(s.bbox.x0, p.x), y0: Math.min(s.bbox.y0, p.y), x1: Math.max(s.bbox.x1, p.x), y1: Math.max(s.bbox.y1, p.y) }
  }

  const show = (opIdx: number, items: Operand[]) => {
    const m = metrics(gs.font)
    let adv = 0
    let text = ''
    for (const it of items) {
      if (it.t === 'num') {
        adv += (-it.v / 1000) * gs.size * gs.th
        continue
      }
      if (it.t !== 'str') continue
      const bytes = it.bytes
      for (let k = 0; k < bytes.length; k += m.twoByte ? 2 : 1) {
        const code = m.twoByte ? (bytes[k] << 8) | (bytes[k + 1] ?? 0) : bytes[k]
        const space = !m.twoByte && code === 32 ? gs.tw : 0
        adv += ((m.width(code) / 1000) * gs.size + gs.tc + space) * gs.th
        text += String.fromCharCode(code)
      }
    }
    const trm = mul(tm, gs.ctm)
    const a = apply(trm, 0, gs.ts)
    const b = apply(trm, adv, gs.ts)
    marks.push({ kind: 'text', op: opIdx, a, b, advance: adv, fontSize: gs.size, hScale: gs.th, show: text })
    tm = mul([1, 0, 0, 1, adv, 0], tm)
  }

  ops.forEach((o, idx) => {
    const a = o.args
    switch (o.op) {
      case 'q':
        stack.push({ ...gs })
        break
      case 'Q':
        if (stack.length) gs = stack.pop()!
        break
      case 'cm':
        gs.ctm = mul([num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])], gs.ctm)
        break
      case 'BT':
        tm = I
        tlm = I
        break
      case 'Tf':
        gs.font = a[0]?.t === 'name' ? a[0].v : ''
        gs.size = num(a[1])
        break
      case 'Tc':
        gs.tc = num(a[0])
        break
      case 'Tw':
        gs.tw = num(a[0])
        break
      case 'Tz':
        gs.th = num(a[0]) / 100
        break
      case 'TL':
        gs.tl = num(a[0])
        break
      case 'Ts':
        gs.ts = num(a[0])
        break
      case 'Td':
        tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], tlm)
        tm = tlm
        break
      case 'TD':
        gs.tl = -num(a[1])
        tlm = mul([1, 0, 0, 1, num(a[0]), num(a[1])], tlm)
        tm = tlm
        break
      case 'Tm':
        tlm = [num(a[0]), num(a[1]), num(a[2]), num(a[3]), num(a[4]), num(a[5])]
        tm = tlm
        break
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm)
        tm = tlm
        break
      case 'Tj':
        show(idx, a.slice(0, 1))
        break
      case 'TJ':
        show(idx, a[0]?.t === 'arr' ? a[0].v : [])
        break
      case "'":
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm)
        tm = tlm
        show(idx, a.slice(0, 1))
        break
      case '"':
        gs.tw = num(a[0])
        gs.tc = num(a[1])
        tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm)
        tm = tlm
        show(idx, a.slice(2, 3))
        break
      case 'm':
        addPoint(idx, num(a[0]), num(a[1]), true)
        break
      case 'l':
        addPoint(idx, num(a[0]), num(a[1]))
        break
      case 'c':
        addPoint(idx, num(a[4]), num(a[5]))
        break
      case 'v':
      case 'y':
        addPoint(idx, num(a[2]), num(a[3]))
        break
      case 're': {
        const [x, y, w, h] = [num(a[0]), num(a[1]), num(a[2]), num(a[3])]
        addPoint(idx, x, y, true)
        addPoint(idx, x + w, y)
        addPoint(idx, x + w, y + h)
        addPoint(idx, x, y + h)
        if (path) path.cur = null
        break
      }
      case 'h':
        if (path?.cur) path.cur.last = idx
        break
      case 'W':
      case 'W*':
        if (path) path.clip = true
        break
      case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n':
        if (path) {
          if (o.op !== 'n') marks.push({ kind: 'path', start: path.start, paint: idx, subpaths: path.subs, clip: path.clip })
          path = null
        }
        break
      case 'Do': {
        const nm = a[0]?.t === 'name' ? a[0].v : ''
        const xo = xobjects?.lookup(PDFName.of(nm))
        const sub = xo instanceof PDFStream ? xo.dict.lookup(PDFName.of('Subtype'))?.toString() : undefined
        if (sub === '/Image') marks.push({ kind: 'image', op: idx, ctm: gs.ctm, bbox: unitBox(gs.ctm) })
        else marks.push({ kind: 'other', op: idx })
        break
      }
      case 'sh':
        marks.push({ kind: 'other', op: idx })
        break
      case 'BI':
        marks.push({ kind: 'image', op: idx, ctm: gs.ctm, bbox: unitBox(gs.ctm) })
        break
      default:
        break
    }
  })
  return marks
}

function unitBox(m: M): UserRect {
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)]
  return { x0: Math.min(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), x1: Math.max(...pts.map((p) => p.x)), y1: Math.max(...pts.map((p) => p.y)) }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export type EditTarget =
  /** `exclude`: other objects' text inside `rect`, left untouched. */
  | { id: string; kind: 'text'; rect: UserRect; exclude?: UserRect[] }
  | { id: string; kind: 'line'; rect: UserRect; ends: [{ x: number; y: number }, { x: number; y: number }]; thickness: number }
  | { id: string; kind: 'rect'; rect: UserRect }
  | { id: string; kind: 'image'; rect: UserRect; moveTo?: UserRect }
  /** Every vector path drawn entirely inside `rect` (a table's rules, borders and cell fills). */
  | { id: string; kind: 'paths'; rect: UserRect }

export interface EditResult {
  /** Target ids whose original content was removed (or transformed) in the content stream. */
  done: Set<string>
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const sameRect = (a: UserRect, b: UserRect, tol: number) => near(a.x0, b.x0, tol) && near(a.y0, b.y0, tol) && near(a.x1, b.x1, tol) && near(a.y1, b.y1, tol)
const inside = (p: { x: number; y: number }, r: UserRect, tol: number, tolX = tol) => p.x >= r.x0 - tolX && p.x <= r.x1 + tolX && p.y >= r.y0 - tol && p.y <= r.y1 + tol
const rectInside = (a: UserRect, r: UserRect, tol: number) => a.x0 >= r.x0 - tol && a.y0 >= r.y0 - tol && a.x1 <= r.x1 + tol && a.y1 <= r.y1 + tol

function contentBytes(page: PDFPage): Uint8Array | null {
  const contents = page.node.Contents()
  if (!contents) return null
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => page.doc.context.lookup(r)) : [contents]
  const chunks: Uint8Array[] = []
  for (const s of streams) {
    if (s instanceof PDFRawStream) chunks.push(decodePDFRawStream(s).decode())
    else if (s instanceof PDFStream) chunks.push(s.getContents())
    else return null
  }
  const total = chunks.reduce((n, c) => n + c.length + 1, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
    out[o++] = 10
  }
  return out
}

interface Match {
  texts: TextMark[]
  subs: { mark: PathMark; sub: SubPath }[]
  image?: ImageMark
}

/** Finds the painted marks of one target, or null when that can't be done safely. */
function matchTarget(t: EditTarget, marks: Mark[], claimedMarks: Set<Mark>, claimedSubs: Set<SubPath>): Match | null {
  if (t.kind === 'text') {
    const tol = 2
    const hits: TextMark[] = []
    for (const m of marks) {
      if (m.kind !== 'text' || !m.show.trim()) continue
      if (t.exclude?.some((r) => inside(m.a, r, 1) && inside(m.b, r, 1))) continue // not this object's text
      const ia = inside(m.a, t.rect, tol)
      // our width estimate may be a few % off: allow that horizontally, never vertically
      const ib = inside(m.b, t.rect, tol, Math.max(tol, Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) * 0.04))
      if (ia && ib) hits.push(m)
      else if (ia || ib || segmentCrosses(m.a, m.b, t.rect)) {
        if (DEBUG_EDITS) console.log('partial', JSON.stringify({ show: m.show, a: m.a, b: m.b, rect: t.rect, ia, ib }))
        return null // a text operator shared with content outside the object
      }
    }
    if (!hits.length || hits.some((h) => claimedMarks.has(h))) return null
    hits.forEach((h) => claimedMarks.add(h))
    return { texts: hits, subs: [] }
  }
  if (t.kind === 'line' || t.kind === 'rect') {
    for (const m of marks) {
      if (m.kind !== 'path' || m.clip) continue
      for (const sub of m.subpaths) {
        if (claimedSubs.has(sub)) continue
        const pts = sub.points
        const ok =
          t.kind === 'line'
            ? pts.length >= 2 &&
              ((near(pts[0].x, t.ends[0].x, 1.5) && near(pts[0].y, t.ends[0].y, 1.5) && near(pts[pts.length - 1].x, t.ends[1].x, 1.5) && near(pts[pts.length - 1].y, t.ends[1].y, 1.5)) ||
                (near(pts[0].x, t.ends[1].x, 1.5) && near(pts[0].y, t.ends[1].y, 1.5) && near(pts[pts.length - 1].x, t.ends[0].x, 1.5) && near(pts[pts.length - 1].y, t.ends[0].y, 1.5)) ||
                sameRect(sub.bbox, t.rect, Math.max(1.2, t.thickness)))
            : sameRect(sub.bbox, t.rect, 1.5)
        if (ok) {
          claimedSubs.add(sub)
          return { texts: [], subs: [{ mark: m, sub }] }
        }
      }
    }
    return null
  }
  if (t.kind === 'paths') {
    const subs: Match['subs'] = []
    for (const m of marks) {
      if (m.kind !== 'path' || m.clip) continue
      for (const sub of m.subpaths) if (!claimedSubs.has(sub) && rectInside(sub.bbox, t.rect, 2)) subs.push({ mark: m, sub })
    }
    subs.forEach((x) => claimedSubs.add(x.sub))
    return { texts: [], subs }
  }
  const m = marks.find((x): x is ImageMark => x.kind === 'image' && !claimedMarks.has(x) && sameRect(x.bbox, t.rect, 1.5))
  if (!m) return null
  claimedMarks.add(m)
  return { texts: [], subs: [], image: m }
}

/** Replacement for a text-show operator that paints nothing but keeps the text position. */
function blankText(ops: Op[], h: TextMark): string | null {
  const op = ops[h.op]
  const scale = h.fontSize * h.hScale
  const kern = scale ? `[${fmtNum((-h.advance * 1000) / scale)}] TJ` : ''
  if (op.op === "'") return `T* ${kern}`
  if (op.op === '"') return `${serializeOperand(op.args[0])} Tw ${serializeOperand(op.args[1])} Tc T* ${kern}`
  return kern || null
}

/** Removes whole paths, or single sub-paths of a path that also draws other things. */
function removeSubpaths(ops: Op[], repl: Replacements, marks: Mark[], drop: Set<SubPath>) {
  void ops
  for (const m of marks) {
    if (m.kind !== 'path') continue
    const gone = m.subpaths.filter((s) => drop.has(s))
    if (!gone.length) continue
    if (gone.length === m.subpaths.length) for (let k = m.start; k <= m.paint; k += 1) repl.set(k, null)
    else for (const s of gone) for (let k = s.first; k <= s.last; k += 1) repl.set(k, null)
  }
}

function writeContent(doc: PDFDocument, page: PDFPage, src: Uint8Array, ops: Op[], repl: Replacements) {
  const rebuilt = rebuildContentStream(src, ops, repl)
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(rebuilt)) as PDFRef)
}

function parsePage(page: PDFPage) {
  let src: Uint8Array | null = null
  try {
    src = contentBytes(page)
  } catch {
    return null
  }
  if (!src) return null
  const ops = parseContentStream(src)
  return { src, ops, marks: interpret(ops, page.node.Resources()) }
}

/**
 * Removes (or, for images, moves) the content painting each target. Must be called before
 * anything else is drawn on the page. Targets that cannot be handled safely are left alone.
 */
export function editPageContent(doc: PDFDocument, page: PDFPage, targets: EditTarget[]): EditResult {
  const done = new Set<string>()
  if (!targets.length) return { done }
  const parsed = parsePage(page)
  if (!parsed) return { done }
  const { src, ops, marks } = parsed
  const repl: Replacements = new Map()
  const claimedMarks = new Set<Mark>()
  const claimedSubs = new Set<SubPath>()
  const dropSubs = new Set<SubPath>()

  for (const t of byClaimOrder(targets)) {
    const m = matchTarget(t, marks, claimedMarks, claimedSubs)
    if (!m) continue
    for (const h of m.texts) repl.set(h.op, blankText(ops, h))
    for (const x of m.subs) dropSubs.add(x.sub)
    if (m.image && t.kind === 'image') {
      if (!t.moveTo) repl.set(m.image.op, null)
      else {
        // T maps the old box onto the new one (user space); new CTM = T applied after the old one.
        const r = t.rect
        const n = t.moveTo
        const sx = (n.x1 - n.x0) / (r.x1 - r.x0 || 1)
        const sy = (n.y1 - n.y0) / (r.y1 - r.y0 || 1)
        const T: M = [sx, 0, 0, sy, n.x0 - r.x0 * sx, n.y0 - r.y0 * sy]
        const Mcm = mul(mul(m.image.ctm, T), invert(m.image.ctm))
        repl.set(m.image.op, { wrap: [`q ${Mcm.map(fmtNum).join(' ')} cm`, 'Q'] })
      }
    }
    done.add(t.id)
  }
  removeSubpaths(ops, repl, marks, dropSubs)
  if (repl.size) writeContent(doc, page, src, ops, repl)
  return { done }
}

/**
 * A table's 'paths' target takes every path inside it, so specific targets (a rule or box inside the
 * table that is edited on its own) must claim their geometry first.
 */
const byClaimOrder = (ts: EditTarget[]) => [...ts.filter((t) => t.kind !== 'paths'), ...ts.filter((t) => t.kind === 'paths')]

/**
 * The opposite of editPageContent: removes everything the page paints *except* the targets
 * (used to cut copied / moved objects out of a page so they can be stamped elsewhere as vector
 * content). `avoid`: other edited objects of the page, never kept even if inside a target (a rule
 * moved on its own inside a moved table). Returns the ids of targets that were kept.
 */
export function keepOnly(doc: PDFDocument, page: PDFPage, targets: EditTarget[], avoid: EditTarget[] = []): EditResult {
  const done = new Set<string>()
  const parsed = parsePage(page)
  if (!parsed) return { done }
  const { src, ops, marks } = parsed
  // one claiming pass in byClaimOrder over both lists, so a rule claims its own path before any
  // table (kept or avoided) can take it; what an avoided target claims is not kept
  const ids = new Set(targets.map((t) => t.id))
  const avoided = new Set(avoid.filter((a) => !ids.has(a.id)))
  const claimedMarks = new Set<Mark>()
  const claimedSubs = new Set<SubPath>()
  const avoidMarks = new Set<Mark>()
  const avoidSubs = new Set<SubPath>()
  for (const t of byClaimOrder([...targets, ...avoided])) {
    const m = matchTarget(t, marks, claimedMarks, claimedSubs)
    if (!m) continue
    if (!avoided.has(t)) done.add(t.id)
    else {
      m.texts.forEach((x) => avoidMarks.add(x))
      if (m.image) avoidMarks.add(m.image)
      m.subs.forEach((x) => avoidSubs.add(x.sub))
    }
  }
  const keepMark = (m: Mark) => claimedMarks.has(m) && !avoidMarks.has(m)
  const keepSub = (s: SubPath) => claimedSubs.has(s) && !avoidSubs.has(s)
  const repl: Replacements = new Map()
  const dropSubs = new Set<SubPath>()
  for (const m of marks) {
    if (m.kind === 'text' && !keepMark(m)) repl.set(m.op, blankText(ops, m))
    else if (m.kind === 'image' && !keepMark(m)) repl.set(m.op, null)
    else if (m.kind === 'other') repl.set(m.op, null)
    else if (m.kind === 'path' && !m.clip) for (const s of m.subpaths) if (!keepSub(s)) dropSubs.add(s)
  }
  removeSubpaths(ops, repl, marks, dropSubs)
  writeContent(doc, page, src, ops, repl)
  pruneXObjects(doc, page, ops.filter((_, k) => !repl.has(k)))
  return { done }
}

/** Drops image / form resources no longer drawn, so a cut-out fragment doesn't drag big images along. */
function pruneXObjects(doc: PDFDocument, page: PDFPage, kept: Op[]) {
  const res = page.node.Resources()
  const xo = res?.lookupMaybe(PDFName.of('XObject'), PDFDict)
  if (!res || !xo) return
  const used = new Set(kept.filter((o) => o.op === 'Do' && o.args[0]?.t === 'name').map((o) => (o.args[0] as { v: string }).v))
  const slim = doc.context.obj({}) as PDFDict
  for (const [k, v] of xo.entries()) if (used.has(k.decodeText())) slim.set(k, v)
  const copy = res.clone(doc.context)
  copy.set(PDFName.of('XObject'), slim)
  page.node.set(PDFName.of('Resources'), copy)
}

function fmtNum(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

function segmentCrosses(a: { x: number; y: number }, b: { x: number; y: number }, r: UserRect) {
  // only horizontal-ish runs matter here: does the baseline segment pass through the box?
  const y = (a.y + b.y) / 2
  if (y < r.y0 || y > r.y1) return false
  return Math.max(a.x, b.x) > r.x0 && Math.min(a.x, b.x) < r.x1
}
