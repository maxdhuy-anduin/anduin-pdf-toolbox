// Selectable things on a page and the group operations on them (move, delete, copy).
//
// An item is either a detected PDF object ("o:<objectId>", possibly already moved) or an
// overlay the user created ("v:<overlayId>": pasted block, edited / added text, edited graphic).
// Group operations treat the selection as one rigid unit: every member gets the same
// translation, and nothing is reflowed or re-typeset.

import { graphicOverlayFromObject, moveOverlayFor, sampleBox, sourceRef, textOverlayFromObject } from './content/edits'
import type { Box, ContentObject, PageContent } from './content/types'
import { isGraphic, isMove, isPaste, isText, pasteBounds, uid, type MoveOverlay, type Overlay, type OverlayPatch, type PageModel, type SourceRef, type TextOverlay } from './model'

export interface Item {
  key: string
  bounds: Box
  obj?: ContentObject
  move?: MoveOverlay
  overlay?: Overlay
}

const SELECTABLE = new Set(['TEXT_BLOCK', 'TABLE_CELL', 'TABLE', 'LINE', 'RECTANGLE', 'IMAGE'])
export const objKey = (id: string) => `o:${id}`
export const ovKey = (id: string) => `v:${id}`

/** Text-box heights are only known to the DOM; callers can measure them. */
export type Measure = (overlayId: string) => Box | null

/** Everything selectable on a page, in hit-testing order (smallest first). */
export function pageItems(content: PageContent | undefined, overlays: Overlay[], measure?: Measure): Item[] {
  const items: Item[] = []
  const moves = new Map<string, MoveOverlay>()
  const replaced = new Set<string>()
  for (const o of overlays) {
    if (isMove(o)) moves.set(o.source.objectId, o)
    else if (o.source) replaced.add(o.source.objectId)
  }
  if (content) {
    for (const id of content.hitOrder) {
      const obj = content.objects[id]
      if (!obj || !SELECTABLE.has(obj.type) || replaced.has(id)) continue
      const mv = moves.get(id)
      if (mv?.deleted) continue
      const b = obj.bounds
      items.push({ key: objKey(id), obj, move: mv, bounds: mv ? { ...b, x: b.x + mv.dx, y: b.y + mv.dy } : b })
    }
  }
  for (const o of overlays) {
    if (isPaste(o)) items.push({ key: ovKey(o.id), overlay: o, bounds: pasteBounds(o) })
    else if (isGraphic(o) && !o.deleted) items.push({ key: ovKey(o.id), overlay: o, bounds: { x: o.x, y: o.y, w: o.w, h: o.h } })
    else if (isText(o) && o.text.trim()) {
      const m = measure?.(o.id)
      items.push({ key: ovKey(o.id), overlay: o, bounds: m ?? { x: o.x, y: o.y, w: o.width, h: o.fontSize * (o.lineHeight ?? 1.2) * Math.max(1, o.text.split('\n').length) } })
    }
  }
  const area = (it: Item) => (it.obj?.type === 'LINE' ? 0 : it.obj?.type === 'TABLE_CELL' && !it.obj.text ? it.bounds.w * it.bounds.h * 4 : it.bounds.w * it.bounds.h)
  return items.sort((a, b) => area(a) - area(b))
}

const inBox = (b: Box, x: number, y: number, slop = 0) => x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop

/** Item under a point (view space). Tables are picked on their outline; their inside belongs to cells. */
export function hitItem(items: Item[], x: number, y: number, slop: number): Item | null {
  for (const it of items) {
    const b = it.bounds
    if (it.obj?.type === 'LINE') {
      if (inBox(b, x, y, slop)) return it
      continue
    }
    if (it.obj?.type === 'TABLE') {
      const near = inBox(b, x, y, slop) && (Math.abs(x - b.x) < slop || Math.abs(x - b.x - b.w) < slop || Math.abs(y - b.y) < slop || Math.abs(y - b.y - b.h) < slop)
      if (near) return it
      continue
    }
    if (inBox(b, x, y)) return it
  }
  return null
}

const intersects = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
const contains = (outer: Box, inner: Box, tol = 0.5) => inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol

/**
 * Marquee selection: items that intersect the rectangle. A table is selected only when the
 * rectangle encloses it completely (then its cells are not listed separately); otherwise the
 * cells it touches are.
 */
export function marqueeSelect(items: Item[], r: Box): string[] {
  const tables = items.filter((it) => it.obj?.type === 'TABLE' && contains(r, it.bounds))
  const tableIds = new Set(tables.map((t) => t.obj!.id))
  const out: string[] = []
  for (const it of items) {
    if (it.obj?.type === 'TABLE') {
      if (tableIds.has(it.obj.id)) out.push(it.key)
      continue
    }
    if (!intersects(r, it.bounds)) continue
    const row = it.obj?.type === 'TABLE_CELL' ? it.obj.parent : null
    if (row && tables.some((t) => t.obj!.children.includes(row))) continue
    out.push(it.key)
  }
  return out
}

