import { LineCapStyle, PDFDocument, StandardFonts, concatTransformationMatrix, degrees, drawObject, popGraphicsState, pushGraphicsState, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { BASELINE_RATIO, canvasToPdf, pdfToCanvas, viewRectToUser, viewToUser } from './coords'
import { editPageContent, keepOnly, type EditTarget, type UserRect } from './pdf/pageEdit'
import { LINE_HEIGHT, OPEN_SHAPES, isGraphic, isLine, isMove, isPaste, isShape, isText, type FontFamily, type PageInfo, type PageModel, type SourceMeta, type SourceRef, type TextOverlay } from './model'
import { fontFile, loadFontBytes } from './fonts'
import { fromSuper, measureRuns, runs, SUP_RISE, SUP_SCALE } from './richText'
import { DASH, lineGeometry, shapePath } from './shapes'

export type BytesGetter = (sourceId: string) => Uint8Array

export interface BuildResult {
  bytes: Uint8Array
  warnings: string[]
  /** How many edited objects were truly removed from the content vs. hidden under a cover. */
  stats: { removed: number; covered: number }
}

function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const SERIF = new Set<FontFamily>(['Times', 'Cambria', 'Georgia', 'Garamond'])

function standardFontName(o: Pick<TextOverlay, 'fontFamily' | 'bold' | 'italic'>): StandardFonts {
  const { bold: b, italic: i } = o
  // embedded families fall back to the closest standard font if their file can't be loaded
  const f = o.fontFamily === 'Courier' ? 'Courier' : SERIF.has(o.fontFamily) ? 'Times' : 'Helvetica'
  if (f === 'Times') {
    return b ? (i ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold) : i ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman
  }
  if (f === 'Courier') {
    return b ? (i ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold) : i ? StandardFonts.CourierOblique : StandardFonts.Courier
  }
  return b ? (i ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold) : i ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica
}

/** Greedy word wrap that mirrors CSS `white-space: pre-wrap; overflow-wrap: break-word`. */
export function wrapLines(text: string, width: number, wrap: boolean, measure: (s: string) => number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!wrap) {
      out.push(para)
      continue
    }
    let line = ''
    for (const tok of para.match(/\s+|\S+/g) ?? ['']) {
      if (measure(line + tok) <= width || /^\s+$/.test(tok)) {
        line += tok // fits (trailing whitespace may hang past the edge, like CSS)
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      line = ''
      if (measure(tok) <= width) {
        line = tok
        continue
      }
      let chunk = '' // a single word wider than the box: break by characters
      for (const ch of tok) {
        if (chunk && measure(chunk + ch) > width) {
          out.push(chunk)
          chunk = ch
        } else chunk += ch
      }
      line = chunk
    }
    out.push(line)
  }
  return out
}

const TEXT_TYPES = new Set(['TEXT_BLOCK', 'TABLE_CELL', 'TEXT_LINE'])

/** Content-stream target for a detected object (view-space bounds → user space). */
export function targetForSource(id: string, src: SourceRef, info: PageInfo, moveTo?: { dx: number; dy: number }): EditTarget | null {
  const b = src.bounds
  const r = viewRectToUser(info, b.x, b.y, b.w, b.h)
  const rect: UserRect = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }
  if (TEXT_TYPES.has(src.objType)) return { id, kind: 'text', rect }
  if (src.objType === 'TABLE') return { id, kind: 'paths', rect }
  if (src.objType === 'RECTANGLE') return { id, kind: 'rect', rect }
  if (src.objType === 'LINE') {
    const l = src.line
    const e0 = l ? viewToUser(info, l.x1, l.y1) : b.w >= b.h ? viewToUser(info, b.x, b.y + b.h / 2) : viewToUser(info, b.x + b.w / 2, b.y)
    const e1 = l ? viewToUser(info, l.x2, l.y2) : b.w >= b.h ? viewToUser(info, b.x + b.w, b.y + b.h / 2) : viewToUser(info, b.x + b.w / 2, b.y + b.h)
    return { id, kind: 'line', rect, ends: [e0, e1], thickness: l?.thickness ?? Math.min(b.w, b.h) }
  }
  if (src.objType === 'IMAGE') {
    if (!moveTo) return { id, kind: 'image', rect }
    const n = viewRectToUser(info, b.x + moveTo.dx, b.y + moveTo.dy, b.w, b.h)
    return { id, kind: 'image', rect, moveTo: { x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h } }
  }
  return null
}

