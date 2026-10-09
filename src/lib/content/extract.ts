// Low-level extraction: PDF.js page → RawPage (text items, vector paths, images) in view space.
//
// Two PDF.js sources are combined:
//  - getTextContent(): robust text strings with positions (PDF.js normalises encodings for us)
//  - getOperatorList(): every drawing operator, which we walk ourselves (CTM stack, colours,
//    text state, paths, images, form XObjects). This gives colours, rules, rectangles and
//    images, and the operator indices that paint each text item, so the viewer can later hide
//    exactly those operators (PDF.js `operationsFilter`).
import type { PDFPageProxy } from 'pdfjs-dist'
import type { Box, RawImage, RawPage, RawPath, RawText } from './types'

/** PDF.js operator names that put ink on the page. */
const PAINT_OPS = new Set([
  'showText', 'showSpacedText', 'nextLineShowText', 'nextLineSetSpacingShowText',
  'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke',
  'shadingFill', 'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintSolidColorImageMask',
  'paintImageXObjectRepeat', 'paintImageMaskXObjectGroup', 'paintImageMaskXObjectRepeat', 'paintInlineImageXObjectGroup',
])

export interface PdfjsLib {
  OPS: Record<string, number>
  Util: { transform: (a: number[], b: number[]) => number[] }
}

interface TextOpRun {
  op: number
  x0: number
  x1: number
  baseline: number
  size: number
  color: string | null
  horizontal: boolean
}

interface FontInfo {
  name: string
  bold: boolean
  italic: boolean
  fontMatrix: number[]
  vertical: boolean
}

const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 }

/**
 * Reads the font's real name from its OpenType `name` table. PDF.js v6 no longer exposes the
 * PDF font name on its font objects, but (with `fontExtraProperties`) keeps the converted font
 * file, whose name table carries the PDF BaseFont (e.g. "Times-Bold", "ABCDEF+Calibri-Italic").
 */
export function openTypeNames(data: Uint8Array): { name: string; sub: string; weight: number; italicBit: boolean } | null {
  try {
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const n = v.getUint16(4)
    const tables: Record<string, number> = {}
    for (let i = 0; i < n; i += 1) {
      const o = 12 + i * 16
      tables[String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3])] = v.getUint32(o + 8)
    }
    const names: Record<number, string> = {}
    if (tables.name !== undefined) {
      const t = tables.name
      const count = v.getUint16(t + 2)
      const strings = t + v.getUint16(t + 4)
      for (let i = 0; i < count; i += 1) {
        const r = t + 6 + i * 12
        const platform = v.getUint16(r)
        const id = v.getUint16(r + 6)
        const len = v.getUint16(r + 8)
        const off = strings + v.getUint16(r + 10)
        if (names[id] || ![1, 2, 4, 6].includes(id)) continue
        const b = data.subarray(off, off + len)
        names[id] = platform === 1 ? String.fromCharCode(...b) : String.fromCharCode(...Array.from({ length: len >> 1 }, (_, k) => (b[2 * k] << 8) | b[2 * k + 1]))
      }
    }
    const os2 = tables['OS/2']
    return {
      name: names[6] || names[4] || names[1] || '',
      sub: names[2] || '',
      weight: os2 !== undefined ? v.getUint16(os2 + 4) : 400,
      italicBit: os2 !== undefined ? (v.getUint16(os2 + 62) & 1) === 1 : false,
    }
  } catch {
    return null
  }
}

