// Turning a detected content object into an editable overlay (and back into PDF on export).
import { BASELINE_RATIO } from '../coords'
import { sampleColors } from '../geom'
import { makeTextOverlay, uid, type GraphicOverlay, type MoveOverlay, type SourceRef, type TextOverlay } from '../model'
import type { Box, ContentObject, PageContent } from './types'

export const sourceRef = (o: ContentObject): SourceRef => ({
  objectId: o.id,
  objType: o.type,
  bounds: { ...o.bounds },
  ops: o.ops,
  // a table owns no text itself (its cells do): it is exclusive even when it has no rules
  exclusive: o.opsExclusive && (o.ops.length > 0 || o.type === 'TABLE'),
  ...(o.foreign?.length ? { foreign: o.foreign.map((b) => ({ ...b })) } : {}),
  ...(o.textOps ? { textOps: { ordinals: [...o.textOps.ordinals], total: o.textOps.total } } : {}),
  ...(o.type === 'LINE' && o.x1 !== undefined ? { line: { x1: o.x1, y1: o.y1!, x2: o.x2!, y2: o.y2!, thickness: o.thickness ?? 1 } } : {}),
})

/** Rigid move (or delete) of an object as drawn in the PDF; see MoveOverlay. */
export function moveOverlayFor(o: ContentObject, d: { dx?: number; dy?: number; deleted?: boolean; coverColor?: string } = {}): MoveOverlay {
  return { id: uid('mv'), type: 'move', source: sourceRef(o), dx: d.dx ?? 0, dy: d.dy ?? 0, deleted: !!d.deleted, coverColor: d.coverColor ?? '#ffffff' }
}

/** Samples background/foreground colours of a view-space box from the rendered page canvas. */
export function sampleBox(canvas: HTMLCanvasElement | null | undefined, pageWidth: number, b: Box) {
  if (!canvas) return { bg: '#ffffff', fg: '#000000' }
  const k = canvas.width / pageWidth
  return sampleColors(canvas, { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k })
}