/** Affine map (pdf-lib cm order a b c d e f) from one page's user space to another's, via a view-space shift. */
function placementMatrix(from: PageInfo, to: PageInfo, dx: number, dy: number): [number, number, number, number, number, number] {
  const f = (x: number, y: number) => {
    const c = pdfToCanvas(from, { x, y })
    return canvasToPdf(to, { x: c.x + dx, y: c.y + dy })
  }
  const o = f(0, 0)
  const ex = f(1, 0)
  const ey = f(0, 1)
  return [ex.x - o.x, ex.y - o.y, ey.x - o.x, ey.y - o.y, o.x, o.y]
}

export async function buildPdf(
  pages: PageModel[],
  sources: Record<string, SourceMeta>,
  getBytes: BytesGetter,
  opts: { title?: string } = {},
): Promise<BuildResult> {
  if (!pages.length) throw new Error('There are no pages to export.')
  const warnings: string[] = []
  const out = await PDFDocument.create()
  out.setProducer('Anduin PDF Toolbox')
  out.setCreator('Anduin PDF Toolbox')
  if (opts.title) out.setTitle(opts.title)

  // Copy per source in a single call so duplicated pages share their resources.
  const copiedBySource = new Map<string, Awaited<ReturnType<PDFDocument['copyPages']>>>()
  const cursor = new Map<string, number>()
  for (const sourceId of new Set(pages.map((p) => p.sourceId))) {
    const src = await PDFDocument.load(getBytes(sourceId), { updateMetadata: false })
    const indices = pages.filter((p) => p.sourceId === sourceId).map((p) => p.srcIndex)
    copiedBySource.set(sourceId, await out.copyPages(src, indices))
    cursor.set(sourceId, 0)
  }

  const fontCache = new Map<string, PDFFont>()
  let fontkitReady = false
  let fontFallback = false
  const getFont = async (o: TextOverlay) => {
    const file = fontFile(o.fontFamily, o.bold, o.italic)
    const key = file ?? standardFontName(o)
    let f = fontCache.get(key)
    if (!f) {
      if (file) {
        try {
          if (!fontkitReady) {
            out.registerFontkit((await import('@pdf-lib/fontkit')).default)
            fontkitReady = true
          }
          f = await out.embedFont(await loadFontBytes(file), { subset: true })
        } catch (e) {
          console.warn('font embedding failed, using a standard font', e)
          fontFallback = true
          f = await out.embedFont(standardFontName(o))
        }
      } else f = await out.embedFont(key)
      fontCache.set(key, f)
    }
    return f
  }

  let replacedChars = false
  let notMoved = 0
  let pasteFailed = 0

  // source documents for cut-outs (moved / pasted content), loaded once
  const srcDocs = new Map<string, Promise<PDFDocument>>()
  const srcDoc = (id: string) => {
    let d = srcDocs.get(id)
    if (!d) {
      d = PDFDocument.load(getBytes(id), { updateMetadata: false })
      srcDocs.set(id, d)
    }
    return d
  }
  let scratch: PDFDocument | null = null
  let stampN = 0
  /** Draws only `refs` (objects of page sourceId/srcIndex) onto `page`, shifted by (dx, dy) in view space. */
  const stamp = async (page: PDFPage, info: PageInfo, sourceId: string, srcIndex: number, refs: { id: string; src: SourceRef }[], dx: number, dy: number) => {
    const from = sources[sourceId].pages[srcIndex]
    scratch ??= await PDFDocument.create()
    const [cut] = await scratch.copyPages(await srcDoc(sourceId), [srcIndex])
    const ts = refs.map((r) => targetForSource(r.id, r.src, from)).filter((t): t is EditTarget => !!t)
    const kept = keepOnly(scratch, cut, ts).done
    notMoved += refs.length - kept.size
    if (!kept.size) return
    const form = await out.embedPage(cut, undefined, [1, 0, 0, 1, 0, 0])
    const name = page.node.newXObject(`Stamp${++stampN}`, form.ref)
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...placementMatrix(from, info, dx, dy)), drawObject(name), popGraphicsState())
  }
  const stats = { removed: 0, covered: 0 }
  for (const model of pages) {
    const list = copiedBySource.get(model.sourceId)!
    const i = cursor.get(model.sourceId)!
    cursor.set(model.sourceId, i + 1)
    const page = list[i]
    const info = sources[model.sourceId].pages[model.srcIndex]

    if (model.rotation) page.setRotation(degrees((info.rotate + model.rotation) % 360))
    out.addPage(page)

    // 1. remove the original content of edited objects from the content stream (true removal);
    //    anything that cannot be matched safely is hidden with a cover instead.
    const targets: EditTarget[] = []
    for (const o of model.overlays) {
      const src = o.source
      if (!src) continue
      const b = src.bounds
      const r = viewRectToUser(info, b.x, b.y, b.w, b.h)
      const rect = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h }
      if (isMove(o)) {
        const moved = !o.deleted && (Math.abs(o.dx) > 0.01 || Math.abs(o.dy) > 0.01)
        if (!o.deleted && !moved) continue
        const t = targetForSource(o.id, src, info, src.objType === 'IMAGE' && moved ? { dx: o.dx, dy: o.dy } : undefined)
        if (t) targets.push(t)
      } else if (isText(o)) targets.push({ id: o.id, kind: 'text', rect })
      else if (isGraphic(o) && o.kind === 'line') {
        const horizontal = b.w >= b.h
        const e0 = horizontal ? viewToUser(info, b.x, b.y + b.h / 2) : viewToUser(info, b.x + b.w / 2, b.y)
        const e1 = horizontal ? viewToUser(info, b.x + b.w, b.y + b.h / 2) : viewToUser(info, b.x + b.w / 2, b.y + b.h)
        targets.push({ id: o.id, kind: 'line', rect, ends: [e0, e1], thickness: o.thickness })
      } else if (isGraphic(o) && o.kind === 'rect') targets.push({ id: o.id, kind: 'rect', rect })
      else if (isGraphic(o)) {
        const moved = !o.deleted && (Math.abs(o.x - b.x) > 0.01 || Math.abs(o.y - b.y) > 0.01 || Math.abs(o.w - b.w) > 0.01 || Math.abs(o.h - b.h) > 0.01)
        const n = viewRectToUser(info, o.x, o.y, o.w, o.h)
        if (o.deleted || moved) targets.push({ id: o.id, kind: 'image', rect, moveTo: moved ? { x0: n.x, y0: n.y, x1: n.x + n.w, y1: n.y + n.h } : undefined })
      }
    }
    let removed = new Set<string>()
    try {
      removed = editPageContent(out, page, targets).done
    } catch (e) {
      console.warn('content stream edit failed, falling back to covers', e)
    }
    stats.removed += removed.size
    stats.covered += targets.length - removed.size

    for (const o of model.overlays) {
      if (removed.has(o.id)) continue
      if (isText(o) && o.cover) {
        const r = viewRectToUser(info, o.cover.x, o.cover.y, o.cover.w, o.cover.h)
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: hexToRgb(o.cover.color), borderWidth: 0 })
      } else if (isGraphic(o) || isMove(o)) {
        const keep = isGraphic(o) ? o.kind === 'image' && !o.deleted : !o.deleted
        if (keep) {
          // could not move it: leave the original where it is rather than lose it
          if (targets.some((t) => t.id === o.id)) notMoved += 1
          continue
        }
        const b = o.source.bounds
        const pad = 0.75
        const r = viewRectToUser(info, b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad)
        page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: hexToRgb(o.coverColor), borderWidth: 0 })
      }
    }

    // 2. moved objects (removed above) and pasted blocks: the original operators, cut out of their
    //    page and stamped at the new position as a Form XObject (vector, original fonts, selectable)
    const groups = new Map<string, { dx: number; dy: number; refs: { id: string; src: SourceRef }[] }>()
    for (const o of model.overlays) {
      if (!isMove(o) || o.deleted || !removed.has(o.id) || o.source.objType === 'IMAGE') continue
      const key = `${o.dx.toFixed(3)},${o.dy.toFixed(3)}`
      const g = groups.get(key) ?? { dx: o.dx, dy: o.dy, refs: [] }
      g.refs.push({ id: o.id, src: o.source })
      groups.set(key, g)
    }
    for (const g of groups.values()) await stamp(page, info, model.sourceId, model.srcIndex, g.refs, g.dx, g.dy)
    for (const o of model.overlays) {
      if (!isPaste(o)) continue
      if (!sources[o.sourceId]) {
        pasteFailed += 1
        continue
      }
      await stamp(page, info, o.sourceId, o.srcIndex, o.items.map((it, k) => ({ id: `${o.id}:${k}`, src: it })), o.dx, o.dy)
    }

    for (const o of model.overlays) {
      if (!isGraphic(o) || o.deleted || o.kind === 'image') continue
      if (o.kind === 'line') {
        const horizontal = o.w >= o.h
        const a = horizontal ? viewToUser(info, o.x, o.y + o.h / 2) : viewToUser(info, o.x + o.w / 2, o.y)
        const b = horizontal ? viewToUser(info, o.x + o.w, o.y + o.h / 2) : viewToUser(info, o.x + o.w / 2, o.y + o.h)
        page.drawLine({ start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, thickness: o.thickness, color: hexToRgb(o.strokeColor ?? '#000000') })
      } else {
        const r = viewRectToUser(info, o.x, o.y, o.w, o.h)
        page.drawRectangle({
          x: r.x, y: r.y, width: r.w, height: r.h,
          color: o.fillColor ? hexToRgb(o.fillColor) : undefined,
          borderColor: o.strokeColor ? hexToRgb(o.strokeColor) : undefined,
          borderWidth: o.strokeColor ? o.thickness : 0,
        })
      }
    }

    // shapes drawn with Add Shape: the same SVG path as on screen, anchored at the box's top-left
    for (const o of model.overlays) {
      if (!isShape(o) || o.w <= 0 || o.h <= 0) continue
      const open = OPEN_SHAPES.has(o.shape)
      const fill = open ? null : o.fill
      if (!fill && !o.stroke) continue
      const origin = viewToUser(info, o.x, o.y)
      page.drawSvgPath(shapePath(o.shape, o.w, o.h), {
        x: origin.x,
        y: origin.y,
        rotate: degrees(origin.angle),
        ...(fill ? { color: hexToRgb(fill), opacity: o.opacity } : {}),
        ...(o.stroke
          ? {
              borderColor: hexToRgb(o.stroke),
              borderWidth: o.thickness,
              borderOpacity: o.opacity,
              borderDashArray: DASH(o.dash, o.thickness),
              borderLineCap: o.dash === 'dotted' || open ? LineCapStyle.Round : LineCapStyle.Butt,
            }
          : {}),
      })
    }

    // lines drawn with Add Line (arrowheads are filled triangles)
    for (const o of model.overlays) {
      if (!isLine(o)) continue
      const g = lineGeometry(o)
      const a = viewToUser(info, g.shaft.x1, g.shaft.y1)
      const b = viewToUser(info, g.shaft.x2, g.shaft.y2)
      const t = o.thickness
      page.drawLine({
        start: { x: a.x, y: a.y },
        end: { x: b.x, y: b.y },
        thickness: t,
        color: hexToRgb(o.color),
        dashArray: DASH(o.dash, t),
        lineCap: o.dash === 'dotted' ? LineCapStyle.Round : LineCapStyle.Butt,
      })
      for (const h of g.heads) {
        const o0 = viewToUser(info, 0, 0)
        const path = `M${h.map(([x, y]) => `${x} ${y}`).join(' L')} Z`
        page.drawSvgPath(path, { x: o0.x, y: o0.y, rotate: degrees(o0.angle), color: hexToRgb(o.color) })
      }
    }

    for (const o of model.overlays) {
      if (!isText(o) || !o.text.trim()) continue
      const font = await getFont(o)
      const supported = new Set(font.getCharacterSet())
      let cleaned = ''
      for (const ch of o.text.replace(/\r/g, '').replace(/\t/g, '    ')) {
        // superscripts are drawn as the normal character, smaller and raised
        if (ch === '\n' || supported.has(fromSuper(ch).codePointAt(0)!)) cleaned += ch
        else {
          cleaned += '?'
          replacedChars = true
        }
      }
      const measure = (s: string) => measureRuns(s, (t) => font.widthOfTextAtSize(t, o.fontSize))
      // wrap paragraph by paragraph so justified text keeps each paragraph's last line ragged
      const lines: { text: string; last: boolean }[] = []
      for (const para of cleaned.split('\n')) {
        const ls = wrapLines(para, o.width, o.wrap, measure)
        ls.forEach((t, k) => lines.push({ text: t, last: k === ls.length - 1 }))
      }
      const ratio = o.lineHeight ?? LINE_HEIGHT
      const lh = o.fontSize * ratio
      const base = o.fontSize * (BASELINE_RATIO[o.fontFamily] + (ratio - LINE_HEIGHT) / 2)
      const color = hexToRgb(o.color)
      const rot = (p: { angle: number }) => degrees(p.angle)
      /** Draws mixed normal / superscript text with its baseline-left at (x, y) (view space). */
      const drawRuns = (s: string, x: number, y: number) => {
        let cx = x
        for (const r of runs(s)) {
          const size = r.sup ? o.fontSize * SUP_SCALE : o.fontSize
          const p = viewToUser(info, cx, r.sup ? y - o.fontSize * SUP_RISE : y)
          page.drawText(r.text, { x: p.x, y: p.y, size, font, color, rotate: rot(p) })
          cx += font.widthOfTextAtSize(r.text, size)
        }
      }
      const rule = (x: number, y: number, w: number) => {
        const a = viewToUser(info, x, y)
        const b = viewToUser(info, x + w, y)
        page.drawLine({ start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, thickness: Math.max(0.5, o.fontSize * 0.06), color })
      }
      lines.forEach((line, idx) => {
        const trimmed = line.text.replace(/\s+$/, '')
        if (!trimmed) return
        const w = measure(trimmed)
        const y = o.y + idx * lh + base
        const words = trimmed.split(/\s+/)
        if (o.align === 'justify' && o.wrap && !line.last && words.length > 1) {
          const gap = (o.width - words.reduce((n, wd) => n + measure(wd), 0)) / (words.length - 1)
          let x = o.x
          for (const wd of words) {
            drawRuns(wd, x, y)
            x += measure(wd) + gap
          }
        } else {
          const dx = o.align === 'center' ? (o.width - w) / 2 : o.align === 'right' ? o.width - w : 0
          drawRuns(trimmed, o.x + dx, y)
        }
        if (o.underline || o.strike) {
          const dx = o.align === 'center' ? (o.width - w) / 2 : o.align === 'right' ? o.width - w : 0
          const lw = o.align === 'justify' && o.wrap && !line.last && words.length > 1 ? o.width : w
          if (o.underline) rule(o.x + dx, y + o.fontSize * 0.12, lw)
          if (o.strike) rule(o.x + dx, y - o.fontSize * 0.27, lw)
        }
      })
    }
  }
  if (replacedChars) {
    warnings.push('Some characters are not supported by the standard PDF fonts and were replaced with “?”.')
  }
  if (fontFallback) warnings.push('A font could not be loaded, so some text was exported with the closest standard PDF font.')
  if (notMoved) warnings.push(`${notMoved} moved object${notMoved > 1 ? 's' : ''} could not be moved exactly in the exported file and ${notMoved > 1 ? 'were' : 'was'} left in the original position.`)
  if (pasteFailed) warnings.push('Some pasted content could not be exported because its source document is no longer loaded.')
  return { bytes: await out.save(), warnings, stats }
}