function fontInfo(page: PDFPageProxy, loadedName: string): FontInfo {
  try {
    if (page.commonObjs.has(loadedName)) {
      const f = page.commonObjs.get(loadedName) as Record<string, unknown>
      const ot = f.data instanceof Uint8Array ? openTypeNames(f.data) : null
      const raw = String(ot?.name || f.name || f.fallbackName || loadedName).replace(/^[A-Z]{6}\+/, '')
      const sub = ot?.sub && !/regular|unknown|normal|book|roman/i.test(ot.sub) ? ot.sub : ''
      const name = sub && !raw.toLowerCase().includes(sub.toLowerCase().replace(/\s+/g, '')) ? `${raw}-${sub.replace(/\s+/g, '')}` : raw
      return {
        name,
        bold: !!(f.bold || f.black) || /bold|black|heavy/i.test(sub),
        italic: !!f.italic || !!ot?.italicBit || /italic|oblique/i.test(sub),
        fontMatrix: (f.fontMatrix as number[]) ?? [0.001, 0, 0, 0.001, 0, 0],
        vertical: !!f.vertical,
      }
    }
  } catch {
    /* not loaded */
  }
  return { name: loadedName, bold: false, italic: false, fontMatrix: [0.001, 0, 0, 0.001, 0, 0], vertical: false }
}

