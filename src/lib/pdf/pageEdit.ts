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
type Mark = TextMark | PathMark | ImageMark

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
      for (let k = 0; k < w.size(); ) {
        const first = (w.lookup(k) as PDFNumber).asNumber()
        const next = w.lookup(k + 1)
        if (next instanceof PDFArray) {
          for (let j = 0; j < next.size(); j += 1) widths.set(first + j, (next.lookup(j) as PDFNumber).asNumber())
          k += 2
        } else {
          const last = (next as PDFNumber).asNumber()
          const val = (w.lookup(k + 2) as PDFNumber).asNumber()
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
      m = metricsFor(fonts?.lookupMaybe(PDFName.of(name), PDFDict))
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
        break
      }
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
  | { id: string; kind: 'text'; rect: UserRect }
  | { id: string; kind: 'line'; rect: UserRect; ends: [{ x: number; y: number }, { x: number; y: number }]; thickness: number }
  | { id: string; kind: 'rect'; rect: UserRect }
  | { id: string; kind: 'image'; rect: UserRect; moveTo?: UserRect }

export interface EditResult {
  /** Target ids whose original content was removed (or transformed) in the content stream. */
  done: Set<string>
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol
const sameRect = (a: UserRect, b: UserRect, tol: number) => near(a.x0, b.x0, tol) && near(a.y0, b.y0, tol) && near(a.x1, b.x1, tol) && near(a.y1, b.y1, tol)
const inside = (p: { x: number; y: number }, r: UserRect, tol: number, tolX = tol) => p.x >= r.x0 - tolX && p.x <= r.x1 + tolX && p.y >= r.y0 - tol && p.y <= r.y1 + tol

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

/**
 * Removes (or, for images, moves) the content painting each target. Must be called before
 * anything else is drawn on the page. Targets that cannot be handled safely are left alone.
 */
export function editPageContent(doc: PDFDocument, page: PDFPage, targets: EditTarget[]): EditResult {
  const done = new Set<string>()
  if (!targets.length) return { done }
  let src: Uint8Array | null = null
  try {
    src = contentBytes(page)
  } catch {
    return { done }
  }
  if (!src) return { done }
  const ops = parseContentStream(src)
  const marks = interpret(ops, page.node.Resources())
  const repl: Replacements = new Map()
  const claimed = new Set<Mark>()

  for (const t of targets) {
    if (t.kind === 'text') {
      const tol = 2
      const hits: TextMark[] = []
      let partial = false
      for (const m of marks) {
        if (m.kind !== 'text' || !m.show.trim()) continue
        const ia = inside(m.a, t.rect, tol)
        // our width estimate may be a few % off: allow that horizontally, never vertically
        const ib = inside(m.b, t.rect, tol, Math.max(tol, Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) * 0.04))
        if (ia && ib) hits.push(m)
        else if (ia || ib || segmentCrosses(m.a, m.b, t.rect)) {
          partial = true
          if (DEBUG_EDITS) console.log('partial', JSON.stringify({ show: m.show, a: m.a, b: m.b, rect: t.rect, ia, ib }))
        }
      }
      if (partial || !hits.length || hits.some((h) => claimed.has(h))) continue
      for (const h of hits) {
        claimed.add(h)
        const op = ops[h.op]
        const scale = h.fontSize * h.hScale
        const kern = scale ? `[${fmtNum((-h.advance * 1000) / scale)}] TJ` : ''
        // keep the text position for anything drawn after it on the same line
        if (op.op === "'") repl.set(h.op, `T* ${kern}`)
        else if (op.op === '"') repl.set(h.op, `${serializeOperand(op.args[0])} Tw ${serializeOperand(op.args[1])} Tc T* ${kern}`)
        else repl.set(h.op, kern || null)
      }
      done.add(t.id)
    } else if (t.kind === 'line' || t.kind === 'rect') {
      let found: { mark: PathMark; sub: SubPath } | null = null
      for (const m of marks) {
        if (m.kind !== 'path' || m.clip) continue
        for (const s of m.subpaths) {
          const ok =
            t.kind === 'line'
              ? s.points.length >= 2 && ((near(s.points[0].x, t.ends[0].x, 1.5) && near(s.points[0].y, t.ends[0].y, 1.5) && near(s.points[s.points.length - 1].x, t.ends[1].x, 1.5) && near(s.points[s.points.length - 1].y, t.ends[1].y, 1.5)) ||
                  (near(s.points[0].x, t.ends[1].x, 1.5) && near(s.points[0].y, t.ends[1].y, 1.5) && near(s.points[s.points.length - 1].x, t.ends[0].x, 1.5) && near(s.points[s.points.length - 1].y, t.ends[0].y, 1.5)) ||
                  sameRect(s.bbox, t.rect, Math.max(1.2, t.thickness)))
              : sameRect(s.bbox, t.rect, 1.5)
          if (ok) {
            found = { mark: m, sub: s }
            break
          }
        }
        if (found) break
      }
      if (!found) continue
      const { mark, sub } = found
      if (mark.subpaths.length === 1) for (let k = mark.start; k <= mark.paint; k += 1) repl.set(k, null)
      else for (let k = sub.first; k <= sub.last; k += 1) repl.set(k, null)
      done.add(t.id)
    } else if (t.kind === 'image') {
      const m = marks.find((x): x is ImageMark => x.kind === 'image' && !claimed.has(x) && sameRect(x.bbox, t.rect, 1.5))
      if (!m) continue
      claimed.add(m)
      const op = ops[m.op]
      if (!t.moveTo) repl.set(m.op, null)
      else {
        // T maps the old box onto the new one (user space); new CTM = T applied after the old one.
        const r = t.rect
        const n = t.moveTo
        const sx = (n.x1 - n.x0) / (r.x1 - r.x0 || 1)
        const sy = (n.y1 - n.y0) / (r.y1 - r.y0 || 1)
        const T: M = [sx, 0, 0, sy, n.x0 - r.x0 * sx, n.y0 - r.y0 * sy]
        const Mcm = mul(mul(m.ctm, T), invert(m.ctm))
        void op
        repl.set(m.op, { wrap: [`q ${Mcm.map(fmtNum).join(' ')} cm`, 'Q'] })
      }
      done.add(t.id)
    }
  }
  if (!repl.size) return { done }
  const rebuilt = rebuildContentStream(src, ops, repl)
  const stream = doc.context.flateStream(rebuilt)
  page.node.set(PDFName.of('Contents'), doc.context.register(stream) as PDFRef)
  return { done }
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