/** Smallest box enclosing all items. */
export function groupBounds(items: Item[]): Box | null {
  if (!items.length) return null
  const x0 = Math.min(...items.map((i) => i.bounds.x))
  const y0 = Math.min(...items.map((i) => i.bounds.y))
  const x1 = Math.max(...items.map((i) => i.bounds.x + i.bounds.w))
  const y1 = Math.max(...items.map((i) => i.bounds.y + i.bounds.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Detected objects a selection really consists of: a table brings its cells and every rule,
 * rectangle or image drawn inside it, so it moves / deletes / copies as one unit.
 */
export function expandObjects(content: PageContent, ids: string[]): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    const o = content.objects[id]
    if (!o) continue
    out.add(id)
    if (o.type !== 'TABLE') continue
    for (const r of o.children) for (const c of content.objects[r]?.children ?? []) out.add(c)
    for (const g of Object.values(content.objects)) {
      if ((g.type === 'LINE' || g.type === 'RECTANGLE' || g.type === 'IMAGE') && contains(o.bounds, g.bounds, 2)) out.add(g.id)
    }
  }
  return [...out]
}

export interface OverlayEdits {
  add: Overlay[]
  update: { id: string; patch: OverlayPatch }[]
  remove: string[]
  /** Selection keys after the edit (legacy fallbacks get new overlay keys). */
  keys: string[]
}

const coverColorFor = (canvas: HTMLCanvasElement | null | undefined, content: PageContent, b: Box) =>
  sampleBox(canvas, content.width, { x: b.x - 2, y: b.y - 2, w: b.w + 4, h: b.h + 4 }).bg

function split(keys: string[]) {
  return { objIds: keys.filter((k) => k.startsWith('o:')).map((k) => k.slice(2)), ovIds: keys.filter((k) => k.startsWith('v:')).map((k) => k.slice(2)) }
}

/** Rigid translation of the selection by (dx, dy) view-space points. */
export function planMove(page: PageModel, content: PageContent | undefined, keys: string[], dx: number, dy: number, canvas?: HTMLCanvasElement | null): OverlayEdits {
  const res: OverlayEdits = { add: [], update: [], remove: [], keys: [...keys] }
  const { objIds, ovIds } = split(keys)
  const moves = new Map(page.overlays.filter(isMove).map((m) => [m.source.objectId, m]))
  if (content) {
    for (const id of expandObjects(content, objIds)) {
      const o = content.objects[id]
      const mv = moves.get(id)
      if (mv) {
        res.update.push({ id: mv.id, patch: { dx: mv.dx + dx, dy: mv.dy + dy } })
        continue
      }
      const ref = sourceRef(o)
      if (ref.exclusive) {
        res.add.push(moveOverlayFor(o, { dx, dy, coverColor: coverColorFor(canvas, content, o.bounds) }))
        continue
      }
      // operators shared with other content: fall back to a re-typeset / redrawn copy
      if (o.type === 'TEXT_BLOCK' || o.type === 'TABLE_CELL') {
        const t = textOverlayFromObject(o, content, canvas)
        t.x += dx
        t.y += dy
        res.add.push(t)
        res.keys = res.keys.map((k) => (k === objKey(id) ? ovKey(t.id) : k))
      } else if (o.type === 'LINE' || o.type === 'RECTANGLE' || o.type === 'IMAGE') {
        const g = graphicOverlayFromObject(o, content, canvas)
        g.x += dx
        g.y += dy
        res.add.push(g)
        res.keys = res.keys.map((k) => (k === objKey(id) ? ovKey(g.id) : k))
      }
    }
  }
  for (const id of ovIds) {
    const o = page.overlays.find((x) => x.id === id)
    if (!o) continue
    if (isPaste(o) || isMove(o)) res.update.push({ id, patch: { dx: o.dx + dx, dy: o.dy + dy } })
    else if (isText(o) || isGraphic(o)) res.update.push({ id, patch: { x: o.x + dx, y: o.y + dy } })
  }
  return res
}

/** Deletes the selection (non-destructively: originals are hidden / removed on export). */
export function planDelete(page: PageModel, content: PageContent | undefined, keys: string[], canvas?: HTMLCanvasElement | null): OverlayEdits {
  const res: OverlayEdits = { add: [], update: [], remove: [], keys: [] }
  const { objIds, ovIds } = split(keys)
  const moves = new Map(page.overlays.filter(isMove).map((m) => [m.source.objectId, m]))
  if (content) {
    for (const id of expandObjects(content, objIds)) {
      const o = content.objects[id]
      const mv = moves.get(id)
      if (mv) {
        res.update.push({ id: mv.id, patch: { deleted: true } })
        continue
      }
      if (sourceRef(o).exclusive) {
        res.add.push(moveOverlayFor(o, { deleted: true, coverColor: coverColorFor(canvas, content, o.bounds) }))
      } else if (o.type === 'TEXT_BLOCK' || o.type === 'TABLE_CELL') {
        const t = textOverlayFromObject(o, content, canvas)
        t.text = ''
        res.add.push(t)
      } else if (o.type === 'LINE' || o.type === 'RECTANGLE' || o.type === 'IMAGE') {
        const g = graphicOverlayFromObject(o, content, canvas)
        g.deleted = true
        res.add.push(g)
      }
    }
  }
  for (const id of ovIds) {
    const o = page.overlays.find((x) => x.id === id)
    if (!o) continue
    if (isGraphic(o)) res.update.push({ id, patch: { deleted: true } })
    else if (isText(o) && (o.cover || o.source)) res.update.push({ id, patch: { text: '' } })
    else res.remove.push(id)
  }
  return res
}

// ---------------------------------------------------------------------------------------------
// copy
// ---------------------------------------------------------------------------------------------

/** One source page's worth of copied PDF objects. */
export interface CopiedGroup {
  sourceId: string
  srcIndex: number
  items: SourceRef[]
  /** Where the items are drawn relative to the selection's top-left: drawn at item.bounds + shift + target. */
  shift: { x: number; y: number }
}

export interface CopiedSelection {
  /** Plain text of the selection (what other applications receive). */
  text: string
  /** Size of the selection's bounding box. */
  size: { w: number; h: number }
  /** Selection top-left on its page (view space). */
  origin: { x: number; y: number }
  groups: CopiedGroup[]
  /** Text boxes, positioned relative to the selection's top-left. */
  texts: TextOverlay[]
}

/** Captures the selection with positions normalized to its top-left corner. Synchronous (no PDF work). */
export function copySelection(page: PageModel, content: PageContent | undefined, items: Item[], keys: string[]): CopiedSelection | null {
  const sel = items.filter((it) => keys.includes(it.key))
  const box = groupBounds(sel)
  if (!box) return null
  const origin = { x: box.x, y: box.y }
  const groups = new Map<string, CopiedGroup>()
  const group = (sourceId: string, srcIndex: number, cx: number, cy: number) => {
    const k = `${sourceId}|${srcIndex}|${cx.toFixed(3)}|${cy.toFixed(3)}`
    let g = groups.get(k)
    if (!g) {
      g = { sourceId, srcIndex, items: [], shift: { x: cx - origin.x, y: cy - origin.y } }
      groups.set(k, g)
    }
    return g
  }
  const texts: TextOverlay[] = []
  const lines: string[] = []
  const { objIds, ovIds } = split(keys)
  const moves = new Map(page.overlays.filter(isMove).map((m) => [m.source.objectId, m]))
  if (content) {
    const seen = new Set<string>()
    for (const id of expandObjects(content, objIds)) {
      if (seen.has(id)) continue
      seen.add(id)
      const o = content.objects[id]
      const mv = moves.get(id)
      const ref = sourceRef(o)
      if (ref.exclusive) group(page.sourceId, page.srcIndex, mv?.dx ?? 0, mv?.dy ?? 0).items.push(ref)
      else if (o.type === 'TEXT_BLOCK' || o.type === 'TABLE_CELL') {
        const t = textOverlayFromObject(o, content, null)
        texts.push({ ...t, id: uid('tx'), x: t.x + (mv?.dx ?? 0) - origin.x, y: t.y + (mv?.dy ?? 0) - origin.y, cover: undefined, source: undefined })
      }
    }
    // reading order for the plain text
    for (const it of sel) if (it.obj?.text) lines.push(it.obj.text)
    for (const it of sel) {
      if (it.obj?.type !== 'TABLE') continue
      const rows = it.obj.cellIds ?? []
      lines.push(rows.map((r) => r.map((c) => content.objects[c]?.text ?? '').join('\t')).join('\n'))
    }
  }
  for (const id of ovIds) {
    const o = page.overlays.find((x) => x.id === id)
    if (!o) continue
    if (isPaste(o)) {
      const g = group(o.sourceId, o.srcIndex, o.dx, o.dy)
      g.items.push(...o.items)
    } else if (isText(o) && o.text.trim()) {
      texts.push({ ...o, id: uid('tx'), x: o.x - origin.x, y: o.y - origin.y, cover: undefined, source: undefined })
      lines.push(o.text)
    }
  }
  if (!groups.size && !texts.length) return null
  return { text: lines.join('\n'), size: { w: box.w, h: box.h }, origin, groups: [...groups.values()], texts }
}