const normColor = (c: unknown): string | null => {
  if (typeof c !== 'string') return null
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase()
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
  if (m) return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`
  return null
}

export async function extractPage(page: PDFPageProxy, lib: PdfjsLib): Promise<RawPage & { fonts: Map<string, FontInfo> }> {
  const { OPS, Util } = lib
  const vp = page.getViewport({ scale: 1 })
  // The operator list is fetched first: it also makes the fonts available in commonObjs.
  const opList = await page.getOperatorList()
  const tc = await page.getTextContent()
  const fonts = new Map<string, FontInfo>()
  const getFont = (n: string) => {
    let f = fonts.get(n)
    if (!f) {
      f = fontInfo(page, n)
      fonts.set(n, f)
    }
    return f
  }

  const name = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k])) as Record<number, string>
  const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]

  // ---- walk the operator list ------------------------------------------------
  interface GState {
    ctm: number[]
    fill: string | null
    stroke: string | null
    lineWidth: number
    font: string
    fontSize: number
    charSpacing: number
    wordSpacing: number
    hScale: number
    leading: number
    rise: number
  }
  let g: GState = { ctm: vp.transform.slice(), fill: '#000000', stroke: '#000000', lineWidth: 1, font: '', fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0 }
  const stack: GState[] = []
  let tm: number[] | null = null
  let tx = 0
  let ty = 0
  let lineX = 0
  let lineY = 0

  const textRuns: TextOpRun[] = []
  const paths: RawPath[] = []
  const images: RawImage[] = []

  const pushImage = (op: number, m: number[]) => {
    const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)]
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const bbox = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
    if (bbox.w > 0.5 && bbox.h > 0.5) images.push({ op, bbox })
  }

  const { fnArray, argsArray } = opList
  const paintOps: number[] = []
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = name[fnArray[i]]
    const a = (argsArray[i] ?? []) as unknown[]
    if (PAINT_OPS.has(fn) || (fn === 'constructPath' && name[a[0] as number] !== 'endPath')) paintOps.push(i)
    switch (fn) {
      case 'save':
      case 'beginGroup':
        stack.push({ ...g })
        break
      case 'restore':
      case 'endGroup':
        if (stack.length) g = stack.pop()!
        break
      case 'transform':
        g.ctm = Util.transform(g.ctm, a as number[])
        break
      case 'paintFormXObjectBegin':
        stack.push({ ...g })
        if (Array.isArray(a[0]) || ArrayBuffer.isView(a[0])) g.ctm = Util.transform(g.ctm, Array.from(a[0] as number[]))
        break
      case 'paintFormXObjectEnd':
        if (stack.length) g = stack.pop()!
        break
      case 'setFillRGBColor':
        g.fill = normColor(a[0])
        break
      case 'setStrokeRGBColor':
        g.stroke = normColor(a[0])
        break
      case 'setFillTransparent':
        g.fill = null
        break
      case 'setStrokeTransparent':
        g.stroke = null
        break
      case 'setLineWidth':
        g.lineWidth = Number(a[0])
        break
      case 'setGState':
        for (const [k, v] of (a[0] as [string, unknown][]) ?? []) {
          if (k === 'LW') g.lineWidth = Number(v)
          if (k === 'Font' && Array.isArray(v)) {
            g.font = String(v[0])
            g.fontSize = Number(v[1])
          }
        }
        break
      // ---- text state ----
      case 'beginText':
        tm = null
        tx = ty = lineX = lineY = 0
        break
      case 'setFont':
        g.font = String(a[0])
        g.fontSize = Number(a[1])
        break
      case 'setTextMatrix': {
        const m = (a.length >= 6 ? a.slice(0, 6) : Array.from(a[0] as number[])) as number[]
        tm = m
        tx = ty = lineX = lineY = 0
        break
      }
      case 'moveText':
        tx = lineX += Number(a[0])
        ty = lineY += Number(a[1])
        break
      case 'setLeadingMoveText':
        g.leading = Number(a[1])
        tx = lineX += Number(a[0])
        ty = lineY += Number(a[1])
        break
      case 'nextLine':
        // PDF.js stores leading negated (setLeading(l) → leading = -l); T* moves by it
        tx = lineX
        ty = lineY += g.leading
        break
      case 'setLeading':
        g.leading = -Number(a[0])
        break
      case 'setCharSpacing':
        g.charSpacing = Number(a[0])
        break
      case 'setWordSpacing':
        g.wordSpacing = Number(a[0])
        break
      case 'setHScale':
        g.hScale = Number(a[0]) / 100
        break
      case 'setTextRise':
        g.rise = Number(a[0])
        break
      case 'showText': {
        const glyphs = (a[0] ?? []) as (number | { width: number; isSpace?: boolean })[]
        const f = getFont(g.font)
        const size = Math.abs(g.fontSize)
        const dir = g.fontSize < 0 ? -1 : 1
        const adv = size * (f.fontMatrix[0] || 0.001)
        let x = 0
        for (const gl of glyphs) {
          if (typeof gl === 'number') {
            x += (f.vertical ? 1 : -1) * gl * size / 1000
            continue
          }
          const spacing = (gl.isSpace ? g.wordSpacing : 0) + g.charSpacing
          x += (gl.width ?? 0) * adv + spacing * dir
        }
        const trm = Util.transform(Util.transform(g.ctm, tm ?? [1, 0, 0, 1, 0, 0]), [1, 0, 0, 1, tx, ty + g.rise])
        const start = apply(trm, 0, 0)
        const end = apply(trm, x * g.hScale * dir, 0)
        const scaleY = Math.hypot(trm[2], trm[3])
        textRuns.push({
          op: i,
          x0: Math.min(start[0], end[0]),
          x1: Math.max(start[0], end[0]),
          baseline: start[1],
          size: size * scaleY,
          color: g.fill,
          horizontal: Math.abs(trm[1]) < 0.02 * Math.abs(trm[0]) && trm[0] > 0 && !f.vertical,
        })
        tx += x * g.hScale * dir
        break
      }
      // ---- paths ----
      case 'constructPath': {
        const paintOp = name[a[0] as number] ?? ''
        if (paintOp === 'endPath') break // clipping path only
        const raw = (a[1] as unknown[])?.[0] as ArrayLike<number> | undefined
        if (!raw || !('length' in raw)) break
        const stroke = /stroke/i.test(paintOp)
        const fill = /fill/i.test(paintOp)
        const subs: [number, number][][] = []
        let cur: [number, number][] = []
        let curves = false
        for (let k = 0; k < raw.length; ) {
          const c = raw[k++]
          if (c === DRAW.moveTo) {
            if (cur.length) subs.push(cur)
            cur = [apply(g.ctm, raw[k++], raw[k++])]
          } else if (c === DRAW.lineTo) {
            cur.push(apply(g.ctm, raw[k++], raw[k++]))
          } else if (c === DRAW.curveTo) {
            curves = true
            k += 4
            cur.push(apply(g.ctm, raw[k++], raw[k++]))
          } else if (c === DRAW.quadraticCurveTo) {
            curves = true
            k += 2
            cur.push(apply(g.ctm, raw[k++], raw[k++]))
          } else if (c === DRAW.closePath) {
            if (cur.length) cur.push(cur[0])
          } else break
        }
        if (cur.length) subs.push(cur)
        const segments: [number, number, number, number][] = []
        const rects: Box[] = []
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const s of subs) {
          for (const [x, y] of s) {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
          }
          const rect = asRect(s)
          if (rect) rects.push(rect)
          else for (let k = 1; k < s.length; k += 1) segments.push([s[k - 1][0], s[k - 1][1], s[k][0], s[k][1]])
        }
        if (!Number.isFinite(minX)) break
        const scale = Math.hypot(g.ctm[0], g.ctm[1]) || 1
        paths.push({
          op: i,
          segments,
          rects,
          hasCurves: curves,
          bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
          stroke,
          fill,
          strokeColor: stroke ? g.stroke : null,
          fillColor: fill ? g.fill : null,
          lineWidth: Math.max(0.25, g.lineWidth * scale),
          subpaths: subs.length,
        })
        break
      }
      // ---- images ----
      case 'paintImageXObject':
      case 'paintInlineImageXObject':
      case 'paintImageMaskXObject':
      case 'paintSolidColorImageMask':
        pushImage(i, g.ctm)
        break
      case 'paintImageXObjectRepeat': {
        const [, sx, sy, pos] = a as [unknown, number, number, number[]]
        for (let k = 0; k + 1 < (pos?.length ?? 0); k += 2) pushImage(i, Util.transform(g.ctm, [sx, 0, 0, sy, pos[k], pos[k + 1]]))
        break
      }
      default:
        break
    }
  }

  // ---- text items, with colour and painting operators -------------------------
  const texts: RawText[] = []
  for (const it of tc.items) {
    if (!('str' in it) || !it.str.trim()) continue
    const t = Util.transform(vp.transform, it.transform)
    const size = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1])
    if (size < 0.5) continue
    const horizontal = Math.abs(t[1]) < 0.02 * Math.abs(t[0]) && t[0] > 0
    const x = t[4]
    const baseline = t[5]
    const width = horizontal ? it.width : Math.hypot(t[0], t[1]) ? it.width : 0
    const f = getFont(it.fontName)
    const ops: number[] = []
    let color: string | null = null
    for (const r of textRuns) {
      if (Math.abs(r.baseline - baseline) > Math.max(0.6, 0.3 * size)) continue
      const overlap = Math.min(r.x1, x + width) - Math.max(r.x0, x)
      const minW = Math.max(0.5, Math.min(r.x1 - r.x0, width))
      if (overlap > 0.3 * minW || (r.x0 >= x - 0.5 && r.x0 <= x + width + 0.5)) {
        ops.push(r.op)
        if (color === null) color = r.color
      }
    }
    texts.push({
      str: it.str,
      x,
      baseline,
      width,
      size,
      fontName: f.name,
      bold: f.bold,
      italic: f.italic,
      generic: tc.styles[it.fontName]?.fontFamily ?? '',
      color,
      ops,
      horizontal,
    })
  }

  return { width: vp.width, height: vp.height, texts, paths, images, fonts, paintOps }
}

/** Recognises an axis-aligned rectangle subpath (4 corners, optionally closed). */
function asRect(pts: [number, number][]): Box | null {
  const p = pts.length >= 5 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 0.01 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 0.01 ? pts.slice(0, -1) : pts
  if (p.length !== 4) return null
  const xs = [...new Set(p.map((q) => Math.round(q[0] * 100) / 100))]
  const ys = [...new Set(p.map((q) => Math.round(q[1] * 100) / 100))]
  if (xs.length !== 2 || ys.length !== 2) return null
  for (let k = 0; k < 4; k += 1) {
    const [a, b] = [p[k], p[(k + 1) % 4]]
    if (Math.abs(a[0] - b[0]) > 0.01 && Math.abs(a[1] - b[1]) > 0.01) return null
  }
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1] - xs[0]), h: Math.abs(ys[1] - ys[0]) }
}