/** Union of the bounds of a text object's lines (cells are larger than their text). */
function textBounds(o: ContentObject, content: PageContent): Box {
  const lines = o.children.map((id) => content.objects[id]).filter(Boolean)
  if (!lines.length) return o.bounds
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const l of lines) {
    x0 = Math.min(x0, l.bounds.x); y0 = Math.min(y0, l.bounds.y)
    x1 = Math.max(x1, l.bounds.x + l.bounds.w); y1 = Math.max(y1, l.bounds.y + l.bounds.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const neighbourStyle = (o: ContentObject, content: PageContent) => {
  if (o.type !== 'TABLE_CELL') return null
  const row = content.objects[o.parent ?? '']
  for (const id of row?.children ?? []) if (content.objects[id]?.style) return content.objects[id].style!
  return null
}

/** Text overlay that reproduces a TEXT_BLOCK / TABLE_CELL as closely as standard fonts allow. */
export function textOverlayFromObject(o: ContentObject, content: PageContent, canvas: HTMLCanvasElement | null | undefined): TextOverlay {
  const st = o.style ?? neighbourStyle(o, content)
  const fs = st?.fontSize ?? 10
  const family = st?.fontFamily ?? 'Helvetica'
  const ratio = Math.max(1, st?.lineHeight ?? 1.2)
  const multi = o.children.length > 1
  const tb = o.text ? textBounds(o, content) : { x: o.bounds.x + 6, y: o.bounds.y + (o.bounds.h - fs * 1.2) / 2, w: o.bounds.w - 12, h: fs * 1.2 }
  const cover = { x: tb.x - 1.5, y: tb.y - 1, w: tb.w + 3, h: tb.h + 2 }
  const colors = sampleBox(canvas, content.width, cover)
  const base = fs * (BASELINE_RATIO[family] + (ratio - 1.2) / 2)
  const y = o.firstBaseline !== undefined ? o.firstBaseline - base : tb.y
  // Cells may grow to the cell's inner width; blocks keep their measured width.
  const width = o.type === 'TABLE_CELL' ? Math.max(tb.w, o.bounds.x + o.bounds.w - tb.x - Math.max(3, tb.x - o.bounds.x)) : tb.w + 1
  return makeTextOverlay(tb.x, y, {
    text: o.text ?? '',
    fontFamily: family,
    fontSize: fs,
    bold: st?.bold ?? false,
    italic: st?.italic ?? false,
    color: st?.color ?? colors.fg,
    align: st?.align === 'justify' && !multi ? 'left' : (st?.align ?? 'left'),
    lineHeight: ratio,
    width,
    wrap: multi || o.type === 'TABLE_CELL',
    cover: o.text ? { ...cover, color: colors.bg } : undefined,
    source: sourceRef(o),
  })
}

export function graphicOverlayFromObject(o: ContentObject, content: PageContent, canvas: HTMLCanvasElement | null | undefined): GraphicOverlay {
  const pad = 2
  const ring = { x: o.bounds.x - pad, y: o.bounds.y - pad, w: o.bounds.w + 2 * pad, h: o.bounds.h + 2 * pad }
  const colors = sampleBox(canvas, content.width, ring)
  return {
    id: uid('gr'),
    type: 'graphic',
    kind: o.type === 'LINE' ? 'line' : o.type === 'IMAGE' ? 'image' : 'rect',
    source: sourceRef(o),
    x: o.bounds.x,
    y: o.bounds.y,
    w: o.bounds.w,
    h: o.bounds.h,
    deleted: false,
    strokeColor: o.strokeColor ?? null,
    fillColor: o.fillColor ?? null,
    thickness: o.thickness ?? 1,
    coverColor: colors.bg,
  }
}

/**
 * Snapshots of image objects (taken before the original is hidden) used to draw moved images on
 * screen. Object ids are only unique within a page, so the key includes the source page.
 */
export const imageSnapshots = new Map<string, string>()
export const snapshotKey = (sourceId: string, srcIndex: number, objectId: string) => `${sourceId}:${srcIndex}:${objectId}`

export function snapshotRegion(canvas: HTMLCanvasElement | null | undefined, pageWidth: number, b: Box): string | null {
  if (!canvas) return null
  try {
    const k = canvas.width / pageWidth
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(b.w * k))
    c.height = Math.max(1, Math.round(b.h * k))
    c.getContext('2d')!.drawImage(canvas, b.x * k, b.y * k, b.w * k, b.h * k, 0, 0, c.width, c.height)
    return c.toDataURL('image/png')
  } catch {
    return null
  }
}

/** Text that exists in the PDF (empty table cells are not text fields: use Add Text to put something there). */
export const isTextObject = (o: ContentObject) => (o.type === 'TEXT_BLOCK' || o.type === 'TABLE_CELL') && !!o.text?.trim()
export const isGraphicObject = (o: ContentObject) => o.type === 'LINE' || o.type === 'RECTANGLE' || o.type === 'IMAGE'

export const OBJECT_LABEL: Record<string, string> = {
  TEXT_BLOCK: 'Text block',
  TEXT_LINE: 'Text line',
  TEXT_SPAN: 'Text span',
  TABLE: 'Table',
  TABLE_ROW: 'Table row',
  TABLE_CELL: 'Table cell',
  LINE: 'Line',
  RECTANGLE: 'Rectangle',
  IMAGE: 'Image',
}

export function describeObject(o: ContentObject): string {
  if (o.type === 'TEXT_BLOCK') return o.role === 'heading' ? 'Heading' : o.role === 'list-item' ? 'List item' : o.role === 'header' ? 'Page header' : o.role === 'footer' ? 'Page footer' : 'Paragraph'
  if (o.type === 'TABLE') return `Table · ${o.rows}×${o.cols}`
  if (o.type === 'TABLE_CELL') return `Cell · row ${(o.row ?? 0) + 1}, column ${(o.col ?? 0) + 1}`
  return OBJECT_LABEL[o.type] ?? o.type
}
